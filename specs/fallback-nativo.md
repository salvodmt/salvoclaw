# Spec: Fallback nativo con provider preinstallati e onboarding integrato

## Scopo

Salvoclaw include nativamente due provider di backup (OpenCode e Ollama) preinstallati nell'immagine container. Durante l'onboarding — subito dopo la configurazione delle credenziali Claude — l'utente sceglie se e quale provider di backup attivare. Quando Claude esaurisce i crediti o va in overload, il sistema switcha automaticamente al backup configurato, avvisando l'utente. Se non è stato configurato alcun backup, l'utente riceve un reminder immediato per configurarlo. L'intero flusso è guidato e non richiede conoscenze tecniche.

## Ruoli e permessi

L'installazione è personale single-owner. L'owner è l'unico utente e amministratore. Tutte le decisioni di configurazione del fallback sono prese dall'owner durante l'onboarding iniziale o rieseguendo il setup in qualsiasi momento.

## Regole di business

### Configurazione provider di backup

1. **Scelta provider.** Durante l'onboarding, dopo la configurazione delle credenziali Claude, viene chiesto: "Quando Claude esaurisce i crediti o va in overload, posso passare automaticamente a un provider di riserva. Quale vuoi usare?" Le opzioni sono: OpenCode + OpenRouter (consigliato), Ollama (modello locale), Nessun backup.

2. **OpenCode sempre disponibile.** Il provider OpenCode è preinstallato nell'immagine container. L'utente non deve installare nulla — è già pronto all'uso.

