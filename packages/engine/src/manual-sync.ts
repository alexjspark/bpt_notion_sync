import{auditEvent,withAuditContext}from'./audit-log.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { connectDb, query, transaction } from '@trainer/db';
import type { CompanyAdapter } from './ports.ts';
import { RetryableError } from './ports.ts';
import { NotionHttpError } from './live-notion-client.ts';
import { CompanyDomError } from './live-company-dom.ts';
import { readWithdrawalRequestSummary, WithdrawalReadError } from './withdrawal-plan.ts';
import type { CompanyWithdrawalRequestInventory, VerifiedWithdrawalStatusMapping } from './withdrawal-plan.ts';
import {
  buildManualSyncPreviewPlan, createManualSyncIdentityHasher, isManualSyncErrorCode, manualSyncKeyFingerprint, ManualSyncError,
  readManualSyncCompanySummary, readManualSyncNotionSummary,
} from './manual-sync-plan.ts';
import type { ManualSyncCompanySummary, ManualSyncErrorCode, ManualSyncNotionInventory, ManualSyncPreviewPlan } from './manual-sync-plan.ts';
export * from './manual-sync-plan.ts';

export interface ManualSyncReadiness { companyRead: boolean; notionInventoryRead: boolean }
export const UNCONNECTED_MANUAL_SYNC_READINESS: Readonly<ManualSyncReadiness> = Object.freeze({ companyRead: false, notionInventoryRead: false });
export type ManualSyncCapability = 'company_read_session' | 'notion_read_integration';
export type ManualSyncStatus = 'needs_connection' | 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';
export type ManualSyncStage = 'connection_required' | 'queued' | 'company_snapshot' | 'notion_inventory' | 'planning' | 'complete';
export interface ManualSyncRun {
  id: string;
  trainerId: string;
  requestId: string;
  mode: 'dry_run';
  status: ManualSyncStatus;
  stage: ManualSyncStage;
  attempts: number;
  progressPercent: number;
  counts: { added: number | null; skipped: number | null; failed: number | null; plannedAdds: number | null; review: number | null };
  missingCapabilities: ManualSyncCapability[];
  errorCode: string | null;
  previewPlan: ManualSyncPreviewPlan | null;
  createdAt: string;
  finishedAt: string | null;
}
interface ManualSyncRow {
  id: string; trainer_id: string; request_id: string; mode: 'dry_run'; status: ManualSyncStatus; stage: ManualSyncStage;
  attempts: number; progress_percent: number; added_count: number | null; skipped_count: number | null;
  failed_count: number | null; planned_add_count: number | null; review_count: number | null;
  missing_capabilities: ManualSyncCapability[]; error_code: string | null; preview_plan: ManualSyncPreviewPlan | null;
  created_at: Date; finished_at: Date | null;
}
export interface ClaimedManualSyncRun {
  id: string; trainerId: string; attempts: number; leaseToken: string;
  companyCheckpoint: ManualSyncCompanySummary[] | null; previewKeyFingerprint: string | null;
}
const publicColumns = `id,trainer_id,request_id,mode,status,stage,attempts,progress_percent,added_count,skipped_count,
  failed_count,planned_add_count,review_count,missing_capabilities,error_code,preview_plan,created_at,finished_at`;
