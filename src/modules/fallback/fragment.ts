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

/** Exported so claude-md-compose.ts's preservation check can target the same file without duplicating the name. */
export const FALLBACK_FRAGMENT_NAME = 'zz-fallback.md';

export const FALLBACK_FRAGMENT_CONTENT = `## Modalità di riserva

Claude ha esaurito i limiti d'uso: stai rispondendo al suo posto su un modello di riserva. Potresti avere meno strumenti o minore capacità nel loro uso. Se non riesci a fare qualcosa, dillo apertamente — non fingere di averla portata a termine.
`;

function fragmentPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, '.claude-fragments', FALLBACK_FRAGMENT_NAME);
}

/** Writes the degradation-notice fragment for every agent group. Best-effort. */
export function writeDegradationFragmentForAllGroups(): void {
  for (const group of getAllAgentGroups()) {
    try {
      const p = fragmentPath(group.folder);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, FALLBACK_FRAGMENT_CONTENT);
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
