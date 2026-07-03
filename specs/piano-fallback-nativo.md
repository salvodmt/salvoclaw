# Piano: Fallback nativo salvoclaw — provider preinstallati e onboarding

> Data: 3 luglio 2026
> Spec di riferimento: `specs/fallback-nativo.md`
> Approccio Ollama: Provider wrapper (non config override seam)

## Context

Salvoclaw è il fork personale di NanoClaw v2. Il valore aggiunto principale è la gestione proattiva del fallback: quando Claude esaurisce quota/credito o va in overload, l'assistente switcha automaticamente a un provider di backup.

Il **runtime del fallback esiste già** (`src/modules/fallback/`). Manca:
1. Preinstallare i provider nell'immagine
2. Wizard di onboarding per configurare il backup
3. Meccanismo Ollama (via wrapper provider, non via config override seam)

## Architettura

### Provider preinstallati

| Provider | Meccanismo | Cosa serve |
|----------|------------|------------|
| `opencode` | Provider dedicato | `opencode-ai` in `cli-tools.json`, `@opencode-ai/sdk` in agent-runner, file `opencode.ts` host+container committati |
| `ollama` | Provider wrapper attorno a ClaudeProvider | `container/agent-runner/src/providers/ollama.ts` che wrappa ClaudeProvider con env overrides (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY=ollama). Usa il meccanismo di override esistente: `effectiveProvider` restituisce `ollama`, container.json ha `"provider": "ollama"`, il container usa il wrapper. Zero modifiche ai file core. |

### Campi `env` e `blockedHosts` in ContainerConfig

Necessari per Ollama ma anche per flessibilità futura:
- `env?: Record<string, string>` — env vars per-agent-group (es. `ANTHROPIC_BASE_URL`)
- `blockedHosts?: string[]` — `--add-host` per bloccare endpoint (es. `api.anthropic.com` → `0.0.0.0`)

Aggiunti a: ContainerConfig type, container-config.ts, container-runner.ts, DB migration, CLI.

### Onboarding wizard

Flusso interattivo durante il setup:
1. Domanda: OpenCode+OpenRouter / Ollama / Nessuno
2. Se OpenCode: top 15 modelli da API OpenRouter + chiave API → OneCLI vault
3. Se Ollama: auto-discovery modelli locali + URL daemon configurabile
4. Scrittura `.env`: `FALLBACK_PROVIDER`, variabili specifiche
5. Idempotente: se già configurato, mostra stato attuale e permette modifica

---

## Implementazione

### Fase 1 — Campi `env` e `blockedHosts` in ContainerConfig

1. **Migration 020**: `ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'` e `ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]'`
2. **`src/types.ts`**: aggiungere `env: string` e `blocked_hosts: string` a `ContainerConfigRow`
3. **`src/db/container-configs.ts`**: aggiungere `env` e `blocked_hosts` a `JSON_COLUMNS` e tipi
4. **`src/container-config.ts`**: aggiungere `env` e `blockedHosts` a `ContainerConfig` interface e `configFromDb()`
5. **`src/container-runner.ts`**: wiring `-e` e `--add-host` in `buildContainerArgs()`
6. **`src/cli/resources/groups.ts`**: aggiungere a `presentConfig()`
7. **Dockerfile**: `chmod 777 /home/node` già presente

### Fase 2 — Preinstallare OpenCode nell'immagine

1. Fetch branch `providers` e copiare file OpenCode
2. Barrel import: `container/agent-runner/src/providers/index.ts` e `src/providers/index.ts`
3. `container/agent-runner/package.json`: aggiungere `@opencode-ai/sdk@1.4.17`
4. `container/cli-tools.json`: aggiungere `{ "name": "opencode-ai", "version": "1.4.17", "onlyBuilt": true }`
5. Copiare test guard (Dockerfile structural test)
6. Propagare a per-group overlays esistenti

### Fase 3 — Provider wrapper Ollama

1. `container/agent-runner/src/providers/ollama.ts`: provider che wrappa `ClaudeProvider` con env overrides
2. Registrare in barrel: `container/agent-runner/src/providers/index.ts`

### Fase 4 — Onboarding wizard

1. `setup/fallback.ts` — wizard interattivo con `inquirer`
2. OpenRouter: fetch top 15 + fallback hardcoded + verifica custom model
3. Ollama: auto-discovery daemon + input manuale + URL configurabile
4. OneCLI vault: salvataggio chiave con auto-resolution se non disponibile
5. Scrittura `.env` idempotente
6. Integrazione in `setup/auto.ts` come nuovo step (dopo `auth`)
7. Standalone runnable: `pnpm run setup:fallback`

### Fase 5 — Test e verifica

1. `pnpm run build` — compilazione host
2. `pnpm test` — tutti i test passano
3. `cd container/agent-runner && bun test` — test container
4. `./container/build.sh` — immagine include OpenCode
5. Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
