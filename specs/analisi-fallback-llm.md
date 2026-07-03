# Analisi di fattibilità — Fallback automatico a un altro LLM quando Claude raggiunge i limiti

> **Data:** 2 luglio 2026
> **Autore:** Claude Fable 5 (analisi codebase NanoClaw v2)
> **Stato:** analisi completata — prossimo passo: spec dell'Opzione A via `/crea-spec`

## Obiettivo

Realizzare una versione custom di NanoClaw in grado di accorgersi automaticamente quando i limiti di Claude (rate limit, usage limit da abbonamento, credito esaurito) vengono raggiunti, e in quel caso fare fallback automatico a un altro LLM, per poi tornare a Claude quando i limiti si resettano.

## Verdetto

**Fattibile, e l'architettura è già mezza pronta.** NanoClaw v2 ha un'astrazione provider pluggabile e — punto chiave — **rileva già il rate limit di Claude, ma poi non ci fa niente**: il segnale arriva fino al poll-loop e viene solo scritto nei log. Il fallback si aggancia esattamente lì.

## Come NanoClaw parla con Claude oggi

Il flusso vive tutto dentro il container, in `container/agent-runner/src/`:

1. **`config.ts`** legge `container.json` (scritto dall'host dalla tabella `container_configs`) e fissa il `provider` (default `claude`) **una volta sola all'avvio del container**.
2. **`index.ts`** istanzia il provider tramite un registry (`providers/factory.ts` + `provider-registry.ts`) e avvia il poll-loop.
3. **`providers/claude.ts`** wrappa il Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) e traduce gli eventi SDK in eventi neutri `ProviderEvent` (`providers/types.ts:126`): `init`, `result`, `error`, `progress`, `activity`.
4. **`poll-loop.ts`** consuma questi eventi e scrive le risposte in `outbound.db`.

## La scoperta chiave: il rilevamento c'è già, manca la reazione

In `claude.ts:450-453` il provider traduce già due segnali dell'SDK:

- `api_retry` → `{ type: 'error', retryable: true }` — errori transitori (429/529), l'SDK ritenta da solo
- `rate_limit_event` → `{ type: 'error', retryable: false, classification: 'quota' }` — **questo è il "limite raggiunto"**

Ma in `poll-loop.ts:564` (`handleEvent`) l'evento `error` viene **solo loggato**. Nessuna azione, nessun fallback.

Inoltre i turni che finiscono in errore non-retryable (es. 403 billing) arrivano come `result` con `isError: true` e il testo dell'errore (`claude.ts:442-449`) — anche gli usage limit da abbonamento ("Claude usage limit reached, resets at...") passano di lì e si possono classificare con un pattern-match sul testo.

Nota utile: l'evento `rate_limit_event` dell'SDK porta anche il timestamp di reset — utilizzabile per **tornare automaticamente a Claude** quando il limite scade.

## Le tre architetture possibili

### Opzione A — Fallback nel poll-loop (consigliata)

Quando il poll-loop riceve l'errore "quota", re-invia lo stesso messaggio a un secondo provider (es. OpenCode con OpenRouter/DeepSeek, già disponibile sul branch `providers` via skill `/add-opencode`). Le sessioni sono già separate per provider (`setContinuation(providerName, ...)`), quindi lo switch non corrompe nulla.

**Lavoro richiesto:**
- estendere la classificazione errori in `claude.ts` (usage-limit testuale, `resets_at`);
- nel poll-loop (o in un wrapper che compone provider primario + secondario) reagire all'errore "quota" re-inviando il prompt al fallback;
- nuovi campi di config in `container_configs` / `container.json` (es. `fallback_provider`, `fallback_model`);
- logica di ritorno al primario dopo il reset dei limiti.

**Pro:**
- È la soluzione più allineata a com'è fatto NanoClaw: usa l'astrazione provider che esiste già, non inventa niente di nuovo.
- Tocca pochi file (~4: `claude.ts`, `poll-loop.ts`, `config.ts` + lato host per la config).
- Lo switch avviene istantaneamente, dentro il container, senza riavvii.
- Libertà totale sulla scelta del modello di fallback (qualsiasi provider registrabile: OpenCode, Codex, ecc.).
- Facile da testare: il provider `mock.ts` esiste già per i test.

