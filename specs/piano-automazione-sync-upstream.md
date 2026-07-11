# Piano: automazione sync/migrazione upstream con test-gate (da fare quando pronti)

> Data: 10 luglio 2026 — discussione con Claude Sonnet 5, nessuna implementazione ancora fatta.
> Stato: **SOLO NOTE — non pianificato in dettaglio, non implementato.** Da riprendere quando l'utente è pronto.

## Context

Questo fork (`salvodmt/salvoclaw`, remote `origin`) diverge da upstream (`https://github.com/nanocoai/nanoclaw.git`, remote `upstream` **non ancora configurato**) soprattutto nel motore LLM: è in corso lo sviluppo della logica di fallback automatico a un LLM di riserva (`src/modules/fallback/` — vedi `specs/piano-fallback-llm.md`). Le personalizzazioni sono committate direttamente su `main`, non su un branch separato.

**Preoccupazione dell'utente:** un sync/merge da upstream potrebbe rovinare silenziosamente lo sviluppo del fallback — non solo con conflitti Git espliciti, ma anche con conflitti "semantici" (upstream tocca file adiacenti senza generare conflitto Git, ma rompe comunque la logica del fallback). `docs/BRANCH-FORK-MAINTENANCE.md` conferma che questo è un rischio reale anche per i merge ufficiali del progetto.

Il progetto ha già due meccanismi sanzionati per portare dentro l'upstream (invece del merge grezzo, che il tripwire in `src/upgrade-state.ts` scoraggia attivamente):
- **`/update-nanoclaw`** — sync di routine, anteprima + cherry-pick selettivo.
- **`/migrate-nanoclaw`** — estrae le personalizzazioni come "intento" e le riapplica su una base upstream pulita.

## Obiettivo del piano futuro

Costruire un'automazione che **rilevi e verifichi**, ma **non forzi mai un merge/push automatico su `main`** — l'esatto rischio che l'utente vuole evitare. Il gate umano resta obbligatorio quando l'automazione tocca le zone sensibili del fallback.

## Componenti discussi (da dettagliare in un piano concreto)

1. **Fetch periodico di upstream** (schedulato — es. settimanale). Sola lettura, nessun impatto su `main`.
2. **Diff mirato sui path sensibili**, non generico. Path protetti candidati:
   - `src/modules/fallback/**`
   - `src/providers/**`
   - `src/router.ts`
   - `src/provider-override.ts`
   - `src/container-runner.ts`
   - migration DB che toccano `fallback_state`/`fallback_events` (`src/db/migrations/021-fallback-model.ts`, `022-fallback-events.ts`, `module-fallback-state.ts`)
   Se upstream non tocca questi file → rischio basso. Se li tocca → segnale forte di "rivedi prima di sincronizzare".
3. **Merge di prova in un git worktree usa-e-getta** (mai su `main` reale). Se il merge di prova riesce, lanciare lì la suite di test esistente:
   - host: `pnpm test`
   - container: `cd container/agent-runner && bun test`
   Buona notizia: `src/modules/fallback/` ha già discreta copertura (`controller.test.ts`, `db.test.ts`, `decide.test.ts`, `notices.test.ts`, `override.test.ts`, `commands.test.ts`) — l'automazione userebbe soprattutto quello che già esiste. Da valutare: aggiungere 1-2 test di regressione che fissino il comportamento attuale del fallback come rete di sicurezza aggiuntiva prima di fidarsi dell'automazione.
4. **Output = report o PR di bozza, mai un push diretto.** Specialmente se i path protetti sono coinvolti.
5. **Dove farlo girare** — due opzioni da valutare quando si farà il piano:
   - GitHub Action schedulata (il repo ha già `.github/workflows/`) — gira anche a host spento.
   - Routine schedulata di Claude Code (skill `/schedule`) — più semplice da impostare, ma richiede la macchina accesa.

## Prerequisito non ancora fatto

Aggiungere il remote upstream (azione a costo zero, mai eseguita in questa conversazione):
```bash
git remote add upstream https://github.com/nanocoai/nanoclaw.git
```

## Prossimo passo

Quando l'utente è pronto: trasformare questi punti in un piano concreto (file da creare, integrazione con `/update-nanoclaw`/`/migrate-nanoclaw`, formato esatto della lista path protetti, dove far girare l'automazione).
