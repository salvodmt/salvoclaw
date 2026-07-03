# Review: Fallback automatico a un LLM di riserva

**Spec:** specs/fallback-llm.md
**Branch:** feat/fallback-llm
**Base:** main
**Data:** 2026-07-03
**Findings totali:** 18 (Critical: 1, High: 4, Medium: 7, Low: 6)
**Fix applicati post-review:** vedi sezione "Fix applicati"

## Sommario esecutivo

18 findings (1 Critical, 4 High, 7 Medium, 6 Low). Il finding Critical (migration021 eseguita PRIMA di moduleFallbackState) impedisce l'avvio su installazioni pulite — bloccante, non mergeable così com'è. Due High colpiscono la garanzia di risposta entro 10 minuti e il leak del probe message in chat. Il resto sono omissioni e edge case gestibili. La feature è sostanzialmente corretta nella struttura ma ha bisogno di fix pre-merge sulle migrazioni, sul timestamp dei messaggi re-presentati, e sulla pulizia del probe message.

## Findings

### Critical

#### F-01 | Bug | migration021 ALTER TABLE eseguita prima di CREATE TABLE — crash su fresh install

**File:** `src/db/migrations/index.ts:57-60`
**Descrizione:** Il barrel array delle migrazioni inserisce `migration021` (ALTER TABLE fallback_state ADD COLUMN backup_model TEXT) **prima** di `moduleFallbackState` (CREATE TABLE fallback_state). Il migration runner esegue in ordine di array e deduplica per nome, non per version. Su un DB vergine, migration021 prova a fare ALTER TABLE su una tabella inesistente e crasha, bloccando l'avvio dell'host.
**Evidenza:**
```ts
// src/db/migrations/index.ts:57-60
  migration019,
  migration020,
  migration021,          // ALTER TABLE fallback_state — DIPENDE dalla tabella
  moduleFallbackState,   // CREATE TABLE fallback_state — CREA la tabella
```
**Impatto:** Ogni installazione pulita (fresh install) crasha all'avvio. La tabella `fallback_state` non viene mai creata, e ogni chiamata a `getFallbackState()` lancia errore. L'intero sistema è inutilizzabile su installazioni nuove.
**Suggerimento:** Invertire l'ordine: mettere `moduleFallbackState` prima di `migration021`, o incorporare `backup_model` direttamente nella CREATE TABLE di moduleFallbackState.

### High

#### F-02 | Business | Garanzia 10 minuti usa timestamp originale dopo il re-present — double-fault prematuro

**File:** `src/modules/fallback/sweep.ts:62-72`
**Regola violata:** "Ogni messaggio che attiva l'assistente produce sempre, entro 10 minuti, una di queste due cose: la risposta (da Claude o dal modello di riserva) oppure l'avviso di limiti esauriti. [...] La garanzia copre anche il riavvio a metà elaborazione: i messaggi rimasti in sospeso seguono la stessa regola."
**Descrizione:** `representMessages` (controller.ts:86-93) reimposta lo status a `'pending'` ma **non aggiorna** il campo `timestamp`. `overdueTriggerMessages` (sweep.ts:36-43) calcola `ageMs` dal timestamp originale di inserimento. Se il messaggio originale ha già più di 10 minuti quando il fallback si attiva, al tick sweep successivo il double-fault scatta immediatamente — il modello di riserva ha al massimo ~60s per rispondere prima di essere interrotto.
**Evidenza:**
```ts
// sweep.ts:36-43
return rows.map((r) => ({ id: r.id, ageMs: nowMs - parseSqliteUtc(r.timestamp) }))
// ...
// sweep.ts:62-72 — double fault con soglia basata su timestamp originale
if (state.active) {
  const threshold = Math.max(RESPONSE_GUARANTEE_MS, declaredBashMs(outDb) + 60_000);
  const breached = overdue.filter((m) => m.ageMs > threshold).map((m) => m.id);
  if (breached.length === 0) return;
  killContainer(session.id, 'fallback-double-fault');
  handleDoubleFaultTimeout(session, inDb, breached);
}

// controller.ts:86-93 — representMessages non aggiorna timestamp
const stmt = inDb.prepare("UPDATE messages_in SET status = 'pending' WHERE id = ? AND status = 'processing'");
```
**Impatto:** Messaggio inviato, Claude bloccato in retry per 12 minuti → fallback si attiva → i messaggi vengono re-presentati ma timestamp è ancora T0=12 minuti fa → double-fault scatta entro ~60s. Il modello di riserva non ha mai una reale possibilità di rispondere. Scenario riproducibile con 6+ retry di Claude in 5+ minuti di overload.
**Suggerimento:** In `representMessages`, aggiornare il `timestamp` a `datetime('now')` o aggiungere un campo `re_presented_at`.