**Contro:**
- **Il fallback riparte "smemorato" sulla conversazione in corso**: ogni provider ha il suo transcript separato, quindi il modello di riserva non sa cosa si stava dicendo. Serve un "ponte" (vedi sezione dedicata sotto).
- Serve installare e configurare un secondo provider, con le sue credenziali.
- Va progettata la logica di rientro su Claude (quando? come si evita il ping-pong tra i due?).

### Opzione B — Fallback a livello API (contesto preservato)

Invece di cambiare provider, si mette un "centralino" tra l'SDK di Claude e l'API: un proxy che parla il linguaggio dell'API Anthropic ma che, quando Anthropic risponde "limite raggiunto", gira la richiesta a un altro modello (es. Ollama in locale, che parla l'API Anthropic nativamente — vedi skill `/add-ollama-provider` — o un router tipo LiteLLM). Basta un override di `ANTHROPIC_BASE_URL`.

**Pro:**
- **È l'unica soluzione che non perde il contesto**: per l'SDK non cambia nulla, stesso transcript, la conversazione continua come se niente fosse. Il problema del "fallback smemorato" sparisce del tutto.
- Zero modifiche al codice di NanoClaw (o quasi): la logica sta tutta nel proxy.
- Riutilizzabile anche fuori da NanoClaw.

**Contro:**
- Il modello di fallback deve essere raggiungibile tramite un'API compatibile con quella di Anthropic — la scelta è più ristretta (Ollama locale, o serve un componente di traduzione in mezzo).
- Introduce un pezzo di infrastruttura in più da far girare, monitorare e tenere aggiornato.
- Il modello di riserva riceve un prompt pensato per Claude (istruzioni Claude Code, formato tool) — modelli molto diversi potrebbero comportarsi peggio del previsto.
- Il rilevamento del limite va fatto nel proxy, duplicando in parte la logica che l'SDK ha già.

### Opzione C — Switch lato host (riavvio container)

L'host, quando rileva il limite, cambia il provider nel database (`ncl groups config update --provider ...`) e riavvia il container con un messaggio di "risveglio" (`container-restart.ts` + `on_wake`).

**Pro:**
- Usa solo meccanismi che esistono già (self-mod, restart, on_wake) — quasi zero codice nuovo nel container.
- Lo stato del provider attivo è visibile e gestibile centralmente dal database / CLI `ncl`.

**Contro:**
- **Pesante**: ogni switch costa un riavvio completo del container (secondi di attesa, sessione interrotta a metà turno).
- Il segnale di limite nasce nel container ma la decisione sta nell'host: serve un canale in più per comunicarlo (nuova system action in outbound.db).
- Stesso problema di contesto dell'Opzione A, ma con più latenza.
- Il rientro su Claude richiede un altro riavvio.

## Il vero problema di progetto: la continuità del contesto (Opzioni A e C)

Al momento del fallback, il modello di riserva non conosce la conversazione in corso. Il repo è già consapevole del problema — esiste la skill `/migrate-memory` proprio per i cambi di provider. Mitigazioni da mettere in spec:

- iniettare nel primo prompt del fallback un riassunto degli ultimi scambi — il provider Claude archivia già i transcript in markdown in `conversations/` (funzione `archiveTranscriptFile` in `claude.ts`);
- la memoria persistente (`CLAUDE.local.md` / memory scaffold) è comunque condivisa tra i provider, perché vive nel workspace montato.

## Altri punti da decidere in spec

- **Quali errori scatenano il fallback**: rate limit temporaneo (aspettare?), usage limit da abbonamento (fallback fino al reset), credito/billing esaurito (fallback + notifica admin). Policy diverse per casi diversi.
- **Credenziali del LLM di fallback**: OneCLI vault, env `OPENCODE_*`, o Ollama locale (nessuna credenziale).
- **Rientro su Claude**: usare il `resets_at` del `rate_limit_event`; evitare il ping-pong con un minimo di isteresi.
- **Notifica**: avvisare l'utente/admin quando avviene lo switch (e quando si rientra).

## Raccomandazione

**Opzione A come core**, con l'Opzione B come variante "premium" se si accetta un modello Anthropic-compatibile come fallback (unica via per preservare il contesto in modo del tutto trasparente).
