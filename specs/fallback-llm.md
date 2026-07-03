# Spec: Fallback automatico a un LLM di riserva

> Data: 2 luglio 2026 — spec prodotta con Claude Fable 5 via skill crea-spec.
> Analisi di fattibilità di riferimento: `analisi-fallback-llm.md` (Opzione A).

## Scopo

Quando l'account Claude esaurisce i propri limiti d'uso (quota dell'abbonamento, credito, o indisponibilità del servizio), l'assistente continua a funzionare passando automaticamente a un modello di riserva, avvisando l'owner dello switch, e torna a Claude appena i limiti si resettano — senza perdere il filo della conversazione in nessuna delle due direzioni e senza mai lasciare l'owner nel silenzio.

## Ruoli e permessi

L'installazione è personale: l'owner è al tempo stesso utente e amministratore. Tutte le comunicazioni — avvisi di switch, avvisi di limiti, dettagli tecnici dei guasti — arrivano nella conversazione in corso (Telegram), senza canali separati. I comandi di controllo (stato, forza fallback, forza rientro) si impartiscono direttamente dalla chat e sono riservati all'owner, secondo le regole di autorizzazione già esistenti nel sistema. La configurazione del fallback è unica e globale per l'installazione.

## Regole di business

1. **Condizioni che attivano il fallback.** Il passaggio al modello di riserva scatta quando Claude segnala una di queste condizioni: **quota dell'abbonamento esaurita** (limite a finestra temporale, orario di reset generalmente noto); **credito o fatturazione esauriti** (non si risolve da solo); **servizio Anthropic sovraccarico** in modo persistente (i tentativi automatici interni non bastano).

2. **Condizioni che NON attivano il fallback.** I rallentamenti temporanei per eccesso di richieste al minuto restano gestiti come oggi (nuovi tentativi automatici in attesa): non causano switch.

3. **Portata dello switch.** Quando il fallback si attiva vale per tutta l'installazione: ogni assistente e ogni conversazione — comprese le attività programmate — usa il modello di riserva finché dura il fallback.

4. **Messaggio in lavorazione.** Il messaggio che era in elaborazione quando è scattato il limite viene ripresentato automaticamente al modello di riserva: l'owner riceve comunque la risposta senza dover rimandare nulla.

5. **Continuità del contesto verso il fallback.** Alla prima risposta sul modello di riserva, questo riceve un riassunto degli scambi recenti della conversazione. Il riassunto è prodotto **senza dipendere dal modello caduto**: dagli archivi di conversazione già registrati su disco oppure, in subordine, dal modello di riserva stesso. Il modello di riserva ha inoltre accesso alla stessa memoria persistente dell'assistente (preferenze, fatti, file di lavoro).

6. **Degradazione dichiarata.** È accettato che il modello di riserva abbia capacità inferiori a Claude (strumenti o skill non disponibili, minore abilità nell'uso degli strumenti). In tal caso l'assistente deve dichiarare apertamente cosa non riesce a fare, mai fingere di averlo fatto.

7. **Rientro su Claude — reset noto.** Se l'orario di reset dei limiti è noto, dal primo messaggio successivo a quell'orario si riprova Claude. Se il tentativo riesce si rientra; se fallisce si resta sul fallback e si riprogramma il tentativo.

8. **Rientro su Claude — reset ignoto.** Se l'orario di reset non è noto (credito esaurito, sovraccarico), si riprova Claude a intervalli crescenti (pochi minuti all'inizio, poi sempre più distanziati fino a un tetto massimo), rientrando appena un tentativo riesce.

9. **Continuità del contesto al rientro.** Al primo turno dopo il rientro, Claude riceve un riassunto degli scambi avvenuti durante il periodo di fallback, così la conversazione non presenta buchi di memoria.

10. **Anti ping-pong.** Un tentativo di rientro fallito non genera avvisi: l'avviso di rientro viene dato solo a rientro riuscito.

11. **Fallback non configurato o disattivato.** Se i limiti si esauriscono e non c'è un modello di riserva utilizzabile, l'owner riceve subito un messaggio chiaro in chat: limiti esauriti e — quando noto — orario di reset. Mai silenzio, mai un generico "problema tecnico".

12. **Persistenza dello stato.** Lo stato di fallback (attivo/non attivo, motivo, automatico o forzato, orario del prossimo tentativo di rientro) sopravvive ai riavvii: dopo un riavvio il sistema riprende nello stato in cui era.

13. **Controllo manuale.** L'owner può in ogni momento, dalla chat: consultare lo stato, forzare il passaggio al fallback (test, risparmio quota), forzare il rientro su Claude. Un fallback forzato manualmente non rientra da solo: resta attivo finché l'owner non lo disattiva.

14. **Modello di riserva.** Il canale di riserva è OpenCode con OpenRouter (richiede una chiave API OpenRouter). Nessun modello è fissato di default: la scelta del modello è dell'owner al momento della configurazione, e resta modificabile.

15. **Garanzia di risposta.** Ogni messaggio che attiva l'assistente produce sempre, entro **10 minuti**, una di queste due cose: la risposta (da Claude o dal modello di riserva) oppure l'avviso di limiti esauriti. Il silenzio prolungato non è mai un esito ammesso. Se Claude non porta a termine il turno entro il tempo massimo perché bloccato in attese o ritentativi interni dovuti ai limiti, il turno viene interrotto e trattato come limite raggiunto: scatta il fallback (o l'avviso, se il fallback non è disponibile). La garanzia copre anche il riavvio a metà elaborazione: i messaggi rimasti in sospeso seguono la stessa regola e non vengono ripresentati in silenzio a un modello ancora a limiti esauriti.

16. **Integrazioni esterne invarianti.** Il passaggio al modello di riserva (e il rientro) non modifica le connessioni agli strumenti esterni (GitHub, Gmail, Calendar, ecc.): il modello di riserva dispone dello stesso insieme di strumenti e le credenziali dei servizi esterni restano gestite dal gateway dedicato, indipendente dal modello attivo. Nessuna ri-autenticazione o riconfigurazione è richiesta per effetto dello switch.

## Precondizioni di flusso

- Il fallback automatico presuppone provider di riserva installato, configurato e con credenziali valide; la verifica avviene al momento dello switch. Se mancano, si applicano la regola 11 e la gestione del doppio guasto (vedi Risposte attese).
- Il rientro automatico presuppone che il fallback sia stato attivato automaticamente: un fallback forzato a mano esce solo a mano (regola 13).
- Un comando di rientro impartito mentre Claude è ancora a limiti esauriti viene tentato comunque; se fallisce, l'owner riceve l'esito e il sistema resta sul fallback.

## Risposte attese

- **Switch riuscito (andata):** avviso breve in chat ("Limiti Claude raggiunti, passo a *nome modello*", con orario di reset se noto), seguito dalla normale risposta al messaggio in sospeso prodotta dal modello di riserva.
- **Rientro riuscito:** avviso breve di rientro su Claude; la conversazione prosegue normalmente.
- **Limiti esauriti senza fallback disponibile:** avviso immediato con motivo e orario di reset quando noto.
- **Doppio guasto (anche il fallback fallisce):** un unico messaggio in chat con errore comprensibile **e** dettaglio tecnico. L'avviso chiude la partita: il messaggio originale è considerato gestito e non viene rielaborato a sorpresa più tardi; se l'owner vuole ancora quella risposta, lo rimanda.
- **Comando da parte di un non-owner:** rifiutato secondo le regole di autorizzazione già esistenti.
- **Consultazione stato:** modello attualmente attivo, fallback automatico o forzato, motivo dello switch, da quando è attivo, orario del prossimo tentativo di rientro.

## Side effect

- **Avvisi in conversazione:** a ogni switch (andata e ritorno riuscito). Se l'invio dell'avviso fallisce, lo switch avviene comunque: l'avviso non è bloccante.
- **Riassunto di andata:** generato al momento dello switch dagli archivi di conversazione; se la generazione fallisce, lo switch procede senza riassunto (meglio una risposta senza contesto che nessuna risposta) e l'evento viene registrato.
- **Riassunto di ritorno:** generato dagli scambi avvenuti sul fallback; stessa politica di non-bloccaggio.
- **Registrazione:** ogni switch (automatico o manuale), ogni tentativo di rientro, ogni turno interrotto per timeout e ogni fallimento vengono registrati con motivo e orario, per diagnosi a posteriori.

## Riferimenti di design

La feature non ha interfaccia grafica — gli avvisi sono normali messaggi in chat. Nessun riferimento di design fornito — la review di design non sarà applicabile a questa feature.
