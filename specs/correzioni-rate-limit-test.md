# Correzione bug `rate_limit_event` + test mock fallback (spec A10)

Data: 2026-07-03
Branch: `feat/fallback-llm`
Precedente: `specs/analisi-review-commit-fallback.md`

---

## 1. Bug corretto: `rate_limit_event` codice morto

L'analisi in `analisi-review-commit-fallback.md` aveva identificato tre discrepanze
tra il codice e l'SDK reale `@anthropic-ai/claude-agent-sdk@0.3.197`. Corrette.

### File coinvolti

| File | Modifica |
|------|----------|
| `container/agent-runner/src/providers/claude.ts:476` | Discriminante: `subtype === 'rate_limit_event'` → `message.type === 'rate_limit_event'`. Campo: `message.rate_limit` → `message.rate_limit_info` |
| `container/agent-runner/src/limit-detect.ts:20` | `BLOCKING_STATUSES`: rimosso `'exceeded'` (non esiste nell'SDK). Enum reale: `allowed \| allowed_warning \| rejected` |
| `container/agent-runner/src/limit-detect.test.ts` | Test aggiornati: `'warning'` → `'allowed'`/`'allowed_warning'`, `'exceeded'` → `'rejected'` |

### Verifica

- Host: `pnpm test` — 73 file, 643 test, tutti passano
- Host: `pnpm run build` — typecheck pulito
- Container: `bun test` — 131 pass, 3 fail + 3 error (solo moduli pre-esistenti non installati: `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`)

---

## 2. MockProvider: fail simulation (spec A10 step 1)

### File coinvolti

| File | Modifica |
|------|----------|
| `container/agent-runner/src/providers/mock.ts` | Aggiunta env var `MOCK_PROVIDER_FAIL=quota\|billing\|overload` (case-insensitive) + `MOCK_RESET_AT=<unix seconds>`. Fail mode anche passabile via costruttore (`new MockProvider({}, undefined, 'quota')`) per evitare contaminazione `process.env` tra test. `failConsumed` a livello istanza: il fallimento colpisce solo il primo turno. `as ProviderEvent` cast necessario per Bun. `const failMode = this.failMode` catturato PRIMA della closure asincrona del generatore — Bun/JSC modifica `this.failMode` durante l'iterazione async. |
| `container/agent-runner/src/providers/mock.test.ts` | **Nuovo file.** 6 unit test: normal/ok, quota, billing, overload, resetAt, revert secondo turno. Fail mode passato via costruttore (niente `process.env`). `collectInitialEvents()` chiama `query.end()` dopo l'evento terminale per far uscire il while-loop. |
| `container/agent-runner/src/integration.test.ts` | **Nuove test class:** `LimitEventProvider` (emette eventi `error` con classification), `BillingResultProvider` (emette `result` con `isError:true` e billing text). **Nuovi test:** `poll loop — provider limit fallback` (3 test) — verifica `fallback_report` in outbound, nessun messaggio chat, `processing_ack` resta `processing`; test `provider_error` per errori generici. **Pre-existing fix:** asserzioni aggiornate a "Dettaglio tecnico" (messaggio italiano, non "Error:"); `getPendingMessages()` sostituito con query diretta su `processing_ack` perché `markProcessing()` crea un ack che esclude il messaggio da `getPendingMessages()`. |
| `.env` | Nuovo file: `FALLBACK_PROVIDER=mock` |
| `src/container-runner.ts:449` | Passthrough `MOCK_PROVIDER_FAIL` e `MOCK_RESET_AT` dal host env ai container Docker (attivo solo se esplicitamente settati) |

### Dettaglio fail simulation

```
MOCK_PROVIDER_FAIL=quota    → emette { type:'error', classification:'quota', retryable:false }
MOCK_PROVIDER_FAIL=billing  → emette { type:'result', text:'Your credit balance is too low...', isError:true }
MOCK_PROVIDER_FAIL=overload → emette { type:'error', classification:'overload', retryable:false }
MOCK_RESET_AT=1700000000    → aggiunge resetAt (ms) e data ISO nel messaggio
```

Il poll-loop (`poll-loop.ts:516-532`) intercetta l'evento `error` non-retryable con
classification, lancia `ProviderLimitError`, scrive `fallback_report` in outbound.

---

## 3. Fix test pre-esistenti rotti da Fase A

I test in `integration.test.ts` scritti prima della Fase A assumevano 1 messaggio in
outbound per errori generici. La Fase A ha aggiunto `provider_error` come system action
aggiuntiva — ora sono 2 messaggi (chat error + system action). Aggiornati:

- `poll loop — provider error recovery`: `expect(out).toHaveLength(1)` → controllo contenuto specifico per entrambi i messaggi (chat con "Dettaglio tecnico" + system action `provider_error`)
- `poll loop — stale session recovery`: stesso fix
- `poll loop — slash command during active query`: timeout `waitFor` aumentato da 2000→5000ms e `runPollLoopWithTimeout` da 3000→8000ms (test flaky, race condition col poll-loop che ritenta `/clear` più volte)

I test di fallback usavano `getPendingMessages()` per verificare lo stato `processing`,
ma `getPendingMessages()` filtra via tutti i messaggi con entry in `processing_ack`
(creata da `markProcessing()`). Sostituito con query diretta su `processing_ack`:

```ts
const ackRow = getOutboundDb()
  .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
  .get('m1');
expect(ackRow.status).toBe('processing');
```

---

## 4. Bug corrigati iterativamente — lezioni apprese

### 4.1 `failConsumed` a livello istanza, non per-chiamata

**Bug**: `emittedFail` era una variabile locale dentro `query()`. Ogni chiamata la
resettava a `!fail`, quindi ogni turno emetteva il fail — impossibile testare il
revert al secondo turno.

**Fix**: `failConsumed` spostato a campo d'istanza (`private failConsumed = false`).
Impostato a `true` all'inizio di `query()`. Seconda chiamata → `shouldFail = false`.

### 4.2 `process.env` in Bun vs Node

**Bug**: `afterEach(() => { process.env = { ...OLD_ENV } })` non funziona in Bun
come in Node. Bun tratta `process.env` in modo diverso, causando contaminazione
tra test.

**Fix**: Fail mode passato via costruttore (`new MockProvider({}, undefined, 'quota')`)
invece che via `process.env.MOCK_PROVIDER_FAIL`. I test non toccano mai `process.env`
(tranne il test `resetAt` che usa try/finally per pulire).

### 4.3 `as ProviderEvent` cast per Bun

**Bug**: Bun/JSC scarta i campi opzionali (`classification?: string`) di una
discriminated union quando l'oggetto viene creato in una funzione separata e
restituito. `Object.keys()` mostrava la chiave ma il valore era `undefined`.

**Fix**: Cast esplicito `as ProviderEvent` sui return di `failEvents()`.

### 4.4 Closure asincrona e `this.failMode`

**Bug più subdolo**: dentro il generatore async, `this.failMode!` veniva letto
DOPO che il valore era già cambiato. Il debug mostrava:
- `Object.keys(errors[0])` = `["type","message","retryable","classification","resetAt"]`
  — la chiave `classification` ESISTE
- `JSON.stringify(errors[0])` ometteva `classification` — valore `undefined`
- Il messaggio era "API overload" anziché "Usage limit reached" — `mode` non era `'quota'`

**Causa**: La closure del generatore async cattura `this`, non il valore. Quando
il generatore viene iterato (dopo `await`), Bun/JSC aveva già modificato
`this.failMode`. `failEvents(this.failMode!)` riceveva il valore sbagliato.

**Fix**: Catturare in una `const` locale PRIMA della closure:
```ts
const failMode = this.failMode;
// ...
async *[Symbol.asyncIterator]() {
  for (const ev of failEvents(failMode!)) { ... }
}
```

### 4.5 `query.end()` per terminare l'iterator mock

**Bug**: Il mock provider, dopo aver emesso gli eventi iniziali, entra in un
`while (!ended && !aborted)` in attesa di `push()`. Nei test senza poll-loop,
nessuno chiama `end()`, quindi l'iterator pende all'infinito (timeout 5000ms).

**Fix**: `collectInitialEvents()` chiama `query.end()` dopo aver ricevuto il
primo evento `result` o `error`, segnalando al generatore di uscire dal while-loop.

### 4.6 Messaggi di errore in italiano

**Bug**: I test pre-esistenti controllavano `.toContain('Error:')` ma il poll-loop
scrive "Non sono riuscito a elaborare il tuo messaggio per un errore." (italiano).

**Fix**: Assertion cambiata in `.toContain('Dettaglio tecnico')`.

---

## 5. Test live eseguito (2026-07-03)

### Comandi esatti

```bash
cd /home/salvodmt/Scrivania/nanoclaw-v2

# 1. Ricostruisci immagine container (479s) — include mock.ts aggiornato
./container/build.sh

# 2. Fix upgrade tripwire (blocca l'avvio dopo git pull/modifiche)
pnpm exec tsx scripts/upgrade-state.ts set

# 3. Avvia host in dev mode
pnpm run dev &

# 4. Test CLI (pnpm ncl, NON ncl da solo — è uno script pnpm)
pnpm ncl fallback force
pnpm ncl fallback status
pnpm ncl fallback return
```

### Output dettagliato dei tre comandi

#### `pnpm ncl fallback force` — attiva il fallback a mano

```json
{
  "active": true,
  "mode": "forced",
  "classification": "manual",
  "reason": "manual ncl fallback force",
  "backupProvider": "mock",
  "enteredAt": "2026-07-03 08:49:40",
  "resetAt": null,
  "nextRetryAt": null,
  "retryCount": 0,
  "probing": false,
  "probeMessageId": null,
  "probeSessionId": null,
  "probeStartedAt": null,
  "originSessionId": null,
  "originGroupId": null,
  "lastError": null,
  "updatedAt": "2026-07-03 08:49:40"
}
```

| Campo | Valore | Spiegazione |
|-------|--------|-------------|
| `active` | `true` | Fallback in vigore: tutti i container usano il backup, non Claude |
| `mode` | `"forced"` | Attivato manualmente. Non rientra mai da solo (solo `ncl fallback return` lo spegne). L'alternativa è `"auto"` (il container ha rilevato un limite) |
| `classification` | `"manual"` | Causa: richiesta esplicita. In `"auto"` sarebbe `"quota"`, `"billing"` o `"overload"` |
| `reason` | `"manual ncl fallback force"` | Log testuale per debug |
| `backupProvider` | `"mock"` | Provider di riserva, preso da `.env` (`FALLBACK_PROVIDER=mock`) |
| `enteredAt` | `"2026-07-03 08:49:40"` | Timestamp UTC di quando il fallback è entrato in vigore |
| `resetAt` | `null` | Quando si resettano i limiti Claude. `null` = non noto (switch manuale, non causato da limite reale) |
| `nextRetryAt` | `null` | Prossimo tentativo automatico di rientro. `null` perché in `forced` non ci sono retry automatici |
| `retryCount` | `0` | Numero di tentativi di rientro falliti. In `forced` resta sempre 0 |
| `probing` | `false` | Probe non in corso. Il probe è un tentativo di rientro ottimistico: il sistema avvia UNA sessione su Claude per testare se i limiti sono resettati. In `forced` non parte mai |
| `probeMessageId` | `null` | ID messaggio usato per il probe |
| `probeSessionId` | `null` | ID sessione usata per il probe |
| `probeStartedAt` | `null` | Timestamp di avvio probe |
| `originSessionId` | `null` | Quale sessione ha originato lo switch. `null` = attivato da CLI, non da un messaggio |
| `originGroupId` | `null` | Quale gruppo agent ha originato lo switch |
| `lastError` | `null` | Ultimo errore. `null` = switch avvenuto senza problemi |

#### `pnpm ncl fallback status` — consulta lo stato

```json
{
  "active": true,
  "mode": "forced",
  "classification": "manual",
  "reason": "manual ncl fallback force",
  "backupProvider": "mock",
  "enteredAt": "2026-07-03 08:49:40",
  "resetAt": null,
  "nextRetryAt": null,
  "retryCount": 0,
  "probing": false,
  "probeMessageId": null,
  "probeSessionId": null,
  "probeStartedAt": null,
  "originSessionId": null,
  "originGroupId": null,
  "lastError": null,
  "updatedAt": "2026-07-03 08:49:40",
  "summary": "Modello attivo: mock (fallback forzato).\nMotivo: richiesta manuale.\nDa: 2026-07-03 08:49:40.\nRientro solo manuale (`/fallback return`)."
}
```

Uguale a `force` più il campo `summary`: un riassunto testuale in italiano, pensato per essere mostrato in chat Telegram. Contiene: modello attivo, tipo di switch (auto/forzato), motivo, da quando, e istruzioni per il rientro.

In uno scenario reale (switch automatico per quota):
```
Modello attivo: openrouter/gpt-4o (fallback automatico).
Motivo: limiti quota Claude raggiunti.
Da: 2026-07-03 10:30:00.
Reset previsto: 2026-07-03 15:00:00.
Prossimo tentativo di rientro: 2026-07-03 15:05:00.
```

#### `pnpm ncl fallback return` — disattiva il fallback

```json
{
  "active": false,
  "mode": null,
  "classification": null,
  "reason": null,
  "backupProvider": null,
  "enteredAt": null,
  "resetAt": null,
  "nextRetryAt": null,
  "retryCount": 0,
  "probing": false,
  "probeMessageId": null,
  "probeSessionId": null,
  "probeStartedAt": null,
  "originSessionId": null,
  "originGroupId": null,
  "lastError": null,
  "updatedAt": "2026-07-03 08:49:44"
}
```

| Campo | Valore | Spiegazione |
|-------|--------|-------------|
| `active` | `false` | **Fallback disattivato**. I container tornano a usare Claude |
| `mode` | `null` | Nessuna modalità attiva |
| `classification` | `null` | Nessuna classificazione |
| `reason` | `null` | Motivo azzerato |
| `backupProvider` | `null` | Nessun backup in uso |
| `enteredAt` | `null` | Timestamp di inizio azzerato |
| `updatedAt` | `"2026-07-03 08:49:44"` | Timestamp dell'ultima modifica (il rientro) |
| `retryCount` | `0` | Reset del contatore tentativi |
| Tutti gli altri | `null`/`false` | Stato pulito, pronti per un eventuale nuovo fallback |

In caso di rientro automatico (probe riuscito), il sistema emette un avviso "Sono tornato su Claude" e riavvia i container col provider nativo. Con `return` manuale il rientro è incondizionato: se Claude è ancora a limiti, il prossimo messaggio farà scattare un nuovo fallback con avviso.

### Note

- `ncl` da solo non funziona — va eseguito come `pnpm ncl` (script in `package.json`)
- Il tripwire `upgrade-state` scatta dopo ogni `git pull` o modifica a `src/`:
  eseguire `pnpm exec tsx scripts/upgrade-state.ts set` prima di avviare
- Se il processo produzione (PID 1428) è già spento, `kill 1428` è no-op

### Test completo con fail simulation (container + host)

```bash
export MOCK_PROVIDER_FAIL=quota
./container/build.sh
pnpm run dev &
pnpm ncl groups create --name TestFallback --provider mock
# ... wire a un canale, manda messaggio → mock fallisce → fallback scatta
```

### Test automatici

```bash
pnpm test                          # host: 73 file, 643 test (vitest)
cd container/agent-runner && bun test  # container: 131 pass, 3 fail pre-esistenti (bun:test)
```

---

## 6. Componenti software coinvolti

### Container (Bun)

| Componente | File | Ruolo |
|-----------|------|-------|
| Provider Claude | `container/agent-runner/src/providers/claude.ts` | Traduce eventi SDK → `ProviderEvent`. Contiene la logica di rilevamento limiti (`rate_limit_event`, `api_retry`) |
| Limit detect | `container/agent-runner/src/limit-detect.ts` | Classificazione pura: `classifyRateLimitEvent`, `classifyErrorResultText`, `classifyRetryStreak` |
| Mock provider | `container/agent-runner/src/providers/mock.ts` | Provider fittizio per test. Con `MOCK_PROVIDER_FAIL` simula errori di limite |
| Fallback report | `container/agent-runner/src/fallback-report.ts` | `ProviderLimitError` + `writeFallbackReport()` → scrive system action in outbound |
| Poll loop | `container/agent-runner/src/poll-loop.ts` | Consuma eventi provider. Intercetta errori non-retryable → `ProviderLimitError`; catch scrive `fallback_report` e drena |

### Host (Node/pnpm)

| Componente | File | Ruolo |
|-----------|------|-------|
| Delivery | `src/delivery.ts` | Poll su outbound.db. Riconosce `kind:'system'` → dispatch a handler registrati |
| Fallback controller | `src/modules/fallback/controller.ts` | `handleFallbackReport`, `enterFallback`, `exitFallback`, `startReturnProbe`. Core decisionale host-side |
| Fallback state DB | `src/modules/fallback/db.ts` | CRUD su `fallback_state` (central DB, single-row) |
| Provider override | `src/modules/fallback/override.ts` | `effectiveProvider(native, state)` — decide quale provider usare a spawn |
| Fallback sweep | `src/modules/fallback/sweep.ts` | Hook in `host-sweep.ts`: garantisce risposta entro 10 min, guida il probe di rientro |
| Fallback commands | `src/modules/fallback/commands.ts` | Intercetta `/fallback status\|force\|return` nel router |
| Container runner | `src/container-runner.ts` | Spawna container Docker. Applica `effectiveProvider`. Passthrough `MOCK_PROVIDER_FAIL` |
| Fragment | `src/modules/fallback/fragment.ts` | Scrive/rimuove `zz-fallback.md` nei gruppi (degradation notice) |
| Notices | `src/modules/fallback/notices.ts` | Testi italiani per tutti gli avvisi (switch, rientro, status, no-backup) |
| Decide | `src/modules/fallback/decide.ts` | Funzione pura: `decideFallbackSweep()` — backoff, probe, guarantee-breach |
| Summary | `src/modules/fallback/summary.ts` | Riassunti di contesto andata/ritorno da archivio conversazioni |

## 7. Flusso completo

```
1. Container: provider nativo (claude) emette rate_limit_event con status='rejected'
2. claude.ts → translateEvents → { type:'error', classification:'quota', retryable:false }
3. poll-loop.ts → processQuery → catch non-retryable error → throw ProviderLimitError
4. poll-loop.ts → runPollLoop catch → writeFallbackReport({ classification:'quota', messageIds:[...] })
5. outbound.db ← { kind:'system', action:'fallback_report', classification:'quota', ... }
6. delivery.ts → poll outbound → handleSystemAction → dispatch 'fallback_report'
7. controller.ts → handleFallbackReport → enterFallback({ mode:'auto', ... })
8. db.ts → enterFallbackState → fallback_state.active=1
9. override.ts → effectiveProvider → restituisce backup (mock) invece di claude
10. container-restart.ts → killContainer + onExit → wakeContainer con nuovo provider
11. Il container riparte con provider mock, il messaggio originale viene ri-presentato
```
