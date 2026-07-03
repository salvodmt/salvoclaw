/**
 * `fallback_state` accessors — single-row (id=1) global state.
 *
 * No caching: every function reads/writes the row directly. The row is tiny,
 * writes are rare (one per switch/probe/retry), and direct reads mean a host
 * restart trivially resumes in whatever state the DB says — no in-memory
 * state to reconcile on boot.
 */
import { getDb } from '../../db/connection.js';

export type FallbackMode = 'auto' | 'forced';
export type FallbackClassification = 'quota' | 'billing' | 'overload' | 'timeout' | 'manual';

export interface FallbackState {
  active: boolean;
  mode: FallbackMode | null;
  classification: FallbackClassification | null;
  reason: string | null;
  backupProvider: string | null;
  enteredAt: string | null;
  resetAt: string | null;
  nextRetryAt: string | null;
  retryCount: number;
  probing: boolean;
  probeMessageId: string | null;
  probeSessionId: string | null;
  probeStartedAt: string | null;
  originSessionId: string | null;
  originGroupId: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface FallbackStateRow {
  active: number;
  mode: string | null;
  classification: string | null;
  reason: string | null;
  backup_provider: string | null;
  entered_at: string | null;
  reset_at: string | null;
  next_retry_at: string | null;
  retry_count: number;
  probing: number;
  probe_message_id: string | null;
  probe_session_id: string | null;
  probe_started_at: string | null;
  origin_session_id: string | null;
  origin_group_id: string | null;
  last_error: string | null;
  updated_at: string;
}

function rowToState(row: FallbackStateRow): FallbackState {
  return {
    active: row.active === 1,
    mode: row.mode as FallbackMode | null,
    classification: row.classification as FallbackClassification | null,
    reason: row.reason,
    backupProvider: row.backup_provider,
    enteredAt: row.entered_at,
    resetAt: row.reset_at,
    nextRetryAt: row.next_retry_at,
    retryCount: row.retry_count,
    probing: row.probing === 1,
    probeMessageId: row.probe_message_id,
    probeSessionId: row.probe_session_id,
    probeStartedAt: row.probe_started_at,
    originSessionId: row.origin_session_id,
    originGroupId: row.origin_group_id,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

/** Reads the single global row. Always present — seeded by the migration. */
export function getFallbackState(): FallbackState {
  const row = getDb().prepare('SELECT * FROM fallback_state WHERE id = 1').get() as FallbackStateRow;
  return rowToState(row);
}

export interface EnterFallbackParams {
  mode: FallbackMode;
  classification: FallbackClassification;
  reason: string;
  backupProvider: string;
  resetAt: string | null;
  originSessionId: string | null;
  originGroupId: string | null;
}

/** Switches the install to the backup provider. Resets retry bookkeeping. */
export function enterFallbackState(params: EnterFallbackParams): FallbackState {
  getDb()
    .prepare(
      `UPDATE fallback_state SET
         active = 1,
         mode = @mode,
         classification = @classification,
         reason = @reason,
         backup_provider = @backupProvider,
         entered_at = datetime('now'),
         reset_at = @resetAt,
         next_retry_at = NULL,
         retry_count = 0,
         probing = 0,
         probe_message_id = NULL,
         probe_session_id = NULL,
         probe_started_at = NULL,
         origin_session_id = @originSessionId,
         origin_group_id = @originGroupId,
         last_error = NULL,
         updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run(params);
  return getFallbackState();
}

/** Returns the install to the native provider. Clears all switch bookkeeping. */
export function clearFallbackState(): FallbackState {
  getDb()
    .prepare(
      `UPDATE fallback_state SET
         active = 0,
         mode = NULL,
         classification = NULL,
         reason = NULL,
         backup_provider = NULL,
         entered_at = NULL,
         reset_at = NULL,
         next_retry_at = NULL,
         retry_count = 0,
         probing = 0,
         probe_message_id = NULL,
         probe_session_id = NULL,
         probe_started_at = NULL,
         origin_session_id = NULL,
         origin_group_id = NULL,
         last_error = NULL,
         updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run();
  return getFallbackState();
}

export interface SetProbeParams {
  probing: boolean;
  probeMessageId: string | null;
  probeSessionId: string | null;
  probeStartedAt: string | null;
}

/** Marks (or clears) an in-flight return-to-native probe attempt. */
export function setProbe(params: SetProbeParams): FallbackState {
  getDb()
    .prepare(
      `UPDATE fallback_state SET
         probing = @probing,
         probe_message_id = @probeMessageId,
         probe_session_id = @probeSessionId,
         probe_started_at = @probeStartedAt,
         updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run({ ...params, probing: params.probing ? 1 : 0 });
  return getFallbackState();
}

/** Records a failed return attempt and schedules the next one. */
export function bumpRetry(nextRetryAt: string): FallbackState {
  getDb()
    .prepare(
      `UPDATE fallback_state SET
         retry_count = retry_count + 1,
         next_retry_at = @nextRetryAt,
         probing = 0,
         probe_message_id = NULL,
         probe_session_id = NULL,
         probe_started_at = NULL,
         updated_at = datetime('now')
       WHERE id = 1`,
    )
    .run({ nextRetryAt });
  return getFallbackState();
}

/** Records the last error seen (diagnostics only — doesn't change active/mode). */
export function setLastError(message: string): void {
  getDb()
    .prepare(`UPDATE fallback_state SET last_error = @message, updated_at = datetime('now') WHERE id = 1`)
    .run({ message });
}
