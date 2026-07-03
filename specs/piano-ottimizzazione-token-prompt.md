# Piano: Ottimizzazione token e system prompt per uso Telegram (specs/ottimizzazione-token-prompt.md)

> Data: 3 luglio 2026 — piano prodotto con Claude in Plan Mode.
> Spec di riferimento: `specs/ottimizzazione-token-prompt.md`.

## Context

NanoClaw v2 installazione personale single-owner (Telegram). La spec richiede di ridurre il consumo di token del system prompt disabilitando selettivamente componenti non necessari per uso esclusivo Telegram (solo testo, niente interattivo, niente WhatsApp). L'agente comunica esclusivamente via Telegram — qualsiasi istruzione per altri canali o per messaggi interattivi è candidata alla rimozione. Il CLAUDE.local.md (312 righe) è materiale di default dalla migrazione v1 mai ripulito dall'utente.

**Decisione architetturale:** Aggiungere una colonna JSON `disabled_instructions` su `container_configs` per switchare moduli built-in (stesso pattern di `cli_scope === 'disabled'` usato per `cli.instructions.md`). Per le skill container, sfruttare il meccanismo `skills` già esistente — basta implementare il TODO nel composer che oggi include TUTTE le skill con `instructions.md` a prescindere dalla selezione.

Tutto è toggle: niente viene cancellato. Ogni componente disabilitato si riattiva con una modifica di configurazione, senza rebuild dell'immagine.

## Architettura (verificata sul tree)

Il system prompt è composto dinamicamente a ogni spawn container da `src/claude-md-compose.ts` — un file `CLAUDE.md` generato con solo `@./` imports verso fragment in `.claude-fragments/`. I fragment sono symlink (verso `/app/src/mcp-tools/*.instructions.md` e `/app/skills/*/instructions.md`) o inline (persona, MCP server instructions, fallback). Il composer ha già un filtro condizionale per `cli.instructions.md` quando `cli_scope === 'disabled'` (linee 89-96) — seguire lo stesso pattern.

La colonna `skills` in `container_configs` controlla già la disponibilità delle skill come tool (symlink in `.claude-shared/skills/`), ma il composer le include TUTTE nel prompt (TODO a linea 71). Correggere questa discrepanza risolve C2 nativamente.

Fatti load-bearing verificati:
- Il composer (`claude-md-compose.ts`) gira a ogni spawn (`container-runner.ts:288`) — i toggle prendono effetto al prossimo restart container, senza rebuild.
- `container/CLAUDE.md` è montato RO a `/app/CLAUDE.md` — modifiche qui richiedono `./container/build.sh`.
- `CLAUDE.local.md` è montato RW nel workspace — modifiche qui richiedono solo restart sessione.
- I file `instructions.md` nei MCP tools e nelle skill sono montati RO via `/app/src` e `/app/skills` — non vengono toccati, solo esclusi dal compose.
- `presentConfig` in `groups.ts` deserializza le colonne JSON per il display CLI.
- `updateContainerConfigScalars` copre solo colonne scalari; `updateContainerConfigJson` copre le JSON. `disabled_instructions` va in `JSON_COLUMNS`.

---

## Implementazione

### Step 1 — DB Migration (`src/db/migrations/019-disabled-instructions.ts`)
- `ALTER TABLE container_configs ADD COLUMN disabled_instructions TEXT NOT NULL DEFAULT '[]'`
- Append al barrel `migrations/index.ts`

### Step 2 — Types (`src/types.ts`)
- Aggiungere `disabled_instructions: string` a `ContainerConfigRow`

### Step 3 — Container Config CRUD (`src/db/container-configs.ts`)
- Aggiungere `'disabled_instructions'` al set `JSON_COLUMNS`

### Step 4 — Composer (`src/claude-md-compose.ts`)
- Parse `disabled_instructions` da `configRow` (JSON array di stringhe)
- Skip `interactive.instructions.md` quando `"interactive"` è nella lista (stesso pattern di `cli_scope === 'disabled'`)
- Implementare il TODO linea 71: quando `skills` non è `"all"`, includere solo skill con `instructions.md` che sono nella lista esplicita

### Step 5 — CLI (`src/cli/resources/groups.ts`)
- Aggiungere `disabled_instructions` a `presentConfig()` (parsato da JSON)
- Aggiungere `--disabled-instructions` al `config update` handler (accetta JSON array string)

### Step 6 — Pulizia CLAUDE.local.md (`groups/main/CLAUDE.local.md`)
- Copiare contenuto attuale → `groups/main/CLAUDE.local.v1-backup.md`
- Scrivere versione minimale con solo header e convenzioni di memoria

### Step 7 — Snellimento container/CLAUDE.md (`container/CLAUDE.md`)
- Rimuovere riga 1 ("You are a NanoClaw agent...")
- Condensare sezione Memory (rimuovere frase motivazionale)
- Versione snellita come da spec

### Step 8 — Build e verifica
- `./container/build.sh` (richiesto per modifica `container/CLAUDE.md`)
- `pnpm run build` (host TypeScript)
- Verifica che i toggle funzionino correttamente

## Rischi / punti aperti

- Nessuna modifica distruttiva — tutti i componenti sono esclusi logicamente, non cancellati
- Il toggle `disabled_instructions` è una colonna JSON nuova: se assente (default `'[]'`), nessun cambiamento di comportamento
- La modifica al composer per rispettare `skills` è retrocompatibile: se `skills === "all"`, il comportamento è identico
