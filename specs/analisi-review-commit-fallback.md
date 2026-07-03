# Analisi post-commit: review del commit `cfaf7fa9` (fallback LLM, Fase A)

Data: 2026-07-03

## Contesto

Dopo aver committato tutte le modifiche della Fase A del piano di fallback
(`specs/piano-fallback-llm.md`) nel commit `cfaf7fa9b0c571800fea7743b45a0ef1eae8f31f`
(36 file, 3639 inserzioni, branch `feat/fallback-llm`), è stata eseguita una
review completa del diff, file per file. La suite di test è verde (75/75 test
del modulo fallback, 643/643 sull'intero repo) e la build passa pulita.

Dalla review sono emersi due punti aperti, entrambi già segnalati da commenti
nel codice stesso (non scoperte nuove, ma dubbi da verificare):

1. Il loop di attesa in `poll-loop.ts` che dipende da `config.signal?.aborted`.
2. La forma esatta del payload SDK per l'evento `rate_limit_event`, segnalata
   nel codice come "Real shape TBD — verify against sdk.d.ts once installed".

Questo file documenta l'indagine su entrambi e la domanda posta all'utente a
valle dell'indagine.

---

## Caveat 1 — `config.signal` in `poll-loop.ts`

### Il dubbio

Quando il provider nativo (`claude`) rileva un vero limite d'uso
(`ProviderLimitError`), il poll-loop scrive un `fallback_report` e poi entra
in un loop di attesa:

```ts
while (!config.signal?.aborted) {
  await sleep(1000);
}
```

Il dubbio era: questo loop termina davvero, o rischia di bloccare il
container per sempre se `config.signal` non diventa mai `aborted`?

### Indagine

- `grep` su tutto `container/agent-runner/src/index.ts` (il punto in cui
  `runPollLoop()` viene chiamato in produzione) non mostra **nessun** campo
  `signal` passato alla config, e **nessun** handler per `SIGTERM`/`SIGINT`
  registrato da nessuna parte nell'agent-runner.
- Il commento sul campo stesso (`poll-loop.ts:71-75`) lo conferma
  esplicitamente: *"Optional stop signal. In production the loop runs until
  the container dies; tests pass a signal so an abandoned loop actually
  exits instead of [hanging]."* — è un campo pensato apposta per i test
  (`integration.test.ts`, `upload-trace.test.ts` gli passano un
  `AbortController` vero), non per la produzione.
- Il container viene terminato da `killContainer()` → `stopContainer()` in
  `src/container-runtime.ts:33`, che esegue `docker stop -t 1 <nome>`: invia
  `SIGTERM`, aspetta 1 secondo, poi manda `SIGKILL`.
- Poiché nessun handler intercetta `SIGTERM` nel processo Bun dell'agent-runner,
  si applica l'azione di default del sistema operativo: il processo termina
  **immediatamente** alla ricezione del segnale, ben prima che scada il
  secondo di grazia.

### Verdetto

**Non è un bug.** Il loop è progettato per essere "svuotato" dall'esterno
(kill del processo via Docker), non per auto-terminarsi controllando lo
stato di un abort signal che in produzione non esiste mai. Il commento nel
codice descrive esattamente questo comportamento. Il container muore per
azione diretta del sistema operativo, indipendentemente da cosa stia
facendo il loop JS in quel momento.

---

## Caveat 2 — forma del payload `rate_limit_event`

### Il dubbio

`container/agent-runner/src/providers/claude.ts` classifica gli eventi
`rate_limit_event` emessi dall'SDK Claude per capire quando il provider
nativo ha esaurito davvero i limiti d'uso (non solo un rate-limit
temporaneo). Il codice conteneva un commento esplicito: *"Real shape TBD —
verify against @anthropic-ai/claude-agent-sdk's sdk.d.ts once installed"* —
la vera forma del payload non era mai stata verificata, perché `bun` (e
quindi le dipendenze dell'agent-runner) non è installato in questo ambiente.

### Indagine

Non essendoci `node_modules`/`bun` disponibili localmente, ho scaricato
direttamente il file di definizioni TypeScript della versione pinnata
(`@anthropic-ai/claude-agent-sdk@0.3.197`, la versione in
`container/agent-runner/package.json`) da unpkg e ho confrontato le
definizioni reali con quanto assunto dal codice.

**Forma reale (da `sdk.d.ts`):**

```ts
export declare type SDKRateLimitEvent = {
  type: 'rate_limit_event';   // <- campo di primo livello, non 'system'
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID;
  session_id: string;
};

export declare type SDKRateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | ...;
  // ...altri campi di utilizzo/overage
};
```

Per confronto, `SDKAPIRetryMessage` (l'altro evento gestito dallo stesso
codice) **è** effettivamente annidato sotto `system`:

```ts
export declare type SDKAPIRetryMessage = {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  // ...
};
```

**Cosa assume invece il codice attuale** (`providers/claude.ts`):

```ts
const subtype = message.type === 'system' ? (message as { subtype?: string }).subtype : undefined;
// ...
} else if (subtype === 'rate_limit_event') {
  const raw = (message as { rate_limit?: unknown }).rate_limit ?? message;
  const signal = classifyRateLimitEvent(raw);
  // ...
}
```

e (`limit-detect.ts`):

```ts
const BLOCKING_STATUSES = new Set(['rejected', 'exceeded']);
```

### Tre discrepanze concrete

1. **Discriminante sbagliato.** `rate_limit_event` è un tipo di messaggio di
   primo livello (`message.type === 'rate_limit_event'`), non un
   `system`/`subtype`. La variabile `subtype` nel codice viene valorizzata
   *solo* quando `message.type === 'system'` — quindi per un vero evento di
   rate limit resta sempre `undefined`, e il ramo
   `else if (subtype === 'rate_limit_event')` **non scatta mai** in
   produzione. È codice morto rispetto all'SDK reale.

2. **Campo sbagliato.** Anche ammesso che il discriminante venga corretto,
   il codice legge `message.rate_limit`; il campo reale si chiama
   `rate_limit_info`, e lo `status` è annidato dentro di esso
   (`message.rate_limit_info.status`), non al primo livello del messaggio.

3. **Enum di stato sbagliato.** Il codice tratta `'rejected'` ed
   `'exceeded'` come stati di blocco e `'warning'` come stato di
   pass-through (rate limit "leggero", resta sulla via del retry
   esistente). Nella realtà i valori possibili sono solo
   `'allowed' | 'allowed_warning' | 'rejected'`:
   - `'exceeded'` non viene mai emesso — ramo morto ma innocuo.
   - Il vero valore di pass-through è `'allowed_warning'` (e `'allowed'`),
     non `'warning'` — comunque questi valori restano fuori da
     `BLOCKING_STATUSES`, quindi il comportamento (nessun blocco) risulta
     casualmente corretto anche col nome sbagliato nel set.
   - `'rejected'`, l'unico valore che conta davvero per il blocco, è
     presente in `BLOCKING_STATUSES` — quindi *se* il messaggio arrivasse
     con la forma giusta, questa parte klassificherebbe correttamente.

### Verdetto

**Bug reale, confermato.** Il percorso di rilevamento "quota esaurita" per
il provider nativo tramite `rate_limit_event` è **codice morto** rispetto
al vero SDK: la condizione che dovrebbe farlo scattare non è mai vera. Il
sistema di fallback per Claude nativo non è del tutto cieco, perché restano
attivi altri due segnali:

- `classifyRetryStreak` (streak di eventi `api_retry` consecutivi →
  overload persistente) — **confermato corretto**, la forma di
  `SDKAPIRetryMessage` coincide con quanto assunto dal codice.
- `classifyErrorResultText` (pattern-matching testuale su messaggi di
  errore relativi a credito/fatturazione nel risultato finale).

Ma il segnale più diretto e tempestivo — l'evento dedicato che l'SDK emette
apposta per comunicare "sei stato bloccato per limite d'uso" — non viene
mai intercettato nella sua forma reale.

---

## La domanda posta all'utente

Dopo aver confermato il bug, ho chiesto:

> **"Fix the confirmed rate_limit_event bug in providers/claude.ts now?"**
>
> - **Sì, correggilo ora** — correggere il discriminante (controllo sul
>   tipo di primo livello, non `system`/`subtype`), il percorso del campo
>   (`rate_limit_info`, `status` annidato) e l'enum di stato
>   (`allowed`/`allowed_warning`/`rejected`) per allinearli al vero SDK;
>   aggiornare `limit-detect.ts` e i relativi test; rilanciare la suite.
> - **No, limitati a segnalarlo e fermati qui** — lasciarlo come debito
>   tecnico noto per dopo; il caveat 1 è chiuso (non è un bug), il caveat 2
>   diventa un problema scritto e tracciato.

La ragione della domanda: si tratta di una modifica a un file già
committato, che tocca la logica di classificazione core del path nativo di
rilevamento limiti — un cambiamento che vale la pena decidere esplicitamente
piuttosto che applicare in autonomia, dato che il commit è già stato fatto e
l'utente aveva chiesto esplicitamente di fermarsi a fine review per
decidere il passo successivo.

**Risposta dell'utente:** invece di scegliere una delle due opzioni, ha
chiesto di scrivere questa analisi in un file `.md` dentro `specs/`,
spiegando anche la domanda posta — cosa che questo documento fa. La
decisione se correggere subito il bug del caveat 2 **resta quindi ancora
aperta** e non è stata presa in questo passaggio.
