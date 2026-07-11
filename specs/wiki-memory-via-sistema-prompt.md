# Spec: Wiki Memory — Istruzioni Wiki via Sistema Prompt

## Scopo
Potenziare le istruzioni di memoria nel file `container/CLAUDE.md` con un pattern
wiki ispirato al Karpathy LLM Wiki. L'agente gestisce una memoria persistente
strutturata in CLAUDE.local.md + file di dettaglio, consultabile su richiesta e
aggiornabile sia autonomamente (quando rileva informazioni sostanziali) sia su
comando esplicito dell'utente.

La memoria e' **per-agent-group e perpetua**: CLAUDE.local.md e i file in `memory/`
risiedono nella cartella del gruppo agente sull'host e sopravvivono a ogni ciclo di
vita del container (spawn, lavoro, idle, kill, re-spawn). Il container e' effimero
— la memoria no. Lo stesso CLAUDE.local.md accumula conoscenza da tutti i canali e
da tutte le interazioni con quel gruppo agente, senza distinzione di sessione.

## Ruoli e permessi
La modifica riguarda esclusivamente il sistema prompt. Non ci sono ruoli o permessi
coinvolti: l'agente ha accesso completo in scrittura al proprio workspace.

## Regole di business

### 1. Struttura della memoria

1.1. **CLAUDE.local.md** funge da indice principale. Contiene una riga per argomento
     con link al file di dettaglio.

1.2. I file di dettaglio risiedono in `/workspace/agent/memory/`, organizzati in tre
     sottocartelle:
     - `memory/people/` — persone, contatti, ruoli
     - `memory/projects/` — progetti, contesto tecnico, stack, architettura
     - `memory/preferences/` — preferenze dell'utente, convenzioni, stili

1.3. Ogni file di dettaglio è in formato Markdown libero.

### 2. Scrittura su memoria

#### 2.1. Scrittura autonoma

L'agente scrive su memoria di propria iniziativa quando rileva **informazioni
sostanziali**, definite come:

- L'utente dichiara esplicitamente una preferenza personale o di lavoro
- L'utente fornisce contesto nuovo su un progetto (stack, obiettivi, vincoli)
- L'utente prende una decisione (scelta di una tecnologia, architettura, approccio)
- L'utente menziona una persona o entità rilevante con dettagli (nome, ruolo, relazione)

#### 2.2. Scrittura su comando

L'utente puo' ordinare esplicitamente la scrittura usando una o piu' di queste
frasi trigger:
- "ricorda", "salva", "memorizza", "appunta"
- "tieni a mente", "segnati", "prendi nota"

Se il comando e' esplicito ma l'informazione e' oggettivamente banale, l'agente:
- Avvisa l'utente che l'informazione sembra di scarsa rilevanza
- Scrive comunque su memoria — l'utente decide cosa e' importante
- Non rifiuta mai un comando esplicito di memorizzazione

#### 2.3. Flusso di scrittura

Per ogni scrittura, autonoma o su comando:

1. Determinare la categoria appropriata (people, projects, preferences)
2. Se esiste gia' un file sull'argomento, aggiornarlo
3. Se l'argomento e' nuovo, creare un nuovo file `memory/<categoria>/<argomento>.md`
4. Aggiornare CLAUDE.local.md aggiungendo o modificando la riga indice corrispondente

#### 2.4. Controllo di fine turno

Il container e' effimero e puo' essere killato dall'host in qualsiasi momento dopo
l'inattivita', senza segnali di preavviso e senza alcun hook di shutdown a
disposizione dell'agente. I tool MCP `schedule_task`/`cancel_task` che rendevano
possibile una review differita non esistono piu' (sostituiti da `ncl tasks`, vedi
`docs/ncl-tasks-migration.md`): ogni task creato con `ncl tasks` vive in una
task-session isolata, separata dalla sessione di chat che l'ha originata, e non ha
accesso alla conversazione che dovrebbe rivedere. Una review pre-shutdown differita
e' quindi strutturalmente impossibile con l'architettura attuale.

Il controllo si sposta percio' **prima** dell'invio della risposta, ad ogni turno,
invece che dopo, in prossimita' dello shutdown.

2.4.1. Prima di inviare il messaggio finale di ogni turno, l'agente ripassa quanto
      appena discusso e verifica se c'e' materiale sostanziale (secondo i criteri
      del punto 2.1) non ancora salvato in memoria.

2.4.2. Se trova informazioni non salvate, le scrive seguendo il flusso di scrittura
      standard (2.3), poi prosegue normalmente con la risposta al turno.

2.4.3. Se non trova nulla di nuovo, non fa nulla: nessun messaggio aggiuntivo,
      nessuna conferma del controllo stesso.

