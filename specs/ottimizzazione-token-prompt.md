# Spec: Ottimizzazione token e system prompt per uso Telegram

## Scopo

Ridurre il consumo di token del system prompt dell'agente NanoClaw eliminando selettivamente componenti non necessari per un utilizzo esclusivo via Telegram. Ogni componente rimosso deve essere facilmente riattivabile senza perdita di funzionalità — l'eliminazione è logica (toggle on/off), non fisica (cancellazione file). L'obiettivo è risparmiare token sugli elementi certamente inutili per l'uso attuale, mantenendo tutto il resto intatto.

## Ruoli e permessi

L'installazione è personale: l'owner è l'unico utente e amministratore. Tutte le decisioni di abilitazione/disabilitazione sono prese dall'owner. Non ci sono altri ruoli coinvolti.

## Regole di business

1. **Toggle, non delete.** Ogni componente disabilitato deve poter essere riattivato con una modifica minima (variabile d'ambiente, flag di configurazione, o ripristino di un file). Nessun file viene cancellato definitivamente.

2. **Granularità per componente.** Ogni modulo, skill e frammento è disabilitabile indipendentemente dagli altri. Disabilitare un componente non deve avere effetti collaterali su altri.

3. **Criterio di eliminazione.** Un componente viene disabilitato solo se soddisfa entrambe le condizioni: (a) non è utilizzato nell'uso attuale dell'agente, e (b) la sua assenza non degrada le funzionalità usate.

4. **Solo Telegram.** L'agente comunica esclusivamente via Telegram. Qualsiasi istruzione specifica per altri canali (WhatsApp, Slack, Discord) è candidata alla rimozione.

5. **Solo testo.** L'agente non utilizza messaggi interattivi (card con bottoni, domande bloccanti). Qualsiasi istruzione relativa a `send_card` o `ask_user_question` è candidata alla rimozione.

6. **Pulizia memoria legacy.** Il file `CLAUDE.local.md` del gruppo principale contiene materiale legacy dalla migrazione v1 (312 righe, ~12KB). Va analizzato e ripulito, conservando solo la memoria attiva. Il contenuto legacy va archiviato in un file separato per riferimento futuro.

## Componenti da disabilitare

### C1. Modulo interattivo (`interactive.instructions.md`)

- **File**: `container/agent-runner/src/mcp-tools/interactive.instructions.md`
- **Token**: ~110
- **Contenuto**: Istruzioni per `ask_user_question` (domanda bloccante con scelte) e `send_card` (messaggio interattivo fire-and-forget)
- **Motivo**: L'utente usa solo messaggi testuali. Regola 5.
- **Meccanismo di toggle**: Flag nel container config (es. `NANOCLAW_DISABLE_INTERACTIVE=true`) o esclusione condizionale nel composer (`claude-md-compose.ts`) analoga al meccanismo già esistente per `cli_scope === 'disabled'`

### C2. Skill WhatsApp formatting (`whatsapp-formatting/instructions.md`)

- **File**: `container/skills/whatsapp-formatting/instructions.md`
- **Token**: ~100
- **Contenuto**: Regole per la formattazione dei @mention WhatsApp (usare cifre del numero, non nomi)
- **Motivo**: L'utente usa solo Telegram. Regola 4.
- **Meccanismo di toggle**: Selezione skill già esistente in `container_configs.enabled_skills` — basta escludere `whatsapp-formatting` dalla lista

### C3. Pulizia CLAUDE.local.md legacy

- **File**: `groups/main/CLAUDE.local.md` (312 righe)
- **Problema**: Contiene materiale dalla migrazione v1, mai ripulito dall'utente
- **Azione**: Analizzare il contenuto, separare la memoria attiva dal materiale legacy, archiviare il legacy in `groups/main/CLAUDE.local.v1-backup.md`
- **Risparmio stimato**: ~1000-2000 token (dipende dal contenuto effettivo)

### C4. Snellimento CLAUDE.md base (`container/CLAUDE.md`)

- **File**: `container/CLAUDE.md` (21 righe, ~235 token)
- **Modifiche**:
  1. Rimossa riga 1: "You are a NanoClaw agent..." — meta-istruzione ridondante, l'agente sa già chi è dal system prompt addendum di `destinations.ts`
  2. Sezione Memory (righe 13-17): rimossa frase motivazionale "A core part of your job...". Il concetto utile (salva info in file, indicizzali in CLAUDE.local.md) rimane in forma concisa.
- **Versione snellita**:

```
Be concise — prefer outcomes over play-by-play.

## Workspace
Files you create are saved in `/workspace/agent/`. Use it for notes and anything that should persist across turns.

CLAUDE.local.md in your workspace is your per-group memory. Record preferences, project context, and recurring facts there. Keep entries short and structured.

## Memory
When the user shares substantive information, store it where you can retrieve it later. Create files organized by type (people, projects, preferences) and index them all in CLAUDE.local.md so you can find them in future conversations.

## Conversation history
The `conversations/` folder holds searchable transcripts of past sessions. For structured long-lived data, prefer dedicated files; split any >500 lines into a folder with an index.
```

- **Risparmio stimato**: ~80 token

## Precondizioni di flusso

- Il container deve essere ricostruito (`./container/build.sh`) dopo ogni modifica ai file `instructions.md` o alle skill nella directory `container/`
- Per i toggle via container config, è sufficiente un restart del container (non richiede rebuild dell'immagine)
- La pulizia di `CLAUDE.local.md` richiede solo il riavvio della sessione (il file è montato nel workspace)
- Dopo la disabilitazione, il funzionamento di base dell'agente (Bash, file I/O, web fetch/search, messaggistica Telegram) deve rimanere invariato

## Risposte attese

- **Disabilitazione riuscita**: Il componente non compare più nel system prompt. Il risparmio di token è misurabile confrontando il prompt prima e dopo.
- **Riattivazione**: Il componente torna nel system prompt senza perdita di contenuto o funzionalità.
- **Disabilitazione di un componente ancora in uso**: Se l'agente tenta di usare una funzionalità disabilitata (es. `send_card`), il tool non è disponibile e l'agente riceve un errore dal provider. L'owner può riattivare il componente.

## Side effect

- **Registrazione**: Ogni toggle (attivazione/disattivazione) viene registrato con timestamp, per tracciare la configurazione nel tempo.
- **Nessun impatto sulle conversazioni esistenti**: Le sessioni attive continuano col prompt corrente fino al prossimo riavvio container. La modifica si applica alle nuove sessioni.

## Riferimenti di design

Nessun riferimento di design fornito — la feature non ha interfaccia grafica.