const leaseSeconds = 120;
const maxAttempts = 5;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function mapRun(row: ManualSyncRow): ManualSyncRun {
  return { id: row.id, trainerId: row.trainer_id, requestId: row.request_id, mode: row.mode, status: row.status,
    stage: row.stage, attempts: row.attempts, progressPercent: row.progress_percent,
    counts: { added: row.added_count, skipped: row.skipped_count, failed: row.failed_count, plannedAdds: row.planned_add_count, review: row.review_count },
    missingCapabilities: row.missing_capabilities, errorCode: row.error_code, previewPlan: row.preview_plan,
    createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null };
}
function missingCapabilities(readiness: ManualSyncReadiness): ManualSyncCapability[] {
  return [...(readiness.companyRead !== true ? ['company_read_session' as const] : []),
    ...(readiness.notionInventoryRead !== true ? ['notion_read_integration' as const] : [])];
}
/** Callers supply server-generated UUIDs; arbitrary request strings are never stored. */
export async function queueManualSyncRun(
  trainerId: string, requestId: string, readiness: ManualSyncReadiness = UNCONNECTED_MANUAL_SYNC_READINESS,
): Promise<ManualSyncRun> {
  if (!uuidPattern.test(requestId)) throw new Error('INVALID_MANUAL_SYNC_REQUEST_ID');
  const missing = missingCapabilities(readiness);
  return transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('manual-sync-queue'),hashtext($1))`, [trainerId]);
    const replay = await client.query<ManualSyncRow>(`SELECT ${publicColumns.split(',').map(column => `r.${column.trim()}`).join(',')}
      FROM manual_sync_runs r JOIN manual_sync_requests q ON q.trainer_id=r.trainer_id AND q.run_id=r.id
      WHERE q.trainer_id=$1 AND q.request_id=$2 FOR UPDATE OF r`, [trainerId, requestId]);
    let row = replay.rows[0];
    if (!row) row = (await client.query<ManualSyncRow>(`SELECT ${publicColumns} FROM manual_sync_runs WHERE trainer_id=$1
      AND status IN ('needs_connection','queued','running','retry') FOR UPDATE`, [trainerId])).rows[0];
    if (!row) {
      row = (await client.query<ManualSyncRow>(`INSERT INTO manual_sync_runs(id,trainer_id,request_id,status,stage,missing_capabilities,error_code)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING ${publicColumns}`,
      [randomUUID(), trainerId, requestId, missing.length ? 'needs_connection' : 'queued', missing.length ? 'connection_required' : 'queued',
        JSON.stringify(missing), missing.length ? 'CONNECTION_REQUIRED' : null])).rows[0]!;
    } else if (row.status === 'needs_connection') {
      row = (await client.query<ManualSyncRow>(`UPDATE manual_sync_runs SET status=$3,stage=$4,missing_capabilities=$5::jsonb,
        error_code=$6,available_at=now(),updated_at=now() WHERE trainer_id=$1 AND id=$2 RETURNING ${publicColumns}`,
      [trainerId, row.id, missing.length ? 'needs_connection' : 'queued', missing.length ? 'connection_required' : 'queued',
        JSON.stringify(missing), missing.length ? 'CONNECTION_REQUIRED' : null])).rows[0]!;
    }
    await client.query(`INSERT INTO manual_sync_requests(trainer_id,request_id,run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [trainerId, requestId, row.id]);
    return mapRun(row);
  });
}
export async function listManualSyncRuns(trainerId: string, limit = 20): Promise<ManualSyncRun[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_MANUAL_SYNC_LIMIT');
  return (await query<ManualSyncRow>(`SELECT ${publicColumns} FROM manual_sync_runs WHERE trainer_id=$1 ORDER BY created_at DESC,id LIMIT $2`, [trainerId, limit])).rows.map(mapRun);
}
export async function getManualSyncRun(trainerId: string, runId: string): Promise<ManualSyncRun | null> {
  if (!uuidPattern.test(runId)) return null;
  const row = (await query<ManualSyncRow>(`SELECT ${publicColumns} FROM manual_sync_runs WHERE trainer_id=$1 AND id=$2`, [trainerId, runId])).rows[0];
  return row ? mapRun(row) : null;
}