2.4.4. Il controllo avviene ad ogni turno, non solo in prossimita' dello shutdown:
      copre l'intera conversazione in modo incrementale, con una copertura pari o
      superiore alla vecchia review pre-shutdown (che copriva solo l'ultimo batch
      prima del kill, ed era comunque solo best-effort).

2.4.5. Non c'e' piu' un messaggio di commiato dedicato ("Prima di andare in pausa,
      ho salvato...") perche' non esiste alcun segnale affidabile, nella nuova
      architettura, che una sessione stia per essere killata per inattivita'.

### 3. Lettura della memoria

3.1. L'agente **non** legge CLAUDE.local.md automaticamente prima di ogni risposta.

3.2. L'agente consulta la memoria solo quando l'utente fa una richiesta che richiede
     contesto passato (es. "cosa avevamo deciso per X?", "che stack usa il progetto Y?",
     "chi era quella persona di cui parlavamo?").

3.3. Se la memoria contiene informazioni rilevanti per la richiesta corrente ma
     l'utente non le ha chieste esplicitamente, l'agente puo' citarle come contesto
     utile, indicando la fonte.

### 4. Gestione conflitti

4.1. Se durante una scrittura l'agente rileva che la nuova informazione contraddice
     un fatto gia' registrato in memoria:
     - **Non** sovrascrive automaticamente
     - Chiede conferma all'utente: "Avevo registrato che [vecchia informazione], ma
       ora mi dici [nuova informazione]. Quale versione e' corretta?"
     - Solo dopo conferma esplicita, aggiorna la voce esistente

4.2. Se l'utente conferma la modifica, la vecchia informazione viene sostituita e
     la modifica viene annotata (es. "Aggiornato il GG-MM-AAAA: precedentemente X")

### 5. Gestione della dimensione dell'indice

5.1. Se CLAUDE.local.md supera le 50 righe, l'agente compatta l'indice:
     - Per ogni categoria, sposta le voci in `memory/<categoria>/index.md`
     - CLAUDE.local.md mantiene solo una riga per categoria con link:
       ```
       - [People](memory/people/index.md)
       - [Projects](memory/projects/index.md)
       - [Preferences](memory/preferences/index.md)
       ```
     - Se una singola categoria ha piu' di 30 voci, crea un `index.md` di secondo
       livello nella sottocartella corrispondente

5.2. La compattazione e' trasparente per l'utente: l'agente la esegue automaticamente
     senza interrompere il flusso della conversazione

5.3. L'agente puo' notificare la compattazione con un messaggio breve:
     "Ho riorganizzato la memoria per mantenerla efficiente."

### 6. Resilienza

6.1. Se la scrittura su disco fallisce:
     - L'agente tenta una seconda scrittura dopo 1 secondo
     - Se il secondo tentativo fallisce, registra l'errore e notifica l'utente
     - L'agente tiene traccia dell'informazione nel contesto della conversazione
       corrente, ma l'informazione potrebbe non persistere al prossimo spawn del
       container
     - La conversazione prosegue normalmente: il fallimento della memoria non blocca
       l'agente

6.2. Se un file di memoria e' corrotto o illeggibile, l'agente lo segnala all'utente
     e propone di ricrearlo o ignorarlo.

6.3. Se il container viene killato (es. per inattivita' dopo 30 minuti), la memoria
     gia' scritta su disco e' salva. Al prossimo spawn, il nuovo container ritrova
     CLAUDE.local.md e tutti i file in `memory/` esattamente come lasciati.

### 7. Modifica della base condivisa

7.1. Le nuove istruzioni wiki arricchiscono la sezione "Memory" esistente nel
     file `container/CLAUDE.md`, senza rimuovere le istruzioni attuali.

7.2. Le istruzioni esistenti (Workspace, Memory, Conversation history) restano
     invariate.

7.3. Una nuova sezione "## Wiki Memory" viene aggiunta dopo la sezione "Memory"
     esistente, contenente tutte le regole definite in questa spec.

7.4. La skill operativa `.claude/skills/migrate-memory/SKILL.md` viene aggiornata
     per riflettere la dottrina wiki: la forma "flat" diventa "flat + wiki tree"
     (`CLAUDE.local.md` indice + `memory/people|projects|preferences/`), applicabile
     a Claude e OpenCode (entrambi leggono `/app/CLAUDE.md` e `CLAUDE.local.md`).
     La forma "scaffold tree" (Codex, `memory/system|memories|data`) resta invariata.

7.5. L'allineamento dello scaffold di memoria per i provider surfaces-owning (Codex:
     `memory-scaffold.ts`, template, `group-init.ts` seed landing) e' **fuori scope**
     di questa spec e demandato a un lavoro separato (B-full). `container/CLAUDE.md`
     e' bind-mount RO (`container-runner.ts:334`, non baked nell'immagine): la modifica
     e' attiva al prossimo spawn senza rebuild dell'immagine.

