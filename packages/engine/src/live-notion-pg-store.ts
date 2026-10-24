import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { connectDb, query } from '@trainer/db';
import { NotionReviewRequiredError } from './live-notion-client.ts';
import type { NotionManagedState, NotionManagedStateStore, NotionPlanOperation } from './live-notion-types.ts';

const OPERATIONS = new Set<NotionPlanOperation['kind']>([
  'create-member', 'personalize-block', 'rename-child-page', 'append-survey', 'update-survey', 'create-calendar', 'update-calendar',
]);
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
interface Snapshot { state: NotionManagedState | undefined; revision: number }
interface LockContext {
  client: PoolClient;
  key: string;
  active: boolean;
  lost: boolean;
  snapshots: Map<string, Snapshot>;
}
interface StateRow { state: unknown; revision: string }
function fail(code: string): never { throw new NotionReviewRequiredError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('NOTION_MANAGED_STATE_INVALID');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) fail('NOTION_MANAGED_STATE_INVALID');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) return fail('NOTION_MANAGED_STATE_INVALID');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) return fail('NOTION_MANAGED_STATE_INVALID');
  return value;
}
/** Copies an explicit allowlist: raw content, credentials, configuration and arbitrary metadata are rejected. */
function checkedState(input: unknown, calendar: boolean): NotionManagedState {
  const source = record(input);
  only(source, calendar ? ['revision', 'pageId', 'pendingWrite'] : ['revision', 'pageId', 'pendingWrite', 'surveyBlocks', 'personalizedBlocks']);
  const state: NotionManagedState = {};
  if (Object.hasOwn(source, 'revision')) {
    if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 0) fail('NOTION_MANAGED_STATE_INVALID');
    state.revision = source.revision as number;
  }
  if (Object.hasOwn(source, 'pageId')) state.pageId = identifier(source.pageId);
  if (Object.hasOwn(source, 'pendingWrite')) {
    const pending = record(source.pendingWrite); only(pending, ['operation']);
    const operation = pending.operation as NotionPlanOperation['kind'];
    if (!OPERATIONS.has(operation) || operation.endsWith('calendar') !== calendar) fail('NOTION_MANAGED_STATE_INVALID');
    state.pendingWrite = { operation };
  }
  if (Object.hasOwn(source, 'surveyBlocks')) {
    const blocks = record(source.surveyBlocks);
    state.surveyBlocks = Object.fromEntries(Object.entries(blocks).map(([key, raw]) => {
      if (!/^(?:0|[1-9][0-9]{0,5})$/.test(key)) fail('NOTION_MANAGED_STATE_INVALID');
      const block = record(raw); only(block, ['blockId', 'fingerprint']);
      return [key, { blockId: identifier(block.blockId), fingerprint: hash(block.fingerprint) }];
    }));
  }
  if (Object.hasOwn(source, 'personalizedBlocks')) {
    const blocks = record(source.personalizedBlocks);
    state.personalizedBlocks = Object.fromEntries(Object.entries(blocks).map(([key, raw]) => {
      identifier(key);
      const block = record(raw); only(block, ['originalFingerprint', 'currentFingerprint']);
      return [key, { originalFingerprint: hash(block.originalFingerprint), currentFingerprint: hash(block.currentFingerprint) }];
    }));
  }
  return state;
}
function checkpointBody(state: NotionManagedState): Omit<NotionManagedState, 'pendingWrite' | 'revision'> {
  const { pendingWrite: _pending, revision: _revision, ...body } = state;
  return body;
}
function transition(previous: NotionManagedState | undefined, next: NotionManagedState): void {
  const current = previous ?? {};
  const revision = current.revision ?? 0;
  const nextRevision = next.revision ?? 0;
  if (nextRevision === revision) {
    // A pending journal and a definite noncommitting failure never change committed ownership.
    if (!isDeepStrictEqual(checkpointBody(current), checkpointBody(next))
      || (current.pendingWrite && next.pendingWrite && !isDeepStrictEqual(current.pendingWrite, next.pendingWrite))) {
      fail('NOTION_MANAGED_STATE_REVISION_CONFLICT');
    }
  } else if (nextRevision !== revision + 1 || !current.pendingWrite || next.pendingWrite) {
    fail('NOTION_MANAGED_STATE_REVISION_CONFLICT');
  }
}

/**
 * Tenant-bound PostgreSQL checkpoints for OfficialNotionAdapter. Construction does no I/O.
 * Writes require a preceding read inside the covering distributed lock. Checkpoint writes
 * autocommit individually, so a crash cannot roll back a previously recorded pending write.
 */