3. **Ollama nativamente supportato.** Ollama è supportato nativamente tramite reindirizzamento del provider Claude — non richiede un provider dedicato. I campi di configurazione necessari (variabili d'ambiente per-agent-group, host bloccati) sono disponibili per tutti i provider, non solo per Ollama.

4. **Nessun backup — reminder immediato.** Se l'utente sceglie "Nessun backup", il modulo fallback non si attiva. Al primo errore di quota/overload di Claude, l'utente riceve immediatamente un messaggio: "Claude ha esaurito i crediti. Puoi configurare un backup rieseguendo il setup." Il reminder viene inviato a ogni occorrenza dell'errore, senza limiti di ripetizione.

5. **Setup sempre ripetibile.** Il setup del fallback è accessibile in qualsiasi momento rieseguendo la procedura di onboarding. Mostra la configurazione attuale (provider, modello) e permette di modificare ogni scelta tramite il wizard completo.

### Scelta del modello (OpenCode + OpenRouter)

6. **Top 15 modelli live.** Viene mostrata una lista dei 15 modelli più popolari su OpenRouter, ordinati per popolarità. La lista è recuperata in tempo reale dall'API di OpenRouter.

7. **Fallback hardcoded se API non raggiungibile.** Se l'API di OpenRouter non risponde (offline, rate limit), viene mostrata una lista hardcoded di 15 modelli popolari con un avviso: "Lista non aggiornata — l'API di OpenRouter non è raggiungibile."

8. **Modello personalizzato con verifica.** L'utente può scegliere un modello non presente nella top 15 digitando liberamente l'ID. Il sistema verifica che il modello esista su OpenRouter tramite chiamata API prima di salvarlo. Se il modello non esiste, viene mostrato un errore e l'utente può riprovare.

9. **Salvataggio chiave API nel vault.** La chiave API OpenRouter viene salvata nel vault OneCLI (host-pattern `openrouter.ai`). Nessuna chiave rimane in chiaro su disco.

10. **Vault non disponibile — risoluzione automatica.** Se OneCLI non è installato o non risponde durante il salvataggio della chiave, il sistema tenta di risolvere il problema automaticamente (es. installando o riavviando OneCLI). Se la risoluzione automatica fallisce, la chiave viene salvata in chiaro nel file di configurazione con un avviso di sicurezza.

### Scelta del modello (Ollama)

11. **Auto-discovery modelli locali.** Se l'utente sceglie Ollama, il sistema tenta di interrogare il daemon Ollama locale per elencare i modelli già installati. Se il daemon risponde, i modelli vengono mostrati come opzioni selezionabili.

12. **Input manuale se discovery fallisce.** Se il daemon Ollama non risponde (non installato, non in esecuzione, rete), l'utente inserisce manualmente l'ID del modello (es. `gemma4:latest`). Non viene fatta alcuna verifica di esistenza — il modello verrà scaricato da Ollama al primo utilizzo.

13. **URL daemon configurabile.** L'URL del daemon Ollama è configurabile (default: `http://host.docker.internal:11434`). L'utente può modificarlo per puntare a un'istanza remota.

### Funzionamento del fallback

14. **Switch automatico su errore Claude.** Quando Claude restituisce un errore di quota, credito insufficiente, o overload persistente, il sistema passa automaticamente al provider di backup configurato. L'utente riceve un avviso in chat con il motivo dello switch e il provider attivo.

15. **Rientro automatico su Claude.** Il sistema tenta periodicamente di tornare su Claude (probe). Se il probe riesce, l'utente viene avvisato e il backup viene disattivato. Se fallisce, si resta sul backup con backoff crescente tra i tentativi.

16. **Nessun impatto sulle conversazioni esistenti.** Le sessioni attive continuano col provider corrente fino al prossimo messaggio. Lo switch si applica alle nuove richieste.

### Logging e audit

17. **Registrazione eventi di configurazione.** Ogni modifica alla configurazione del fallback (primo setup, cambio provider, cambio modello) viene registrata con timestamp. La chiave API non viene mai scritta nei log.

## Precondizioni di flusso

- L'onboarding del fallback avviene dopo la configurazione delle credenziali Claude. Se le credenziali Claude non sono ancora state configurate, la scelta del backup viene rimandata.
- OpenCode è preinstallato nell'immagine container — non richiede rebuild o installazione aggiuntiva.
- Ollama richiede che il daemon sia in esecuzione sulla macchina host (o su un endpoint raggiungibile). Se non lo è, l'utente può comunque configurarlo — funzionerà quando il daemon sarà disponibile.
- Il vault OneCLI deve essere accessibile per il salvataggio della chiave API OpenRouter. Se non lo è, il sistema tenta la risoluzione automatica prima di degradare.

## Risposte attese

- **Configurazione completata con successo**: Il provider di backup è attivo. `.env` contiene `FALLBACK_PROVIDER` e le variabili specifiche del provider. La chiave API è nel vault OneCLI. Un messaggio di conferma mostra il riepilogo della configurazione.

- **Nessun backup configurato**: `FALLBACK_PROVIDER` non è presente in `.env`. Il modulo fallback non si attiva. Al primo errore Claude, l'utente riceve il reminder.

- **API OpenRouter non raggiungibile**: Mostrata lista hardcoded con avviso. L'utente può comunque scegliere un modello o inserirne uno personalizzato.

- **Modello personalizzato inesistente**: Errore: "Il modello 'X' non esiste su OpenRouter. Verifica l'ID e riprova."

- **OneCLI non disponibile**: Il sistema tenta la risoluzione automatica. Se fallisce, la chiave viene salvata in chiaro con avviso: "OneCLI non disponibile. La chiave è stata salvata in chiaro. Eseguire il setup di OneCLI e ripetere la configurazione per maggiore sicurezza."

- **Setup rieseguito**: Mostra la configurazione attuale (provider, modello). L'utente può confermarla o modificarla tramite il wizard completo. Se cambia provider, la vecchia configurazione viene sostituita.

- **Ollama discovery fallita**: L'utente inserisce manualmente l'ID del modello. Nessun errore — si procede con l'input libero.

## Side effect

- **Scrittura `.env`**: Il file `.env` viene aggiornato con `FALLBACK_PROVIDER`, e le variabili specifiche del provider scelto (`OPENCODE_MODEL`, `OPENCODE_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`). Il file viene creato se non esiste.

- **Salvataggio in OneCLI vault**: Se il provider scelto richiede una chiave API, questa viene salvata nel vault OneCLI con host-pattern appropriato (`openrouter.ai` per OpenRouter).

- **Log**: Ogni evento di configurazione (scelta provider, scelta modello, salvataggio chiave) viene registrato con timestamp. Le chiavi API non compaiono mai nei log.

- **Nessuna modifica alle conversazioni attive**: Le sessioni esistenti non vengono interrotte. Lo switch si applica alle nuove richieste.

## Riferimenti di design

Nessun riferimento di design fornito — la feature è puramente configurazionale (CLI/setup), senza interfaccia grafica.
