# Audit Robustezza NanoClaw v2 — Luglio 2026

## Meccanismo di fallback

Il fallback provider è ben progettato. Stato in `fallback_state` (singola riga DB centrale), logica decisionale pura (`decide.ts`), kill+respawn race-free via `once('close', onExit)`. L'`on_wake` column assicura che il messaggio di wake sia preso solo dal primo poll del container fresco.

Flow: container rileva limite → `ProviderLimitError` → `fallback_report` in outbound.db → host riceve via delivery → `enterFallback` → switch stato, re-presenta messaggi, restart container. Return probe automatico con backoff `[5,10,20,40,60]` min. Double fault: fail + notifica, no loop.

**Valutazione: solido.** Unica osservazione: nessun circuit-breaker per spawn falliti ripetuti.

---

## Finding critici (verificati)

### 1. Leak DB handle in `container-restart.ts:48` — ALTO

`openInboundDb(...)` result mai chiuso. Viola invariante #2 (`session-manager.ts:6-11`): long-lived connection congela la page cache del container. Un handle per session per restart call.

### 2. Race condition in `writeMessageOut` — `messages-out.ts:45-78` — ALTO

Read-modify-write su `seq` across due DB senza `BEGIN IMMEDIATE`. Poll-loop + MCP subprocess sono processi separati che scrivono concorrentemente. UNIQUE previene corruzione ma causa response droppate. Il pattern corretto esiste in `cli/ncl.ts:51-88`.

### 3. Silent-drop-as-delivered — `delivery.ts:250-253,358,463` — ALTO

Tre path dove `return undefined` → `markDelivered(msg.id, null)`: no adapter, routing fields mancanti, system action sconosciuto. Il messaggio sparisce senza retry.

---

## Finding medi

| # | Dove | Problema |
|---|------|----------|
| 4 | `primitive.ts:244` | Module approvals non scadono mai. Nessuno sweep. |
| 5 | `poll-loop.ts:265-267` | Initial-batch non controlla `isCorruptionError`. Container resta vivo con cache avvelenata fino a 60s. |
| 6 | `apply.ts:36-49→56-82` | Config-image desync su build failure. Config aggiornato prima del build. |
| 7 | `router.ts:334,338` | Fan-out non isolato. Errore DB di un agent aborte il loop per i successivi. |
| 8 | `host-sweep.ts:267` | `handleRecurrence` senza try/catch — module hook crasha il core sweep. |
| 9 | `container-runner.ts:115-119` | `wakeContainer` ritorna `true` con agent group mancante. Typing leak, messaggi si accumulano. |
| 10 | `access.ts:21-27` | Nessun try/catch nella access chain — throw invece di fail-closed. |
| 11 | `opencode.ts:334,385,393` | Shared runtime non distrutto su throw non-timeout. |
| 12 | `primitive.ts:244→259` | Pending row orfano su delivery failure. |

---

## Finding bassi

| # | Dove | Problema |
|---|------|----------|
| 13 | `delivery.ts:35` | `deliveryAttempts` resetta al restart → retry illimitati cross-restart. |
| 14 | `scripts/q.ts:30` | Nessun `busy_timeout`, nessun `readonly` per SELECT. |
| 15 | `migrations/index.ts:42-65` | Ordering array-based, non version-sorted. |
| 16 | Container | Nessun SIGTERM handler. `docker stop -t 1` = 1s grace. |
| 17 | `router.ts:168,280` | Interceptor/senderResolver throwing aborte routing senza `dropped_messages` row. |

---

## Fix implementati in questa sessione

- **P0-1**: Chiuso leak DB handle in `container-restart.ts:48`
- **P0-2**: Wrappato `writeMessageOut` in `BEGIN IMMEDIATE` (`messages-out.ts`)
- **P0-3**: Sostituito silent-drop-as-delivered con throw in `delivery.ts`
- **P1**: `isCorruptionError` applicato all'initial-batch path (`poll-loop.ts`)
- **P1**: Fan-out loop isolato con try/catch per-agent (`router.ts`)
- **P1**: `wakeContainer` ritorna `false` se agent group mancante (`container-runner.ts`)
- **P2**: `busy_timeout` aggiunto a `q.ts`
- **P2**: `handleRecurrence` wrappato in try/catch (`host-sweep.ts`)
