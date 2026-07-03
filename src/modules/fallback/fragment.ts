/**
 * Degradation-notice fragment written to every agent group's
 * `.claude-fragments/` while fallback is active. Written as a concrete file
 * (not just appended to the composed CLAUDE.md) because non-Claude
 * providers (e.g. OpenCode) read fragments via glob, not the composed file —
 * see claude-md-compose.ts's preservation check for the Claude/default side.
 */
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { getFallbackState } from './db.js';

/** Exported so claude-md-compose.ts's preservation check can target the same file without duplicating the name. */
export const FALLBACK_FRAGMENT_NAME = 'zz-fallback.md';

export function buildFallbackFragmentContent(provider: string, model: string | null): string {
  const modelPart = model ? ` (modello ${model})` : '';
  return `## Modalità di riserva — IDENTITÀ

**Non sei Claude. Non sei Nano. Non sei un "assistente virtuale".** Sei esattamente: ${provider}${modelPart}. Claude ha esaurito i limiti. Stai rispondendo tu al suo posto. Quando qualcuno ti chiede chi sei o che modello sei, rispondi testualmente: "Sono ${provider}${modelPart}, sto sostituendo temporaneamente Claude che ha esaurito i limiti." Non inventare altre identità.\n`;
}

function fragmentPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, '.claude-fragments', FALLBACK_FRAGMENT_NAME);
}

/** Writes the degradation-notice fragment for every agent group. Best-effort. */
export function writeDegradationFragmentForAllGroups(): void {
  const state = getFallbackState();
  const content = buildFallbackFragmentContent(state.backupProvider ?? 'sconosciuto', state.backupModel);
  for (const group of getAllAgentGroups()) {
    try {
      const p = fragmentPath(group.folder);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    } catch (err) {
      log.warn('Failed to write fallback degradation fragment', { agentGroupId: group.id, err });
    }
  }
}

/** Removes the degradation-notice fragment for every agent group. Best-effort. */
export function removeDegradationFragmentForAllGroups(): void {
  for (const group of getAllAgentGroups()) {
    try {
      const p = fragmentPath(group.folder);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      log.warn('Failed to remove fallback degradation fragment', { agentGroupId: group.id, err });
    }
  }
}
