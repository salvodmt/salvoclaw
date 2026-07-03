# Piano: Fallback automatico a LLM di riserva (specs/fallback-llm.md)

> Data: 3 luglio 2026 — piano prodotto con Claude Fable 5 in Plan Mode.
> Spec di riferimento: `specs/fallback-llm.md`.

## Context

NanoClaw v2 è un assistente personale single-owner (Telegram). Oggi, quando l'account Claude esaurisce quota/credito o Anthropic è in sovraccarico persistente, l'assistente resta muto: il poll-loop del container logga l'evento `classification:'quota'` (`poll-loop.ts` `handleEvent` case `'error'`) e basta. La spec `specs/fallback-llm.md` richiede: switch automatico install-wide a un modello di riserva (OpenCode+OpenRouter), avvisi in chat, riassunti di contesto in entrambe le direzioni, rientro automatico, garanzia di risposta entro 10 minuti, stato persistente, comandi manuali owner-only.

**Decisioni utente:** Fase A = meccanismo completo testato con provider mock; se i test passano, Fase B = installazione OpenCode+OpenRouter (chiedere chiave API e modello a quel punto). Comandi chat: `/fallback status|force|return` (+ alias italiani `stato|forza|rientro`), gestiti **host-side** — sono normali messaggi Telegram al bot, intercettati prima dell'agente così funzionano anche a Claude morto.

## Architettura (verificata sul tree)

Switch **guidato dall'host**. Il container rileva il limite e lo segnala via system action (`kind:'system'` su messages_out → `registerDeliveryAction`, `src/delivery.ts:405-445`). L'host persiste lo stato in una nuova tabella `fallback_state` (central `v2.db`), applica un **override globale di provider** a spawn/materializzazione (mai riscrivendo `container_configs.provider` — non clobbera gruppi nativamente su altro provider e rende il ripristino banale), riavvia i container col pattern esistente `killContainer`/onExit + on_wake (`src/container-restart.ts:22-65`), notifica l'owner nella conversazione in corso, e guida i rientri dallo sweep 60s (`src/host-sweep.ts`, convention MODULE-HOOK).

Fatti load-bearing verificati:
- `markCompleted(processingIds)` è incondizionato a `poll-loop.ts:283` — il turno-limite deve bypassarlo perché il messaggio in volo venga ri-presentato al backup (regola 4).
- Lo stato Claude è **host-visibile**: `DATA_DIR/v2-sessions/<agentGroupId>/.claude-shared` montato su `/home/node/.claude` (`container-runner.ts:280,339`) → il riassunto d'andata si costruisce host-side dai `.jsonl` senza chiamare il modello caduto (regola 5).
- Continuation già per-provider (`session_state` key `continuation:<provider>`, `container/agent-runner/src/db/session-state.ts`) → switch e rientro lossless.
- Command gate nel router a `src/router.ts:449-467` (pattern deny con `writeOutboundDirect`) — punto d'inserimento dell'interceptor `/fallback`.
- Env/mount del provider (OPENCODE_*, XDG) risolti solo a spawn (`resolveProviderContribution`, `container-runner.ts:247-264`) — per questo lo switch in-container non è praticabile.
- Credenziali via gateway OneCLI, invarianti allo switch → regola 16 soddisfatta by design.
- L'unica classificazione oggi è `'quota'` (`claude.ts:452-453`, payload SDK scartato, nessun resetAt); billing arriva come `result` con `isError:true` (`claude.ts:442-449`).

**Configurazione backup**: `.env` host — `FALLBACK_PROVIDER=<nome>` (Fase A: `mock`; Fase B: `opencode`) + per opencode `OPENCODE_PROVIDER/OPENCODE_MODEL/ANTHROPIC_BASE_URL`. Nessun default di modello (regola 14). `isBackupUsable()` verifica a runtime: `FALLBACK_PROVIDER` impostato e, se `opencode`, `OPENCODE_MODEL` non vuoto; il secret OneCLI non è verificabile host-side → auth failure a runtime = doppio guasto.

Lavorare su un feature branch (es. `feat/fallback-llm`).

---

## FASE A — Meccanismo

### A1. Container: rilevamento e classificazione

