# Review: Fallback nativo con provider preinstallati e onboarding integrato

**Spec:** specs/fallback-nativo.md
**Branch:** feat/fallback-llm
**Base:** main
**Data:** 2026-07-03
**Findings totali:** 11 (Critical: 0, High: 2, Medium: 2, Low: 7)

## Sommario esecutivo

11 findings (0 Critical, 2 High, 2 Medium, 7 Low). I due High riguardano: (1) il fallback degraded path OneCLI che scrive la chiave in chiaro in `.env` ma il container non la legge mai — il fallback non funziona in quel percorso; (2) il wizard chiamato senza try/catch in setup/auto.ts che blocca l'intero setup. Nessun finding Critical, ma la chiave API in chiaro e il container spawn blocker sono problemi reali da fixare prima del merge.

## Findings

### High

#### F-01 | Security + Bug | OpenRouter API key salvata in chiaro su .env e mai letta dal container

**File:** `setup/fallback.ts:322-332`
**Descrizione:** `fallbackPlaintextSave` scrive `OPENROUTER_API_KEY` in chiaro in `.env`. Il provider opencode lato container usa `apiKey: 'placeholder'` e si aspetta il proxy OneCLI — **non legge mai** `OPENROUTER_API_KEY` da env. Risultato: la chiave è esposta su disco (violando la spec regola 9 "Nessuna chiave rimane in chiaro su disco") E il fallback non funziona comunque.
**Evidenza:**
```ts
// setup/fallback.ts:329
writeEnvLine('OPENROUTER_API_KEY', apiKey);

// container/agent-runner/src/providers/opencode.ts
// Il provider non legge mai process.env.OPENROUTER_API_KEY — usa sempre il proxy OneCLI
```
**Impatto:** Un attaccante con accesso in lettura al filesystem recupera la chiave API OpenRouter. Il fallback non funziona perché il container non la usa. Doppio danno: sicurezza violata e funzionalità rotta.
**Suggerimento:** Passare `OPENROUTER_API_KEY` via `containerConfig.env` e fare in modo che il provider opencode la legga quando il proxy OneCLI è assente.

#### F-02 | Business | Nessun tentativo di risoluzione automatica OneCLI al salvataggio chiave

**File:** `setup/fallback.ts:292-307`
**Regola violata:** "Se OneCLI non è installato o non risponde durante il salvataggio della chiave, il sistema tenta di risolvere il problema automaticamente (es. installando o riavviando OneCLI)."
**Descrizione:** `onecliAvailable()` si limita a verificare se `onecli` è sul PATH. Se non lo è, il codice salta direttamente a `fallbackPlaintextSave` senza alcun tentativo di installare o riavviare OneCLI. Lo step OneCLI di `auto.ts` ha già la logica di installazione — il wizard di fallback dovrebbe chiamarlo prima di arrendersi.
**Evidenza:**
```ts
if (onecliAvailable()) {
  // ...salva nel vault...
} else {
  p.log.warn(k.yellow('OneCLI not available. Key will be saved in plaintext.'));
  fallbackPlaintextSave(apiKey, chosenModel);
  return;
}
```
**Impatto:** Invece di tentare un fix automatico, la chiave finisce in chiaro su disco. Il problema è evitabile dato che il setup OneCLI è già implementato in `auto.ts`.
**Suggerimento:** Chiamare `ensureOnecli` o `spawnSync('bash', ['setup/onecli.sh'])` prima del fallback plaintext.

### Medium

#### F-03 | Bug | runFallbackWizard() senza try/catch in setup/auto.ts — errore blocca l'intero setup

**File:** `setup/auto.ts:391`
**Descrizione:** La chiamata `await runFallbackWizard()` non è wrappata in try/catch. Un'eccezione nel wizard (es. `logConfigEvent` che fallisce per permessi su `logs/`, o timeout API OpenRouter non gestito) blocca completamente il setup. Step successivi (mounts, service, first-chat) non vengono eseguiti.
**Evidenza:**
```ts
await runFallbackWizard(); // nessun try/catch
```
**Impatto:** Errore banale durante il wizard → installazione parziale, utente deve rieseguire tutto il setup con `--skip fallback`.
**Suggerimento:** Wrappare in try/catch con log e proseguire senza fallback configurato, o offrire all'utente scelta riprova/salta.

#### F-04 | Bug | logConfigEvent chiama fs.mkdirSync senza try/catch — crasha il wizard

**File:** `setup/fallback.ts:89-93`
**Descrizione:** `logConfigEvent` usa `fs.mkdirSync(dir, { recursive: true })` e `fs.appendFileSync` senza try/catch. Se `logs/` non è scrivibile, crasha il wizard.
**Evidenza:**
```ts
function logConfigEvent(msg: string): void {
  const dir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'fallback-setup.log'), entry);
}
```
**Impatto:** Directory `logs/` non scrivibile → crash del wizard → configurazione persa.
**Suggerimento:** Wrappare il corpo in try/catch, rendendo il logging best-effort.

### Low

#### F-05 | Business | Il messaggio di reminder 'nessun backup' omette l'istruzione di rieseguire il setup