## Modello di persistenza

- CLAUDE.local.md e i file in `memory/` sono per-agent-group, non per-sessione.
  Risiedono nella cartella del gruppo agente sull'host e vengono montati in
  scrittura in ogni container che serve quel gruppo.
- Il container e' effimero: spawna per processare messaggi, vive fino a 30 minuti
  di inattivita', poi viene killato. La memoria sopravvive a ogni kill e re-spawn.
- L'agente non deve preoccuparsi del ciclo di vita del container: la memoria c'e'
  sempre, indipendentemente da quando e' stato spawnato il container corrente.
- L'agente non ha un evento di "inizio sessione" o "fine sessione": riceve messaggi
  in un loop continuo. La memoria e' sempre disponibile, prima e dopo ogni messaggio.

## Decisioni di implementazione

1. **Scope (punto 7).** Implementato come opzione "prompt + skill": modifica a
   `container/CLAUDE.md` (nuova sezione `## Wiki Memory`) + aggiornamento della skill
   `migrate-memory`. L'allineamento dello scaffold Codex (`memory-scaffold.ts`,
   template, `group-init.ts`) e' differito a un lavoro separato (B-full).
2. **Controllo di fine turno (2.4).** Implementato come dottrina pura, senza alcuna
   schedulazione. Dopo la rimozione dei tool MCP `schedule_task`/`cancel_task`
   (sostituiti da `ncl tasks`, che crea sempre una task-session isolata e separata
   dalla chat che l'ha originata) non esiste piu' alcun meccanismo che permetta a una
   review differita di rivedere la conversazione che dovrebbe controllare — ne' un
   hook di shutdown nel codice host (il kill e' un semplice `docker stop -t 1`, senza
   percorso di graceful shutdown). Il controllo si sposta quindi a fine turno, prima
   dell'invio della risposta: resta pienamente nell'ambito "solo system prompt" e non
   introduce alcuna dipendenza da scheduling.
3. **Copertura provider.** La dottrina wiki raggiunge Claude e OpenCode via
   `/app/CLAUDE.md` (bind-mount RO, `defaultSurfaces`). Codex (surfaces-owning,
   `usesMemoryScaffold`) non riceve `container/CLAUDE.md` montato e usa il proprio
   scaffold: resta sulla dottrina `memory/system/definition.md` fino al B-full.

## Precondizioni di flusso

- L'agente deve avere accesso in scrittura al workspace (`/workspace/agent/`)
- Le directory `memory/people/`, `memory/projects/`, `memory/preferences/` devono
  esistere. Se non esistono, l'agente le crea al primo messaggio processato per
  quel gruppo agente
- CLAUDE.local.md deve esistere (gia' garantito dal sistema: viene creato vuoto
  se assente al momento del primo spawn per quel gruppo agente)
- Nessun rebuild dell'immagine container: `container/CLAUDE.md` e' bind-mount RO
  (`container-runner.ts:334`). La modifica e' attiva al prossimo spawn del gruppo
  (restart del servizio o `ncl groups restart`).

## Risposte attese

| Scenario | Comportamento |
|---|---|
| Scrittura memoria — successo | L'agente scrive e prosegue. Puo' includere una breve conferma: "Salvato in memoria." |
| Scrittura memoria — conflitto rilevato | L'agente chiede conferma: "Avevo registrato [vecchia info], ma ora mi dici [nuova info]. Quale versione e' corretta?" |
| Scrittura memoria — comando diretto, informazione banale | L'agente avvisa: "Mi sembra un'informazione di routine, ma la salvo comunque." Poi scrive. |
| Scrittura memoria — fallimento I/O | Primo tentativo fallito → secondo tentativo dopo 1s. Se fallisce ancora: "Attenzione: non sono riuscito a salvare in memoria. Ne terro' conto per questa conversazione, ma l'informazione potrebbe non persistere." |
| Lettura memoria — informazione non trovata | "Non trovo informazioni su [argomento] nella mia memoria." |
| Lettura memoria — informazione trovata | L'agente include l'informazione nella risposta, citando la fonte: "Come discusso in precedenza, [info]." |
| Controllo di fine turno — trovato materiale da salvare | L'agente salva seguendo il flusso standard (2.3), poi risponde normalmente al turno; nessun messaggio di commiato dedicato. |
| Controllo di fine turno — nessun nuovo contenuto | Nessuna azione aggiuntiva; l'agente risponde normalmente al turno. |

## Side effect

Nessun side effect esterno. La modifica riguarda il sistema prompt (`container/CLAUDE.md`)
e la skill operativa `migrate-memory`. Nessun codice runtime viene modificato; nessun
rebuild dell'immagine container (la base e' bind-mount RO, vedi 7.5).