**Nuovo `container/agent-runner/src/limit-detect.ts`** (puro, bun:test):
```ts
export type LimitClassification = 'quota' | 'billing' | 'overload';
export interface LimitSignal { classification: LimitClassification; resetAt: number | null; message: string }
export function classifyRateLimitEvent(raw: unknown): LimitSignal | null;      // solo status rejected/exceeded; warning → null
export function classifyErrorResultText(text: string): LimitSignal | null;     // /billing|credit balance|insufficient credit|payment/i → 'billing'
export function classifyRetryStreak(streak: number, firstAtMs: number, nowMs: number): LimitSignal | null; // ≥6 api_retry consecutivi o >5min → 'overload'
```

**`providers/types.ts`**: estendere l'evento error con `resetAt?: number | null`.

**`providers/claude.ts` `translateEvents` (:431-464)**:
- `rate_limit_event`: parsing difensivo del payload (verificare la shape in `sdk.d.ts` dopo `bun install` in `container/agent-runner` — primo task; `resetsAt` atteso in secondi unix → ×1000). Emettere l'evento error solo su limite reale (oggi ogni `rate_limit_event` diventa errore quota — bug da correggere).
- `api_retry`: tracker locale nel generator; quando `classifyRetryStreak` scatta → error `classification:'overload'` non-retryable (difesa primaria anti-blocco, prima del backstop host a 10 min).

### A2. Container: percorso ProviderLimitError + report all'host

**Nuovo `container/agent-runner/src/fallback-report.ts`**: `class ProviderLimitError extends Error { signal, provider }` + `writeFallbackReport(routing, report)` che scrive su messages_out:
```json
{ "action":"fallback_report", "classification":"quota|billing|overload", "resetAt":1782044400000, "message":"...", "provider":"claude", "messageIds":["..."] }
```

**`poll-loop.ts`**:
1. `processQuery`: evento error non-retryable con classification limite → `query.abort(); throw new ProviderLimitError(...)`; ramo result `isError` → `classifyErrorResultText` PRIMA di `markCompleted(initialBatchIds)` (:483) → se billing, throw.
2. `runPollLoop` catch (:255-276): se `ProviderLimitError` e `providerName === 'claude'`: NIENTE messaggio chat `Error:`, flag `limitAbort` che salta il `markCompleted` finale (:283) — le righe restano `processing`, l'host le ri-penda senza bump di `tries` —, `writeFallbackReport`, poi drain: `while(!aborted) sleep(1000)` in attesa del kill host (delivery poll ~1s).
3. Percorso errore generico (:269-276): testo `Non sono riuscito a elaborare il tuo messaggio per un errore.\nDettaglio tecnico: <errMsg>` + system action aggiuntiva `{"action":"provider_error","provider":"...","message":"..."}` (serve per doppio guasto e re-fallback silenzioso del probe). `markCompleted` resta → "l'avviso chiude la partita" (spec, doppio guasto).

### A3. Host: migrazione + stato

**Nuovo `src/db/migrations/module-fallback-state.ts`** (+ append al barrel `migrations/index.ts:36-53`): tabella single-row
```sql
fallback_state(id=1 CHECK, active, mode 'auto'|'forced', classification, reason, backup_provider,
  entered_at, reset_at, next_retry_at, retry_count, probing, probe_message_id, probe_session_id,
  probe_started_at, origin_session_id, origin_group_id, last_error, updated_at)
```
**Nuovo `src/modules/fallback/db.ts`**: `getFallbackState`, `enterFallbackState`, `clearFallbackState`, `setProbe`, `bumpRetry`, `setLastError`. Nessuna cache: letture dirette a ogni chiamata (spawn/sweep) → sopravvive ai riavvii gratis (regola 12).

### A4. Host: override globale provider

**Nuovo `src/provider-override.ts`** (seam core): `registerGlobalProviderOverride(fn)` + `applyProviderOverride(native)`.
**Nuovo `src/modules/fallback/override.ts`**: pura `effectiveProvider(native, state)` — identity se `!active || probing || !backupProvider || native === backupProvider`, altrimenti `backupProvider`.
Tre punti d'applicazione (one-liner): `container-runner.ts:137` (providerName), `:252` (contribution → copre env/mount del backup), `container-config.ts` `materializeContainerJson` (:74) prima della scrittura di container.json (il runner istanzia il provider da lì). `resolveProviderName` resta puro e intoccato.

### A5. Host: modulo orchestrazione `src/modules/fallback/`