#### F-03 | Bug | handleProviderError non marca come completed il probe message durante probing — leak verso l'utente

**File:** `src/modules/fallback/controller.ts:478-482`
**Descrizione:** Quando arriva un provider_error mentre `state.probing === true`, la funzione chiama `bumpRetry` e `killAndWake` ma **non** chiama `markMessageCompleted` per il probe message. Il messaggio resta pending con `onWake:1`. Al riavvio del container, viene processato come normale messaggio chat, mostrando all'utente il briefing interno del probe ("Riprovo a rispondere io, Claude...").
**Evidenza:**
```ts
// controller.ts:478-482
if (state.probing) {
  log.warn('Return probe failed with a generic error — silent re-fallback', ...);
  bumpRetry(nextRetryIso(state.retryCount));
  killAndWake(session, 'fallback-reprobe-generic-error');
  return;
  // Nessuna markMessageCompleted — il probe message rimane nel DB
}
```
**Impatto:** L'utente vede un messaggio in chat contenente il briefing interno del probe, violando la regola 10 della spec ("Un tentativo di rientro fallito non genera avvisi").
**Suggerimento:** Aggiungere `markMessageCompleted` per il probe message prima di `killAndWake`, coerentemente con `handleProbeTimeout`.

#### F-04 | Bug | applyProviderOverride crasha a ogni container spawn se fallback_state non esiste

**File:** `src/modules/fallback/index.ts:15-17`
**Descrizione:** La callback `registerGlobalProviderOverride` valuta `getFallbackState()` dinamicamente a ogni chiamata di `applyProviderOverride`. Se la tabella `fallback_state` non esiste (migrazione fallita, DB corrotto), `getFallbackState()` lancia eccezione. L'errore si propaga in `materializeContainerJson` e `resolveProviderName`, **bloccando lo spawn di QUALSIASI container**, non solo quelli del fallback.
**Evidenza:**
```ts
// src/modules/fallback/index.ts:17
registerGlobalProviderOverride((native) => effectiveProvider(native, getFallbackState()));

// src/provider-override.ts:23-24
export function applyProviderOverride(native: string): string {
  return overrideFn ? overrideFn(native) : native;
}
```
**Impatto:** Un bug nel modulo fallback rende l'intera installazione incapace di spawnare container. Nessun agente risponde a nessun messaggio. Danno totale anziché confinato al modulo.
**Suggerimento:** Wrappare in try/catch dentro la callback, restituendo `native` in caso di errore.

#### F-05 | Bug | handleFallbackReport usa l'inbound DB sbagliato per il probe message in probing mode