export class PostgresNotionManagedStateStore implements NotionManagedStateStore {
  private readonly tenantSegment!: string;
  private readonly locks = new AsyncLocalStorage<LockContext>();
  constructor(private readonly trainerId: string) {
    if (typeof trainerId !== 'string' || !trainerId || trainerId.includes('\0')) fail('NOTION_MANAGED_STATE_TENANT_INVALID');
    try { this.tenantSegment = encodeURIComponent(trainerId); }
    catch { return fail('NOTION_MANAGED_STATE_TENANT_INVALID'); }
  }
  private keyKind(key: string, lock = false): 'member' | 'calendar' {
    if (typeof key !== 'string' || key.includes('\0')) return fail('NOTION_MANAGED_STATE_KEY_SCOPE_MISMATCH');
    const parts = key.split(':');
    if (parts[0] !== 'notion' || !['member', 'calendar'].includes(parts[1] ?? '') || parts[2] !== this.tenantSegment) {
      return fail('NOTION_MANAGED_STATE_KEY_SCOPE_MISMATCH');
    }
    const calendar = parts[1] === 'calendar';
    if (lock && calendar && parts.length === 3) return 'calendar';
    if (parts.length !== 4 || (lock && calendar) || !parts[3]) return fail('NOTION_MANAGED_STATE_KEY_SCOPE_MISMATCH');
    try {
      const identity = decodeURIComponent(parts[3]);
      if (!identity || identity.includes('\0') || encodeURIComponent(identity) !== parts[3]) fail('NOTION_MANAGED_STATE_KEY_SCOPE_MISMATCH');
    } catch { return fail('NOTION_MANAGED_STATE_KEY_SCOPE_MISMATCH'); }
    return calendar ? 'calendar' : 'member';
  }
  private context(key: string, required: boolean): LockContext | undefined {
    const context = this.locks.getStore();
    if (!context) {
      if (required) fail('NOTION_MANAGED_STATE_LOCK_REQUIRED');
      return undefined;
    }
    if (!context.active || context.lost) fail('NOTION_MANAGED_STATE_LOCK_LOST');
    if (context.key !== key && !(context.key.startsWith('notion:calendar:') && key.startsWith(`${context.key}:`))) {
      fail('NOTION_MANAGED_STATE_LOCK_SCOPE_MISMATCH');
    }
    return context;
  }
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keyKind(key, true);
    const nested = this.locks.getStore();
    if (nested) {
      this.context(key, true);
      if (nested.key !== key) fail('NOTION_MANAGED_STATE_LOCK_SCOPE_MISMATCH');
      return work();
    }
    const client = await connectDb();
    const context: LockContext = { client, key, active: true, lost: false, snapshots: new Map() };
    const onError = (): void => { context.lost = true; };
    client.on('error', onError);
    let acquired = false;
    let destroy = false;
    let failed = false;
    let releaseFailure = false;
    const lockIdentity = `trainer-sync-notion-managed-state:${key}`;
    try {
      let locked: boolean;
      try {
        const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockIdentity]);
        locked = result.rows[0]?.locked === true;
      } catch { destroy = true; return fail('NOTION_MANAGED_STATE_DATABASE_UNAVAILABLE'); }
      if (!locked) return fail('NOTION_MANAGED_STATE_BUSY');
      acquired = true;
      const tenant = await client.query('SELECT 1 FROM trainers WHERE id=$1', [this.trainerId]);
      if (!tenant.rowCount) return fail('NOTION_MANAGED_STATE_TRAINER_UNKNOWN');
      return await this.locks.run(context, work);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      context.active = false;
      if (acquired) {
        try {
          const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [lockIdentity]);
          if (result.rows[0]?.unlocked !== true) { destroy = true; releaseFailure = true; }
        } catch { destroy = true; releaseFailure = true; }
      }
      client.off('error', onError);
      client.release(destroy || context.lost);
      if (releaseFailure && !failed) fail('NOTION_MANAGED_STATE_LOCK_LOST');
    }
  }
  async read(key: string): Promise<NotionManagedState | undefined> {
    const calendar = this.keyKind(key) === 'calendar';
    const context = this.context(key, false);
    let row: StateRow | undefined;
    try {
      const result = context
        ? await context.client.query<StateRow>('SELECT state,revision::text FROM notion_managed_state WHERE trainer_id=$1 AND state_key=$2', [this.trainerId, key])
        : await query<StateRow>('SELECT state,revision::text FROM notion_managed_state WHERE trainer_id=$1 AND state_key=$2', [this.trainerId, key]);
      row = result.rows[0];
    } catch { if (context) context.lost = true; return fail('NOTION_MANAGED_STATE_DATABASE_UNAVAILABLE'); }
    const state = row ? checkedState(row.state, calendar) : undefined;
    const revision = Number(row?.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision !== (state?.revision ?? 0)) fail('NOTION_MANAGED_STATE_INVALID');
    context?.snapshots.set(key, { state: structuredClone(state), revision });
    return state;
  }
  async write(key: string, input: NotionManagedState): Promise<void> {
    const calendar = this.keyKind(key) === 'calendar';
    const context = this.context(key, true)!;
    const next = checkedState(input, calendar);
    const snapshot = context.snapshots.get(key);
    if (!snapshot) fail('NOTION_MANAGED_STATE_READ_REQUIRED');
    transition(snapshot.state, next);
    const encoded = JSON.stringify(next);
    let changed: number | null;
    try {
      const result = snapshot.state === undefined
        ? await context.client.query(`INSERT INTO notion_managed_state(trainer_id,state_key,state,revision)
            VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(trainer_id,state_key) DO NOTHING RETURNING state_key`,
          [this.trainerId, key, encoded, next.revision ?? 0])
        : await context.client.query(`UPDATE notion_managed_state SET state=$3::jsonb,revision=$4,updated_at=clock_timestamp()
            WHERE trainer_id=$1 AND state_key=$2 AND revision=$5 AND state=$6::jsonb RETURNING state_key`,
          [this.trainerId, key, encoded, next.revision ?? 0, snapshot.revision, JSON.stringify(snapshot.state)]);
      changed = result.rowCount;
    } catch { context.lost = true; return fail('NOTION_MANAGED_STATE_DATABASE_UNAVAILABLE'); }
    if (changed !== 1) { context.lost = true; fail('NOTION_MANAGED_STATE_REVISION_CONFLICT'); }
    context.snapshots.set(key, { state: structuredClone(next), revision: next.revision ?? 0 });
  }
}