**File:** `src/modules/fallback/notices.ts:50-54`
**Regola violata:** "Al primo errore di quota/overload di Claude, l'utente riceve immediatamente un messaggio: 'Claude ha esaurito i crediti. Puoi configurare un backup rieseguendo il setup.'"
**Descrizione:** La funzione `noBackupNotice()` produce "Rimandami il messaggio più tardi" invece di "Puoi configurare un backup rieseguendo il setup."
**Evidenza:**
```ts
return `⚠️ Claude ha esaurito i limiti (...) e non c'è un modello di riserva disponibile. Rimandami il messaggio più tardi.`;
```
**Impatto:** L'utente non sa come attivare un backup. Deve ricordare da solo di ri-eseguire il setup.
**Suggerimento:** Cambiare il testo in "Puoi configurare un backup rieseguendo il setup (`pnpm run setup`)."

#### F-06 | Business | Avviso API OpenRouter non raggiungibile ha testo diverso dalla spec

**File:** `setup/fallback.ts:139-142`
**Regola violata:** "viene mostrata una lista hardcoded di 15 modelli popolari con un avviso: 'Lista non aggiornata — l'API di OpenRouter non è raggiungibile.'"
**Descrizione:** Il messaggio è "OpenRouter API unreachable. Showing hardcoded list." — manca l'avvertimento che la lista potrebbe essere non aggiornata.
**Evidenza:**
```ts
p.log.warn(k.yellow('OpenRouter API unreachable. Showing hardcoded list.'));
```
**Impatto:** L'utente potrebbe non capire che la lista mostrata non è live e potrebbe essere obsoleta.
**Suggerimento:** "Lista non aggiornata — l'API di OpenRouter non è raggiungibile."

#### F-07 | Bug | process.argv[1]?.includes('fallback') può dare falsi positivi

**File:** `setup/fallback.ts:405`
**Descrizione:** `process.argv[1]?.includes('fallback')` matcha qualsiasi path contenente "fallback". Se eseguito da `/home/user/fallback-tools/...`, si attiva erroneamente.
**Evidenza:**
```ts
const invokedDirectly = process.argv[1]?.includes('fallback');
```
**Impatto:** Esecuzione diretta accidentale del wizard se importato come modulo da un path contenente "fallback".
**Suggerimento:** Usare `path.basename(process.argv[1]) === 'fallback.ts'`.

#### F-08 | Security | writeEnvLine non esegue escape del valore — possibile newline injection in .env

**File:** `setup/fallback.ts:71-79`
**Descrizione:** `writeEnvLine` scrive il valore senza sanitizzazione. Un valore contenente `\n` corromperebbe il file `.env`. Basso rischio perché i valori vengono da input interattivo dell'owner.
**Evidenza:**
```ts
const next = re.test(content)
  ? content.replace(re, `${key}=${value}`)  // value scritto raw, senza escape
  : ...;
```
**Impatto:** Se in futuro il valore provenisse da fonte esterna, newline injection possibile.
**Suggerimento:** Rimuovere/escapare newline dal value prima della scrittura.

#### F-09 | Bug | DUPLICATO: mergeNoProxy e readDotEnv copiati identici in ollama.ts e opencode.ts

**File:** `src/providers/ollama.ts:6-41`, `src/providers/opencode.ts:16-51`
**Descrizione:** Le funzioni `mergeNoProxy` e `readDotEnv` sono duplicate identiche in due file. Drift di comportamento futuro garantito.
**Suggerimento:** Estrarre in `src/providers/env-helpers.ts`.

#### F-10 | Security | MOCK_PROVIDER_FAIL / MOCK_RESET_AT propagate incondizionatamente in produzione

**File:** `src/container-runner.ts:451-453`
**Descrizione:** (Stesso finding di fallback-llm-review F-17) Variabili di test passate a tutti i container senza gate di produzione.
**Suggerimento:** Vedi fallback-llm-review.md F-17.

#### F-11 | Bug | isOwnerOrAdmin: fail-open se user_roles non esiste

**File:** `src/modules/fallback/commands.ts:37`
**Descrizione:** (Stesso finding di fallback-llm-review F-10) `if (!hasTable(db, 'user_roles')) return true` — concede accesso quando il modulo di sicurezza è assente.
**Suggerimento:** Vedi fallback-llm-review.md F-10.

## Note sul diff analizzato

- **Branch:** feat/fallback-llm
- **Base:** main
- **File modificati totali:** 67
- **File inclusi nell'analisi:** `setup/fallback.ts`, `setup/auto.ts`, `src/providers/ollama.ts`, `src/providers/opencode.ts`, `src/modules/fallback/`, `src/db/`, `container/agent-runner/src/providers/`
- **File esclusi:** `specs/` (documentazione), `package.json`, lock file, test file (analizzati indirettamente per bug pattern)

### Ambiguità della spec segnalata

**Clausola 16 — "sessioni non interrotte" vs kill container.** La spec dice "Le sessioni esistenti non vengono interrotte" e "Nessuna modifica alle conversazioni attive". L'implementazione in `enterFallback` (controller.ts:278-288) KILLA il container della sessione di origine e lo riavvia con un messaggio `on_wake` sul backup provider. I messaggi vengono re-presentati quindi l'esperienza utente è continua, ma il container fisico viene killato. Da chiarire se l'intento è preservare la sessione DB (ok) o evitare il kill del runtime (violato).

### Design review

La feature è puramente configurazionale (CLI/setup), senza interfaccia grafica. Nessun riferimento di design fornito — la review di design non è applicabile.