/** An explicit caller must run this queue; existing mock worker ticks never invoke it. */
export async function claimManualSyncRun(trainerId?: string): Promise<ClaimedManualSyncRun | null> {
  return transaction(async client => {
    await client.query(`UPDATE manual_sync_runs SET status=CASE WHEN attempts >= $1 THEN 'failed' ELSE 'retry' END,
      available_at=now(),lease_until=NULL,lease_token=NULL,error_code='WORKER_INTERRUPTED',updated_at=now(),
      finished_at=CASE WHEN attempts >= $1 THEN now() ELSE NULL END
      WHERE status='running' AND lease_until<now() AND ($2::text IS NULL OR trainer_id=$2)`, [maxAttempts, trainerId ?? null]);
    const row = (await client.query<{ id: string; trainer_id: string; attempts: number; company_checkpoint: ManualSyncCompanySummary[] | null; preview_key_fingerprint: string | null }>(
      `SELECT id,trainer_id,attempts,company_checkpoint,preview_key_fingerprint FROM manual_sync_runs
       WHERE status IN ('queued','retry') AND available_at<=now() AND ($1::text IS NULL OR trainer_id=$1)
       ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [trainerId ?? null])).rows[0];
    if (!row) return null;
    const leaseToken = randomUUID();
    await client.query(`UPDATE manual_sync_runs SET status='running',attempts=attempts+1,lease_token=$2,
      lease_until=now()+$3::int*interval '1 second',error_code=NULL,updated_at=now() WHERE id=$1`, [row.id, leaseToken, leaseSeconds]);
    return { id: row.id, trainerId: row.trainer_id, attempts: row.attempts + 1, leaseToken,
      companyCheckpoint: row.company_checkpoint, previewKeyFingerprint: row.preview_key_fingerprint };
  });
}
const fence = `trainer_id=$1 AND id=$2 AND attempts=$3 AND lease_token=$4 AND status='running' AND lease_until>=now()`;
function fenceValues(run: ClaimedManualSyncRun): unknown[] { return [run.trainerId, run.id, run.attempts, run.leaseToken]; }
async function execute(client: PoolClient | undefined, sql: string, values: unknown[]) {
  return client ? client.query(sql, values) : query(sql, values);
}
export async function assertManualSyncLease(run: ClaimedManualSyncRun, client?: PoolClient): Promise<void> {
  if (!(await execute(client, `SELECT 1 FROM manual_sync_runs WHERE ${fence}`, fenceValues(run))).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
export async function renewManualSyncLease(run: ClaimedManualSyncRun, client?: PoolClient): Promise<void> {
  if (!(await execute(client, `UPDATE manual_sync_runs SET lease_until=now()+$5::int*interval '1 second',updated_at=now()
    WHERE ${fence} RETURNING id`, [...fenceValues(run), leaseSeconds])).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
/** One connection owns the session lock and every preview query; autocommit keeps progress durable. */
export async function withManualSyncExecutionLock<T>(run: ClaimedManualSyncRun, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectDb();
  let acquired = false;
  let discard = false;
  try {
    const locked = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('trainer-sync-execution'),hashtext($1)) AS locked`, [run.trainerId]);
    acquired = locked.rows[0]?.locked === true;
    if (!acquired) throw new ManualSyncError('EXECUTION_BUSY', true, 1000);
    await assertManualSyncLease(run, client);
    return await fn(client);
  } finally {
    if (acquired) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(`SELECT pg_advisory_unlock(hashtext('trainer-sync-execution'),hashtext($1)) AS unlocked`, [run.trainerId]);
        discard = unlocked.rows[0]?.unlocked !== true;
      } catch { discard = true; }
    }
    // Never return a connection with an uncertain session-lock state to the pool.
    client.release(discard);
  }
}
async function progress(run: ClaimedManualSyncRun, stage: ManualSyncStage, percent: number, client: PoolClient): Promise<void> {
  if (!(await execute(client, `UPDATE manual_sync_runs SET stage=$5,progress_percent=$6,updated_at=now() WHERE ${fence} RETURNING id`,
    [...fenceValues(run), stage, percent])).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
async function saveCompanyCheckpoint(run: ClaimedManualSyncRun, summary: ManualSyncCompanySummary[], fingerprint: string, client: PoolClient): Promise<void> {
  if (!(await execute(client, `UPDATE manual_sync_runs SET company_checkpoint=$5::jsonb,preview_key_fingerprint=$6,
    stage='notion_inventory',progress_percent=45,updated_at=now() WHERE ${fence} RETURNING id`,
  [...fenceValues(run), JSON.stringify(summary), fingerprint])).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
async function blockForConnection(run: ClaimedManualSyncRun, missing: ManualSyncCapability[], client: PoolClient): Promise<void> {
  if (!(await execute(client, `UPDATE manual_sync_runs SET status='needs_connection',stage='connection_required',progress_percent=0,
    missing_capabilities=$5::jsonb,error_code='CONNECTION_REQUIRED',lease_until=NULL,lease_token=NULL,
    company_checkpoint=NULL,preview_key_fingerprint=NULL,updated_at=now() WHERE ${fence} RETURNING id`,
  [...fenceValues(run), JSON.stringify(missing)])).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
async function finishPreview(run: ClaimedManualSyncRun, plan: ManualSyncPreviewPlan, client: PoolClient): Promise<void> {
  const counts = plan.members.reduce((value, member) => {
    if (member.decision === 'planned_add') value.plannedAdds++;
    else if (member.decision === 'skip') value.skipped++;
    else if (member.decision === 'review') value.review++;
    return value;
  }, { plannedAdds: 0, skipped: 0, review: 0 });
  if (!(await execute(client, `UPDATE manual_sync_runs SET status='succeeded',stage='complete',progress_percent=100,
    added_count=0,failed_count=0,skipped_count=$5,planned_add_count=$6,review_count=$7,preview_plan=$8::jsonb,
    company_checkpoint=NULL,preview_key_fingerprint=NULL,missing_capabilities='[]'::jsonb,error_code=NULL,
    lease_until=NULL,lease_token=NULL,finished_at=now(),updated_at=now() WHERE ${fence} RETURNING id`,
  [...fenceValues(run), counts.skipped, counts.plannedAdds, counts.review + (plan.unresolvedNotionRows ?? 0), JSON.stringify(plan)])).rowCount) throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST');
}
export function manualSyncSafeFailure(error: unknown): { code: ManualSyncErrorCode; retryable: boolean; retryAfterMs: number } {
  if (error instanceof WithdrawalReadError && isManualSyncErrorCode(error.code)) return { code: error.code, retryable: error.retryable === true, retryAfterMs: 0 };
  if ((error instanceof NotionHttpError && (error.status === 401 || error.status === 403))
    || (error instanceof CompanyDomError && error.code === 'COMPANY_AUTH_REQUIRED')) {
    return { code: 'READ_AUTH_REQUIRED', retryable: false, retryAfterMs: 0 };
  }
  if(error instanceof CompanyDomError && isManualSyncErrorCode(error.code)) return {code:error.code,retryable:error.code==='COMPANY_SNAPSHOT_CHANGED',retryAfterMs:0};
  if (error instanceof ManualSyncError && isManualSyncErrorCode(error.code)) return { code: error.code, retryable: error.retryable === true,
    retryAfterMs: Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0 };
  if (error instanceof RetryableError) return { code: error.retryAfterMs > 0 ? 'READ_RATE_LIMITED' : 'READ_RETRYABLE', retryable: true,
    retryAfterMs: Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0 };
  // Raw provider messages can contain names, request URLs, cookies or tokens.
  return { code: 'READ_FAILED', retryable: true, retryAfterMs: 0 };
}
async function failPreview(run: ClaimedManualSyncRun, error: unknown): Promise<void> {
  const failure = manualSyncSafeFailure(error);
  if (failure.code === 'MANUAL_SYNC_LEASE_LOST') return;
  const terminal = !failure.retryable || run.attempts >= maxAttempts;await auditEvent({runId:run.id,runKind:'preview',accountId:run.trainerId,attempt:run.attempts,retryCount:Math.max(0,run.attempts-1),stage:terminal?'error':'retry',outcome:terminal?'failed':'held',errorCode:failure.code});
  const delay = Math.max(Math.min(300000, 1000 * 2 ** Math.max(0, run.attempts - 1)), Math.min(86400000, failure.retryAfterMs));
  // A stale worker cannot change the state or overwrite a newer attempt's result.
  await query(`UPDATE manual_sync_runs SET status=$5,error_code=$6,available_at=now()+$7::int*interval '1 millisecond',
    lease_until=NULL,lease_token=NULL,finished_at=CASE WHEN $8 THEN now() ELSE NULL END,updated_at=now()
    WHERE ${fence}`, [...fenceValues(run), terminal ? 'failed' : 'retry', failure.code, delay, terminal]);
}
export interface ManualSyncWorkerOptions {
  trainerId?: string;
  readiness?: ManualSyncReadiness | ((trainerId: string) => Promise<ManualSyncReadiness>);
  company?: CompanyAdapter;
  notion?: ManualSyncNotionInventory;
  withdrawalRequests?: CompanyWithdrawalRequestInventory;
  verifyCompanyAccount?:()=>Promise<void>;
  /** In-memory evidence issued from a fresh official schema; no Boolean/env flag can grant it. */
  withdrawalStatusMapping?: VerifiedWithdrawalStatusMapping;
  /** Inject an approved secret with >=32 bytes. It is never read from env or persisted. */
  previewHmacKey?: string | Uint8Array;
}
/** Read-only preview only. No apply option, write adapter, credential lookup, HTTP client or scheduling hook exists. */
export async function runManualSyncOnce(options: ManualSyncWorkerOptions = {}): Promise<boolean> {
  const run = await claimManualSyncRun(options.trainerId);
  if (!run) return false;
  return withAuditContext({runId:run.id,runKind:'preview',accountId:run.trainerId,attempt:run.attempts},async()=>{const auditStarted=Date.now();await auditEvent({stage:'claim',outcome:'succeeded',provider:'local',operation:'execute',retryCount:Math.max(0,run.attempts-1)});
  try {
    await withManualSyncExecutionLock(run, async client => {
      let leaseError: unknown;
      let renewal = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewal = renewal.then(() => renewManualSyncLease(run, client)).catch(error => { leaseError = error; });
      }, 20000);
      const guard = async () => { if (leaseError) throw leaseError; await assertManualSyncLease(run, client); };
      try {
        const configured = typeof options.readiness === 'function' ? await options.readiness(run.trainerId) : options.readiness ?? UNCONNECTED_MANUAL_SYNC_READINESS;
        const readiness = { companyRead: configured.companyRead === true && !!options.company, notionInventoryRead: configured.notionInventoryRead === true && !!options.notion };
        const missing = missingCapabilities(readiness);
        if (missing.length) { await blockForConnection(run, missing, client); return; }
        if (!options.previewHmacKey) throw new ManualSyncError('PREVIEW_KEY_REQUIRED');
        const fingerprint = manualSyncKeyFingerprint(options.previewHmacKey);
        const hashIdentity = createManualSyncIdentityHasher(run.trainerId, options.previewHmacKey);
        let companySummary = run.previewKeyFingerprint === fingerprint ? run.companyCheckpoint : null;
        if (!companySummary) {
          await progress(run, 'company_snapshot', 10, client);
          const companyStarted=Date.now();await auditEvent({stage:'collect',outcome:'started',provider:'company',operation:'execute'});
          companySummary = await readManualSyncCompanySummary(options.company!, run.trainerId, hashIdentity, guard);
          await auditEvent({stage:'collect',outcome:'succeeded',provider:'company',operation:'execute',durationMs:Date.now()-companyStarted,counts:{members:companySummary.length}});
          await saveCompanyCheckpoint(run, companySummary, fingerprint, client);
        } else { await progress(run, 'notion_inventory', 45, client); }
        const withdrawalRequests = options.withdrawalRequests ? await readWithdrawalRequestSummary(options.withdrawalRequests, run.trainerId, hashIdentity, guard) : undefined;
        const notionStarted=Date.now();await auditEvent({stage:'collect',outcome:'started',provider:'notion',operation:'read'});
        const notionSummary = await readManualSyncNotionSummary(options.notion!, run.trainerId, hashIdentity, guard);
        await auditEvent({stage:'collect',outcome:'succeeded',provider:'notion',operation:'read',durationMs:Date.now()-notionStarted});
        await progress(run, 'planning', 85, client);await auditEvent({stage:'plan',outcome:'started',operation:'transform'});
        const plan = buildManualSyncPreviewPlan(companySummary, notionSummary, { withdrawalRequests,
          withdrawalStatusMapping: options.withdrawalStatusMapping });
        await auditEvent({stage:'plan',outcome:'succeeded',operation:'transform',counts:{members:plan.companyCount,mapped:plan.notionIdentityCount,held:plan.unresolvedNotionRows??0}});if(plan.unresolvedNotionRows)await auditEvent({stage:'map',outcome:'held',fields:['adminUrl'],reasonCode:'UNRESOLVED_UID',counts:{held:plan.unresolvedNotionRows}});
        await guard();
        await options.verifyCompanyAccount?.();
        await finishPreview(run, plan, client);
      } finally { clearInterval(heartbeat); await renewal; }
    });
  } catch (error) { await failPreview(run, error); }
  const latest=await getManualSyncRun(run.trainerId,run.id);if(latest?.status==='succeeded')await auditEvent({stage:'complete',outcome:'succeeded',durationMs:Date.now()-auditStarted,counts:{saved:0,held:latest.counts.review??0}});else if(latest?.status==='needs_connection')await auditEvent({stage:'complete',outcome:'held',reasonCode:'NOT_CONNECTED',durationMs:Date.now()-auditStarted});
  return true;
  });
}
