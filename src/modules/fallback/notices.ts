/**
 * Pure, snapshot-testable Italian text for every fallback-visible chat
 * notice. No side effects, no DB/IO — callers decide where the text goes.
 */
import type { FallbackClassification, FallbackState } from './db.js';

function reasonLabel(classification: FallbackClassification | null): string {
  switch (classification) {
    case 'quota':
      return 'quota esaurita';
    case 'billing':
      return 'credito esaurito';
    case 'overload':
      return 'servizio sovraccarico';
    case 'timeout':
      return 'nessuna risposta entro il tempo massimo';
    case 'manual':
      return 'richiesta manuale';
    default:
      return 'motivo sconosciuto';
  }
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Rule: automatic switch to the backup provider. */
export function switchAutoNotice(
  classification: FallbackClassification,
  backupProvider: string,
  resetAt: string | null,
): string {
  const reset = formatResetAt(resetAt);
  const resetPart = reset ? ` Reset previsto: ${reset}.` : '';
  return `⚠️ Claude ha esaurito i limiti (${reasonLabel(classification)}). Passo a ${backupProvider}.${resetPart}`;
}

/** Rule 13: owner-forced switch, never auto-returns. */
export function switchForcedNotice(backupProvider: string): string {
  return `🔧 Fallback forzato manualmente su ${backupProvider}.`;
}

/** Rule 11: limits hit and no backup configured — message left failed, not silently re-presented. */
export function noBackupNotice(classification: FallbackClassification, resetAt: string | null): string {
  const reset = formatResetAt(resetAt);
  const resetPart = reset ? ` Reset previsto: ${reset}.` : '';
  return `⚠️ Claude ha esaurito i limiti (${reasonLabel(classification)}) e non c'è un modello di riserva disponibile.${resetPart} Rimandami il messaggio più tardi.`;
}

/** Successful return to the native provider. */
export function returnNotice(): string {
  return '✅ Sono tornato su Claude.';
}

/** Both fallback and the return probe/backup are stuck — no further auto-retry loop. */
export function doubleFaultNotice(): string {
  return '⚠️ Anche il modello di riserva non ha risposto in tempo. Riprova più tardi.';
}

export function commandDeniedNotice(): string {
  return 'Solo owner o admin possono usare i comandi /fallback.';
}

/** Rule 6: the assistant must declare, not pretend, when running on the backup model. */
export function forwardBriefing(summary: string | null): string {
  const base =
    'Sto rispondendo al posto di Claude, che ha esaurito i limiti — potrei avere meno strumenti o abilità a disposizione. Se non riesco a fare qualcosa te lo dico apertamente, non fingo.';
  return summary ? `${base}\n\nRiassunto della conversazione recente:\n${summary}` : base;
}

/** Rule 9: briefing sent to the return-probe attempt; doubles as the return summary on success. */
export function returnBriefing(summary: string | null): string {
  const base = 'Riprovo a rispondere io, Claude — verifico se i limiti sono di nuovo disponibili.';
  return summary
    ? `${base}\n\nNel frattempo, riassunto degli scambi avvenuti sul modello di riserva:\n${summary}`
    : base;
}

/** Short wake-up nudge for other agent groups restarted alongside a switch/return (not the origin conversation). */
export function shortSwitchBriefing(backupProvider: string): string {
  return `Sto rispondendo al posto di Claude (limiti esauriti) su ${backupProvider}. Se non riesco a fare qualcosa te lo dico apertamente, non fingo.`;
}

export function shortReturnBriefing(): string {
  return 'Sono di nuovo Claude.';
}

export function statusNotice(state: FallbackState): string {
  if (!state.active) {
    return 'Modello attivo: Claude. Fallback non attivo.';
  }
  const modeLabel = state.mode === 'forced' ? 'forzato' : 'automatico';
  const lines = [
    `Modello attivo: ${state.backupProvider} (fallback ${modeLabel}).`,
    `Motivo: ${reasonLabel(state.classification)}.`,
  ];
  if (state.enteredAt) lines.push(`Da: ${state.enteredAt}.`);
  if (state.mode === 'auto') {
    const nextAttempt = formatResetAt(state.nextRetryAt ?? state.resetAt);
    lines.push(
      nextAttempt
        ? `Prossimo tentativo di rientro: ${nextAttempt}.`
        : 'Prossimo tentativo di rientro: non ancora programmato.',
    );
  } else {
    lines.push('Rientro solo manuale (`/fallback return`).');
  }
  return lines.join('\n');
}