**File:** `src/modules/fallback/controller.ts:430-443`
**Descrizione:** Durante un probe attivo, `effectiveProvider` restituisce il provider nativo per tutte le sessioni. Se una sessione diversa da quella di probe colpisce un limite e genera un fallback report, il ramo `if (state.probing)` usa `inDb` (l'inbound DB della sessione chiamante, non della probe session) per chiamare `markMessageCompleted`. Il probeMessageId non esiste in questo DB, quindi la pulizia fallisce silenziosamente.
**Evidenza:**
```ts
if (state.probing) {
  const rest = messageIds.filter((id) => id !== state.probeMessageId);
  if (state.probeMessageId && messageIds.includes(state.probeMessageId)) {
    markMessageCompleted(inDb, state.probeMessageId); // inDb è della sessione chiamante
  }
  bumpRetry(nextRetryIso(state.retryCount));
  killAndWake(session, 'fallback-reprobe-limit');
}
```
**Impatto:** La riga del probe message nell'origin session inbound DB resta `'processing'` a tempo indeterminato. Lo sweep host la resetterà con backoff, consumando fino a MAX_TRIES. La sessione origin potrebbe riprocessare il probe briefing come messaggio normale.
**Suggerimento:** Aprire l'inbound DB di `state.probeSessionId` o saltare `markMessageCompleted` se `session.id !== state.probeSessionId`.

### Medium

#### F-06 | Business + Security | Dichiarazione degradazione copre solo l'identità, non le capacità indisponibili

**File:** `src/modules/fallback/notices.ts:72-80`, `src/modules/fallback/fragment.ts:18-23`
**Regola violata:** "È accettato che il modello di riserva abbia capacità inferiori a Claude (strumenti o skill non disponibili, minore abilità nell'uso degli strumenti). In tal caso l'assistente deve dichiarare apertamente cosa non riesce a fare, mai fingere di averlo fatto."
**Descrizione:** Il briefing e il fragment istruiscono il modello solo a dichiarare l'identità ("Modello attuale: X via Y"). Il briefing ordina esplicitamente "Non aggiungere presentazioni, non dire chi sei, non aggiungere altro", impedendo al modello di segnalare capacità mancanti.
**Evidenza:**
```ts
// notices.ts:72-80
const base = [
  `Non aggiungere presentazioni, non dire chi sei, non aggiungere altro. Solo il modello.`,
].join(' ');
// fragment.ts:18-23
return `## Modalità di riserva\n\nQuando ti chiedono che modello sei, rispondi solo: "Modello attuale: ${modelName} via ${provider}." Non aggiungere altro.`;
```
**Impatto:** Se il modello di riserva non ha accesso a un tool MCP e l'utente chiede di usarlo, il modello non dichiarerà spontaneamente il limite, violando il contratto di trasparenza.
**Suggerimento:** Aggiungere al briefing/fragment: "Se ti viene chiesto di fare qualcosa che non puoi fare, dichiaralo apertamente."

#### F-07 | Bug | decideFallbackSweep preferisce resetAt su nextRetryAt anche dopo backoff

**File:** `src/modules/fallback/decide.ts:79-82`
**Descrizione:** `const dueAtStr = state.resetAt ?? state.nextRetryAt` usa sempre `resetAt` se disponibile, ignorando `nextRetryAt`. Dopo un probe fallito (`bumpRetry` imposta `nextRetryAt`), se `resetAt` è noto ma già passato, il codice riprova immediatamente invece di rispettare il backoff crescente.
**Evidenza:**
```ts
const dueAtStr = state.resetAt ?? state.nextRetryAt;
const dueAt = dueAtStr ? Date.parse(dueAtStr) : NaN;
if (!Number.isNaN(dueAt) && nowMs >= dueAt) {
  return { type: 'start-probe' };
}
```
**Impatto:** Dopo un probe fallito, riprova a ogni sweep tick (60s) anziché rispettare il backoff programmato.
**Suggerimento:** Usare `state.nextRetryAt ?? state.resetAt` o prendere il massimo tra i due timestamp.

#### F-08 | Bug | decideFallbackSweep tratta probeRowStatus 'failed' come 'pending'

**File:** `src/modules/fallback/decide.ts:68-78`
**Descrizione:** Solo `probeRowStatus === 'completed'` produce `probe-success`. Lo stato `'failed'` viene trattato come `'pending'` — il sistema attende passivamente i 10 minuti di timeout.
**Evidenza:**
```ts
if (state.probing) {
  if (probeRowStatus === 'completed') return { type: 'probe-success' };
  // 'failed' non è mai gestito — cade nel timeout
  const startedAt = ...
  if (!Number.isNaN(startedAt) && nowMs - startedAt > 10 * 60_000) {
    return { type: 'probe-timeout' };
  }
}
```
**Impatto:** Fino a 10 minuti di attesa passiva prima di riconoscere un probe fallito.
**Suggerimento:** Aggiungere `if (probeRowStatus === 'failed') return { type: 'probe-timeout' }`.

#### F-09 | Security | OpenRouter API key salvata in chiaro in .env quando OneCLI non disponibile

**File:** `setup/fallback.ts:322-332`
**Descrizione:** `fallbackPlaintextSave` scrive `OPENROUTER_API_KEY` in chiaro in `.env`. La chiave non viene mai letta dal container (il provider opencode usa `apiKey: 'placeholder'` e passa via proxy OneCLI). Quindi la chiave è sia esposta su disco sia **inutilizzata** — il fallback degraded path non funziona realmente.
**Evidenza:**
```ts
function fallbackPlaintextSave(apiKey: string, chosenModel: string): void {
  writeEnvLine('OPENROUTER_API_KEY', apiKey);  // chiave in chiaro su disco, mai letta dal container
}
```
**Impatto:** Un attaccante con accesso in lettura al filesystem recupera la chiave. Il fallback non funziona perché il container non la legge.
**Suggerimento:** Non scrivere la chiave su `.env`. Passarla via `containerConfig.env` e farla leggere dal provider opencode quando il proxy OneCLI è assente.

#### F-10 | Security | Autorizzazione comandi /fallback fail-open se user_roles non esiste

**File:** `src/modules/fallback/commands.ts:37-49`
**Descrizione:** `isOwnerOrAdmin` restituisce `true` se la tabella `user_roles` non esiste. Fail-open: l'assenza di un modulo di sicurezza concede accesso invece di negarlo.
**Evidenza:**
```ts
if (!hasTable(db, 'user_roles')) return true; // no permissions module = allow all
```
**Impatto:** Se la migrazione permissions non è eseguita, qualsiasi utente può eseguire `/fallback force`, switchando l'intera installazione.
**Suggerimento:** Invertire in fail-closed: restituire `false` se la tabella non esiste.

#### F-11 | Bug | getFallbackState non gestisce riga assente nel DB — crash su undefined

**File:** `src/modules/fallback/db.ts:80-82`
**Descrizione:** `getFallbackState()` chiama `.get()` che restituisce `undefined` se la riga `id=1` non esiste, e lo passa a `rowToState()` senza null-check.
**Evidenza:**
```ts
export function getFallbackState(): FallbackState {
  const row = getDb().prepare('SELECT * FROM fallback_state WHERE id = 1').get() as FallbackStateRow;
  return rowToState(row);  // row può essere undefined
}
```
**Impatto:** Se la seed row viene persa (corruzione DB, DELETE), ogni operazione che legge lo stato crasha. Combinato con F-04, blocca l'intero sistema.
**Suggerimento:** Aggiungere `if (!row) throw new Error(...)` o ricreare automaticamente la seed row.

#### F-12 | Bug | interceptFallbackCommand crasha se il campo text nel JSON non è una stringa

**File:** `src/modules/fallback/commands.ts:69-71`
**Descrizione:** `text = ((JSON.parse(rawContent) as { text?: string }).text || '').trim()` assume che `.text` sia string. Se `text` è `42`, `true`, o un oggetto, `(42 || '')` produce un number, e `.trim()` lancia TypeError.
**Evidenza:**
```ts
text = ((JSON.parse(rawContent) as { text?: string }).text || '').trim();
```
**Impatto:** Messaggio malformato da un adapter fa crashare l'interceptor. L'utente non riceve risposta.
**Suggerimento:** Aggiungere `typeof parsed.text === 'string' ? parsed.text.trim() : ''`.

### Low

#### F-13 | Business | Tentativi di rientro registrati solo come contatore cumulativo, non come eventi singoli

**File:** `src/modules/fallback/db.ts:178-192`
**Regola violata:** "ogni switch (automatico o manuale), ogni tentativo di rientro, ogni turno interrotto per timeout e ogni fallimento vengono registrati con motivo e orario, per diagnosi a posteriori."
**Descrizione:** `bumpRetry` incrementa solo `retry_count` e sovrascrive `next_retry_at`. Nessuna registrazione strutturata per ogni singolo tentativo con il proprio timestamp e motivo.
**Impatto:** Dopo 5 tentativi falliti, l'operatore vede solo `retry_count: 5` — impossibile capire quando e perché ogni tentativo è fallito.
**Suggerimento:** Aggiungere tabella `fallback_events` con `timestamp`, `event_type`, `reason`, `details`.

#### F-14 | Business | I gruppi non-origin non ricevono il riassunto delle conversazioni in fallback al rientro

**File:** `src/modules/fallback/controller.ts:324-331`
**Regola violata:** "Al primo turno dopo il rientro, Claude riceve un riassunto degli scambi avvenuti durante il periodo di fallback."
**Descrizione:** `exitFallback` riavvia i gruppi non-origin con `shortReturnBriefing()` ("Sono di nuovo Claude"), senza riassunto. Solo il gruppo originario genera il summary via `startReturnProbe`.
**Impatto:** In un'installazione con 3 gruppi, se uno secondario ha ricevuto messaggi durante il fallback, al rientro Claude non ne ha memoria.
**Suggerimento:** Chiamare `summarizeBackupConversation` per ogni gruppo in `exitFallback`.

#### F-15 | Bug | ollamaModelEnv restituisce '' invece di null — model stringa vuota

**File:** `src/modules/fallback/controller.ts:55-57`
**Descrizione:** `ollamaModelEnv()` restituisce `process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL || ''`. Quando nessuno è configurato, restituisce `''` invece di `null`.
**Impatto:** Model appare come stringa vuota in notice e fragment.
**Suggerimento:** Restituire `null` invece di `''`.

#### F-16 | Security | Messaggi di errore del provider esposti integralmente all'utente

**File:** `container/agent-runner/src/poll-loop.ts:294-304`
**Descrizione:** Il catch per errori generici include il messaggio completo dell'errore (`errMsg`) nel testo visibile in chat: `Dettaglio tecnico: ${errMsg}`. Errori da provider esterni (OpenRouter, Ollama) possono contenere URL con token, path interni, stack trace.
**Impatto:** Un errore OpenRouter contenente URL con API key verrebbe mostrato in chiaro in chat.
**Suggerimento:** Troncare `errMsg` a lunghezza massima e/o filtrare pattern di leak noti.

#### F-17 | Security | MOCK_PROVIDER_FAIL / MOCK_RESET_AT propagate incondizionatamente in produzione

**File:** `src/container-runner.ts:451-453`
**Descrizione:** Le variabili di test `MOCK_PROVIDER_FAIL` e `MOCK_RESET_AT` sono passate a tutti i container senza gate `NODE_ENV`.
**Impatto:** Se finiscono accidentalmente nell'environment di produzione, il mock provider si attiva al posto del provider reale.
**Suggerimento:** Aggiungere gate `if (process.env.NODE_ENV !== 'production')`.

#### F-18 | Bug | OpenCode idle timeout: Number('0') || 300000 ignora il valore 0

**File:** `container/agent-runner/src/providers/opencode.ts:250`
**Descrizione:** `Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000` — se la variabile è `'0'`, `Number('0')` fa 0 che è falsy, e viene usato il default 300000.
**Impatto:** Impostare 0 per disabilitare il timeout viene silenziosamente ignorato.
**Suggerimento:** Usare `?? 300_000` (nullish coalescing).

## Note sul diff analizzato

- **Branch:** feat/fallback-llm
- **Base:** main
- **File modificati totali:** 67
- **File inclusi nell'analisi business-vs-spec:** tutti i file in `src/modules/fallback/`, `src/db/`, `src/container-runner.ts`, `src/router.ts`, `src/host-sweep.ts`, `src/provider-override.ts`, `src/providers/`, `container/agent-runner/src/`, `setup/`
- **File esclusi dall'analisi business (ma inclusi in bug/security):** `specs/` (documentazione), `package.json`, `bun.lock`, `cli-tools.json`, `.gitignore`

### Ambiguità della spec segnalate

1. **Regola 7 — "dal primo messaggio successivo a quell'orario si riprova Claude".** Il codice usa lo sweep temporizzato (ogni 60s) con un probe sintetico senza attendere un messaggio utente reale. Da chiarire se il comportamento desiderato è proattivo (sweep-driven) o reattivo (user-driven).

2. **Regola 5 — riassunto "dal modello di riserva stesso".** Il riassunto di andata (`summarizeClaudeTranscript`) funziona solo se il transcript `.jsonl` esiste. Se il file manca, il riassunto non viene generato. La spec menziona "in subordine, dal modello di riserva stesso" come fallback, ma questa via non è implementata.

3. **Regola 14 — vincolo OpenCode+OpenRouter.** La spec vincola il fallback a OpenCode+OpenRouter, ma l'implementazione supporta anche Ollama. Il wizard di setup offre entrambe le opzioni. Estensione legittima, ma la spec andrebbe aggiornata.

### Design review

La feature non ha interfaccia grafica — gli avvisi sono normali messaggi in chat. Nessun riferimento di design fornito — la review di design non è applicabile.

## Fix applicati post-review (2026-07-03)

### F-07 — RISOLTO (false finding)

Il codice in `decide.ts:71` già usa `state.nextRetryAt ?? state.resetAt`, preferendo correttamente
`nextRetryAt` su `resetAt`. Il finding era errato: la risoluzione era già corretta.

### `nextRetryAt` inizializzato all'ingresso in fallback

Il piano (`piano-fallback-llm.md:91`) specificava `nextRetryAt = resetAt ?? now + primo backoff`
in modalità auto. L'implementazione iniziale in `db.ts:112` lo impostava sempre a NULL.
**Fix:** `controller.ts` calcola `initialNextRetry` prima di chiamare `enterFallbackState`:
- `forced` → `null` (il rientro è solo manuale)
- `auto` con `resetAt` fornito → `resetAt` (usa il timestamp del provider)
- `auto` senza `resetAt` → `nextRetryAt(0, Date.now())` (primo backoff a 5 minuti)

File: `controller.ts:236-237`, `db.ts:95` (nuovo campo `nextRetryAt` in `EnterFallbackParams`).

### On-wake briefing soppresso nel rientro manuale

Dopo `/fallback return`, i container venivano riavviati con un on-wake briefing che causava
una chiamata API Claude immediata, potenzialmente facendo scattare un nuovo fallback prima
che l'utente avesse inviato un messaggio. **Fix:** nel percorso `via === 'manual'` di
`exitFallback`, il briefing viene omesso; i container si risvegliano al primo messaggio reale.

File: `controller.ts:336`.
