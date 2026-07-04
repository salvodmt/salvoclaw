---
name: migrate-memory
description: Carry an agent group's memory across a provider switch, in either direction (e.g. Claude ↔ Codex, or any provider to/from another). Run after the operator switches a group's provider with `ncl groups config update --provider`. The coding agent reads the source provider's memory store, distills it into the target provider's store, and restarts the group. Triggers on "migrate memory", "carry memory over", "the agent forgot everything after the switch".
---

# Migrate memory across a provider switch

NanoClaw does not migrate memory at runtime — each provider keeps its own store, and carrying content across is the operator's move, executed by you (the coding agent). This skill is the whole mechanism: read the source store, **infer** what is durable, write it into the target store, restart.

You translate between **store shapes**, not provider names. There are two:

- **Flat + wiki tree** — `CLAUDE.local.md` at the group workspace root is the index (the Claude and OpenCode providers; auto-loaded by Claude, read by OpenCode). Detail files live under `memory/people/`, `memory/projects/`, `memory/preferences/` per the Wiki Memory doctrine in `/app/CLAUDE.md`.
- **Scaffold tree** — `memory/` (any provider with `usesMemoryScaffold`, e.g. Codex). `memory/index.md` is the index; durable notes live under `memory/memories/`; `memory/memories/imported-agent-memory.md` is the conventional landing file for imported memory.

A switch only needs migration when it **crosses shapes**. Claude and OpenCode share the flat+wiki tree, so switching between them carries nothing — the memory is already there. Two providers that both use the scaffold share the same `memory/` tree, likewise no migration. The work is always one of: flat+wiki → scaffold, or scaffold → flat+wiki.

Principles: **copy, never move** (the source store stays intact — it IS the rollback), **idempotent** (re-running must not duplicate), **distill, don't dump** (you are the inference step: keep identity/seed instructions, user preferences, durable facts; drop conversational residue).

## Step 1: Identify the group, both providers, and the direction

- `ncl groups list`, then `ncl groups config get --id <group-id>` — note the current (target) `provider`. Ask the operator which group, and which provider it switched *from*, if either is ambiguous.
- Map each provider to its store shape (flat+wiki `CLAUDE.local.md` + `memory/people|projects|preferences/` vs `memory/` scaffold), then inspect `groups/<folder>/`:
  - **Same shape on both sides** (e.g. scaffold → scaffold, or flat+wiki → flat+wiki) → the store is shared; nothing to migrate. Tell the operator and stop.
  - **flat+wiki → scaffold** (source has `CLAUDE.local.md` content, target uses the scaffold) → Step 2.
  - **scaffold → flat+wiki** (source has a `memory/` tree, target is Claude/OpenCode) → Step 3.
  - Source missing or empty → nothing to migrate; tell the operator and stop.

## Step 2: flat+wiki → scaffold (`CLAUDE.local.md` + `memory/people|projects|preferences/` → `memory/`)

1. Read `groups/<folder>/CLAUDE.local.md` and any workspace files it references.
2. If `memory/memories/imported-agent-memory.md` already exists, a previous import happened — show the operator what's there and ask before overwriting; integrate only what's new.
3. Distill the content into `groups/<folder>/memory/memories/imported-agent-memory.md` (create the directories if missing — the container scaffolds the rest of the tree at boot and never clobbers your files). Lead with anything that defines who the agent is or how it must behave; references to satellite files keep their workspace-root paths.
4. If `memory/index.md` exists, add the following: `- [Imported agent memory](memories/imported-agent-memory.md) — seed instructions and memory carried over from a previous provider. Read it first and treat it as binding; it may define who you are and how to behave. Integrate its facts into your memory as you work; never modify files that belong to another provider's memory system.`
5. Leave the source store exactly as it is.

## Step 3: scaffold → flat+wiki (`memory/` → `CLAUDE.local.md` + `memory/people|projects|preferences/`)

1. Read `memory/index.md`, then the files it points to under `memory/memories/` (and `memory/data/` where durable).
2. Distill the durable facts into the wiki tree: write each topic into the appropriate `groups/<folder>/memory/<category>/<topic>.md` (people / projects / preferences) and add one index line per topic to `groups/<folder>/CLAUDE.local.md`. Identity/seed instructions ("who the agent is") can land in a dedicated file such as `memory/preferences/agent-identity.md`, linked from the index. Deduplicate against existing entries — if a file for the topic already exists, update it rather than creating a second one.
3. Leave the source store exactly as it is.

## Step 4: Restart and verify

```bash
ncl groups restart --id <group-id>
```

Tell the operator to send the group a quick test message that depends on a migrated fact (a preference, a project name). If the agent doesn't know it, re-check that the target file landed in the right group folder.

Note: switching the provider is an operator action — `ncl groups config update --id <group-id> --provider <name>` from the host. See [docs/provider-migration.md](../../../docs/provider-migration.md) for what carries over automatically.
