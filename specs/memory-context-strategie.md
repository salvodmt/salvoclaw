# Memory & Context — Strategie per SalvoClaw

Data: 2026-07-03

## Problema

Oggi ogni messaggio → SDK Claude Code rilegge l'intero transcript `.jsonl` da disco.
La conversazione cresce, i token crescono, la latenza sale.

## Tre approcci

### Fase 1 — Wiki via sistema prompt (zero codice)

Modificare `container/CLAUDE.md` con istruzioni wiki-style:
- Dopo ogni risposta, aggiornare CLAUDE.local.md con fatti/decisioni/preferenze
- CLAUDE.local.md come indice: una riga per argomento, link ai file dettaglio
- File dettaglio in /workspace/agent/memory/<argomento>.md
- Prima di ogni risposta, leggere CLAUDE.local.md

**Pro:**
- Zero codice, deploy immediato
- Funziona con qualsiasi provider (Claude, OpenCode, Ollama)
- I file sono in chiaro, investigabili con grep
- Pattern Karpathy LLM Wiki — battle-tested

**Contro:**
- L'agente principale spende token per il bookkeeping (invece che per il task reale)
- Nessuna compressione della history (transcript cresce comunque)
- L'accumulo memoria dipende dalla disciplina dell'agente (ma Claude Code è affidabile)

---

### Fase 2 — Rotazione aggressiva del transcript (codice in `claude.ts`)

Rompere il transcript dopo N scambi (non dopo 12 MB/14 giorni). Prima di archiviare:
1. Compilare un riassunto strutturato
2. Iniettarlo come primo messaggio della nuova sessione (pattern forwardBriefing già esistente)
3. Archiviare il vecchio transcript in conversations/ (investigabilità preservata)

**Pro:**
- Token ridotti del 70-90% su conversazioni lunghe
- Transcript archiviato = investigabile a posteriori
- Codice contenuto (~20 righe in claude.ts)
- Il modello riceve finestra recente + riassunto strutturato

**Contro:**
- Il riassunto è lossy — dettagli minori possono perdersi (ma l'archivio c'è)
- La soglia N va calibrata (troppo bassa = perdi contesto; troppo alta = inutile)
- Funziona solo col provider Claude (gli altri non hanno lo stesso meccanismo di resume)

---

### Fase 3 — Estrazione automatica post-risposta (codice in `poll-loop.ts`)

Dopo ogni scambio completato (hook onExchangeComplete), chiamare un modello secondario per:
1. Estrarre fatti/decisioni/contraddizioni dallo scambio
2. Aggiornare automaticamente CLAUDE.local.md e memory/

**Opzioni per il modello secondario:**
- Ollama locale con llama3.2:3b o phi3:mini (~2 GB RAM, zero costi, offline)
- OpenRouter con gpt-4o-mini (~$0.15/1M token, nessuna risorsa locale)
- Atomic Chat (skill già disponibile)

Scelta in base alla RAM del VPS: ≥8 GB → Ollama locale; <8 GB → OpenRouter.

**Pro:**
- Accumulo memoria GARANTITO (non dipende dall'agente principale)
- L'agente principale non spreca token in bookkeeping
- Modello secondario cheap/locale → costo trascurabile
- Pattern modulare: se il modello secondario fallisce, l'agente principale funziona comunque

**Contro:**
- Richiede un secondo modello (dipendenza extra)
- Se locale: consuma 2-3 GB RAM aggiuntivi
- Se remoto: richiede connettività (ma è un requisito già esistente)
- Codice ~50 righe in poll-loop.ts + nuovo file memory-extract.ts

---

## Conclusione

Le tre fasi sono complementari, non alternative:
- Fase 1 = memoria strutturata (subito, zero rischi)
- Fase 2 = compressione history (token saving)
- Fase 3 = automazione memoria (efficienza)

Ordine consigliato: Fase 1 subito → Fase 3 con Ollama se RAM VPS lo permette → Fase 2 dopo.