Struttura: `index.ts` (barrel: delivery actions, override, export sweep hooks; + `import './fallback/index.js'` in `src/modules/index.ts`), `controller.ts`, `decide.ts`, `db.ts`, `notices.ts`, `summary.ts`, `commands.ts`, `cli.ts`, `fragment.ts`.

**`controller.ts`** — `isBackupUsable()`, `handleFallbackReport(content, session, inDb)`, `enterFallback(opts)`, `exitFallback({via})`, `startReturnProbe(now)`, `representMessages(inDb, ids)` (UPDATE → pending senza toccare `tries`).

`handleFallbackReport` (delivery action `fallback_report`):
1. `probing` attivo → **re-fallback silenzioso** (regola 10): `bumpRetry`, riga probe → `completed` (il briefing di rientro non deve mai finire davanti al backup), ri-penda messageIds, restart su backup. Nessun avviso, log warn.
2. Fallback già attivo (report duplicato) → solo ri-pendare e restart.
3. Altrimenti → `enterFallback({mode:'auto', ...})`.

`enterFallback`:
1. `isBackupUsable()` falso → regola 11: avviso immediato in conversazione (`writeOutboundDirect` verso l'indirizzo della riga scatenante) con motivo + reset se noto; messaggi → `failed` (gestiti, mai ri-presentati in silenzio — regola 15); kill container. STOP, nessuno stato attivo.
2. `enterFallbackState` con `next_retry_at = reset_at ?? now + primo backoff` (auto) o NULL (forced).
3. `representMessages` + pulizia claim orfani post-kill.
4. Fragment di degradazione per tutti i gruppi (A8), best-effort.
5. Avviso owner nella conversazione origine (`writeOutboundDirect`); fallback: `pickApprover` + `ensureUserDm` + `getDeliveryAdapter().deliver` (pattern `primitive.ts:256-277`). Non bloccante (try/catch + log).
6. Riassunto d'andata (A6), best-effort, incorporato nel briefing on_wake.
7. Restart: sessione origine con `writeSessionMessage(..., onWake:1, briefing+summary)` + `killContainer(..., onExit → wakeContainer)`; altri gruppi attivi con `restartAgentGroupContainers(g, 'fallback-switch', shortBriefing)` (i task schedulati girano sul backup — regola 3); gruppi spenti prendono l'override al prossimo wake. Le righe ri-pendate + on_wake finiscono nella stessa prima batch (`getPendingMessages(isFirstPoll=true)`) → il backup riceve briefing e messaggio in sospeso nello stesso prompt (regola 4).
8. Log warn con classification/resetAt/sessioni.

`provider_error` handler: se `probing` → re-fallback silenzioso; se `active` → `setLastError` + log (doppio guasto già chiuso dal messaggio unico del container); altrimenti log info.

### A6. Riassunti di contesto

**Andata (→ backup), meccanico host-side** — **nuovo `src/modules/fallback/summary.ts`**: `summarizeClaudeTranscript(agentGroupId)` legge il `.jsonl` più recente in `DATA_DIR/v2-sessions/<gid>/.claude-shared/projects/*/`, porting minimo di `parseTranscript` (`claude.ts:122-142`) su Node, ultime ~10 coppie user/assistant, tronca ~4000 char. Su fallimento → il briefing istruisce il backup a leggere `/workspace/agent/conversations/` e `CLAUDE.local.md` (via subordinata della regola 5); evento loggato, mai bloccante.

**Ritorno (→ Claude), per istruzione**: il briefing di rientro elenca i file di `conversations/` con mtime ≥ `entered_at` (readdir host, best-effort) e dice a Claude di leggerli (regola 9). Verificare che il provider opencode implementi `onExchangeComplete` per archiviare gli scambi; se no, aggiungerlo in Fase B.

### A7. Rientro + garanzia 10 minuti (sweep)

**Probe = switch-back ottimistico in-container** (un probe host-side è impraticabile: credenziali nel vault OneCLI, iniettate solo ai container). Regola 7 soddisfatta a fortiori; regola 10 dal ramo `probing`; anti-ping-pong: backoff crescente, nessun avviso su fallimento.

**Nuovo `src/modules/fallback/decide.ts`** (tutto puro):
```ts
export const RESPONSE_GUARANTEE_MS = 10 * 60_000;
export const RETURN_BACKOFF_MIN = [5, 10, 20, 40, 60];  // cap 60
export function nextRetryAt(retryCount: number, nowMs: number): number;
export function decideFallbackSweep({nowMs, state, probeRowStatus, overdueTriggerMessages, declaredBashMs}): FallbackSweepAction;
// → 'none' | 'start-probe' | 'probe-timeout' | 'probe-success' | {'guarantee-breach', messageIds}
```
Regole: `active && auto && !probing && now ≥ (reset_at ?? next_retry_at)` → start-probe; `probing && probe completed` → probe-success; `probing && now − probe_started_at > 10min` → probe-timeout; fallback NON attivo e messaggi trigger=1 con età > `max(10min, declaredBashMs + 60s)` → guarantee-breach (un tool Bash lungo dichiarato non è "bloccato"; i retry quota toccano l'heartbeat quindi il segnale giusto è l'età del claim, non il silenzio heartbeat; la difesa primaria resta `classifyRetryStreak` container-side a ~5min); `forced` → mai probe.

**Due hook MODULE-HOOK in `src/host-sweep.ts`**:
1. In `sweepSession`, prima dei passi SLA/cleanup (precedenza sul retry generico): `sweepFallbackSession(inDb, outDb, session)` — calcola i messaggi oltre soglia; su guarantee-breach: kill + `enterFallback({classification:'timeout', ...})`; se fallback GIÀ attivo (il backup sfora) → avviso doppio guasto + `failed` (niente loop). Marca/ri-penda lui stesso le righe così `resetStuckProcessingRows`/MAX_TRIES non le rivedono. Copre i pending attraverso riavvio host (primo tick al boot). Raccoglie anche i `failed` da MAX_TRIES non notificati → avviso + `status='failed_notified'` (dedup senza colonne nuove).
2. Nel corpo di `sweep()` (una volta per tick, accanto a `MODULE-HOOK:approvals-reason-sweep`, `host-sweep.ts:158-165`): `sweepFallbackReturn()` — start-probe → `setProbe`+`probing=1` (override torna al nativo), riga on_wake `fallback-probe-<ts>` nella sessione origine col briefing di rientro (che in caso di successo È il riassunto della regola 9), kill+wake solo di quella sessione; probe-success → `exitFallback`: clear state, rimozione fragment, avviso "rientrato su Claude", restart altri gruppi vivi; probe-timeout → kill, `bumpRetry`, probe → completed, restart su backup, silenzioso.

### A8. Comandi owner + CLI + testi

**Interceptor router** — in `deliverToAgent` subito prima del gate esistente (`router.ts:449`), MODULE-HOOK: `interceptFallbackCommand(content, userId, session, deliveryAddr)` → true = gestito. Riconosce `/fallback` + `status|stato` (default), `force|forza`, `return|rientro`. Autorizzazione owner/admin (stessa query `user_roles` di `command-gate.ts:isAdmin`); deny → `writeOutboundDirect` stile `router.ts:456-463`. Risposte host-side via `writeOutboundDirect` verso `addr`. `force` → `enterFallback({mode:'forced', classification:'manual'})`, mai auto-rientro (regola 13); `return` → `exitFallback({via:'manual'})` incondizionato (se Claude è ancora giù, il prossimo messaggio rifà fallback con avviso — coerente con le precondizioni di flusso della spec).

**`cli.ts`**: `registerResource('fallback', ..., customOperations: {status, force, return})` richiamando lo stesso controller; NON in whitelist agent-scope (`dispatch.ts:51`) — solo operatore.

**`fragment.ts`**: su enter scrive `groups/<folder>/.claude-fragments/zz-fallback.md` per ogni gruppo (identità riserva + regola di onestà "dichiara ciò che non riesci a fare, mai fingere" — regola 6); su exit lo rimuove; ricomposizione CLAUDE.md esplicita. File concreto perché OpenCode legge i fragment via glob, non il CLAUDE.md composto.

**`notices.ts`** (funzioni pure, snapshot-testabili, in italiano): switch auto (`⚠️ Claude ha esaurito i limiti (<motivo>). Passo a <modello>.` + reset se noto), motivi per classification, regola 11 (nessun backup: avviso con motivo + reset + "rimandalo più tardi"), rientro (`✅ Sono tornato su Claude.`), forzato, status (modello attivo, auto/forzato, da quando, motivo, prossimo tentativo — regole 61), briefing on_wake andata e rientro.

**Logging**: `log.info/warn` (`src/log.ts`) su ogni transizione: enter auto/forced, avviso inviato/fallito, riassunto fallito, probe start/success/timeout, re-fallback silenzioso, guarantee-breach, doppio guasto, exit (side-effect "Registrazione" della spec).

### A9. Test

Host (vitest, mirror dei test esistenti di host-sweep/container-restart/cli):
- `decide.test.ts` — backoff (5→60 cap), i 5 rami di `decideFallbackSweep`, `declaredBashMs`, `forced` sopprime il probe.
- `override.test.ts` — `effectiveProvider` (inattivo / attivo / nativo=backup intoccato / probing), `applyProviderOverride` identity senza registrazione, `materializeContainerJson` scrive il provider overridato.
- `db.test.ts` — migrazione + round-trip, singleton row.
- `notices.test.ts` — snapshot testi.
- `controller.test.ts` — report con probing → nessun avviso + bumpRetry; `isBackupUsable`; `representMessages` non tocca `tries`.
- `commands.test.ts` — intercept, alias italiani, deny non-owner, passthrough testo normale.

Container (bun:test):
- `limit-detect.test.ts` — rate_limit_event rejected/warning/malformato, billing text, retry streak.
- poll-loop con provider mock: quota → riga system `fallback_report` con messageIds, messages_in NON completed, nessun `Error:` in chat; throw generico → messaggio unico con `Dettaglio tecnico` + action `provider_error` + completed.

### A10. Verifica end-to-end (con mock)

1. Estendere `providers/mock.ts`: `MOCK_PROVIDER_FAIL=quota|billing|overload` (+ `MOCK_RESET_AT`) per emettere il segnale; gruppo di test su provider mock; `FALLBACK_PROVIDER=mock` come backup (contribution host assente = nessun env extra, ok).
2. Messaggio Telegram al gruppo di test → attesi: avviso switch in chat, `fallback_state.active=1` (`ncl fallback status` + `pnpm exec tsx scripts/q.ts`), container respawnato con `container.json.provider` = backup, risposta al messaggio ri-presentato, fragment presente.
3. Rientro: azzerare `next_retry_at` → al tick: probe, riga `fallback-probe-*` completed, avviso rientro, fragment rimosso. Probe fallito (mock ancora in fail) → nessun avviso, `retry_count`++.
4. Regola 11: `FALLBACK_PROVIDER` unset → solo avviso, messaggio `failed`.
5. Garanzia 10 min: mock che si blocca (activity events infiniti) → sweep kill + switch. Riavvio host con pending vecchio → primo tick gestisce.
6. Comandi: `/fallback force` (sweep non tenta rientro), `/fallback return`, `/fallback status`, deny non-owner.
7. `pnpm test`, `pnpm run build`, `cd container/agent-runner && bun test` + `bun run typecheck`.

---

## FASE B — OpenCode (solo se i test di Fase A passano)

1. Eseguire `/add-opencode` (copia da `origin/providers`: `container/agent-runner/src/providers/opencode.ts` + `mcp-to-opencode.ts`, host `src/providers/opencode.ts`, barrel imports, `@opencode-ai/sdk` pinned, Dockerfile ARG, rebuild immagine).
2. Chiedere all'utente chiave OpenRouter (→ secret OneCLI host-pattern `openrouter.ai`) e modello (→ `OPENCODE_MODEL`); `.env`: `FALLBACK_PROVIDER=opencode`, `OPENCODE_PROVIDER=openrouter`, `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`.
3. Verificare `onExchangeComplete` nel provider opencode (per il riassunto di ritorno); aggiungerlo se manca.
4. E2E reale non distruttivo: `/fallback force` → conversazione reale su OpenRouter → `/fallback return`.

## Rischi / punti aperti

- Shape esatta di `rate_limit_event` nella versione SDK dell'immagine (`sdk.d.ts` dopo `bun install`): campo, unità di `resetsAt`, valori di `status`. Parsing difensivo comunque.
- Se la sessione origine del probe è chiusa/inattiva → fallback su qualsiasi sessione attiva del gruppo origine o primo gruppo attivo.
- Ordine di implementazione: A3/A4/A7-decide (puro, testabile in isolamento) → A1/A2 (container) → A5/A6 (orchestrazione) → hook sweep → A8 → test → E2E.
