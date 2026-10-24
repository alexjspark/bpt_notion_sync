import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, migrate, query } from '@trainer/db';
import { PostgresNotionManagedStateStore } from '../src/live-notion-pg-store.ts';
import type { NotionManagedState } from '../src/live-notion-types.ts';

let trainerId: string;
let otherTrainer: string;
const memberKey = (trainer = trainerId, member = 'synthetic-member') => `notion:member:${encodeURIComponent(trainer)}:${encodeURIComponent(member)}`;
const calendarLock = (trainer = trainerId) => `notion:calendar:${encodeURIComponent(trainer)}`;
const calendarKey = (event: string, trainer = trainerId) => `${calendarLock(trainer)}:${encodeURIComponent(event)}`;
const hashes = { originalFingerprint: 'a'.repeat(64), currentFingerprint: 'b'.repeat(64) };
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required: real PostgreSQL integration tests cannot be skipped.');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Integration tests require a dedicated *_test database.');
  process.env.DATABASE_URL = url;
  await migrate();
});
after(async () => { await closeDb(); });
beforeEach(async () => {
  // Colons, percent signs and Unicode prove that keys use the adapter's exact encoded tenant segment.
  trainerId = `notion-synthetic:%:${randomUUID()}:\ud55c`;
  otherTrainer = `notion-other-${randomUUID()}`;
  await query('INSERT INTO trainers(id,name) VALUES($1,$2),($3,$4)', [trainerId, 'Synthetic Notion trainer', otherTrainer, 'Synthetic other trainer']);
});
afterEach(async () => { await query('DELETE FROM trainers WHERE id IN ($1,$2)', [trainerId, otherTrainer]); });

test('committed IDs and ownership fingerprints survive a fresh store without retaining content', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId);
  const key = memberKey();
  const committed: NotionManagedState = { revision: 1, pageId: 'synthetic-page',
    surveyBlocks: { '0': { blockId: 'synthetic-survey-block', fingerprint: 'c'.repeat(64) } },
    personalizedBlocks: { 'synthetic-personalized-block': hashes } };
  await store.withLock(key, async () => {
    assert.equal(await store.read(key), undefined);
    await store.write(key, { pendingWrite: { operation: 'create-member' } });
    await store.write(key, committed);
  });
  const restarted = new PostgresNotionManagedStateStore(trainerId);
  const read = await restarted.read(key); assert.deepEqual(read, committed);
  read!.pageId = 'synthetic-local-edit';
  assert.deepEqual(await restarted.read(key), committed);
  const persisted = (await query<{ state: unknown; revision: string }>('SELECT state,revision::text FROM notion_managed_state WHERE trainer_id=$1 AND state_key=$2', [trainerId, key])).rows[0]!;
  assert.equal(persisted.revision, '1'); assert.deepEqual(persisted.state, committed);
  assert.doesNotMatch(JSON.stringify(persisted), /SYNTHETIC_PRIVATE|original"|current"|token|secret|Hmac/);
  await assert.rejects(new PostgresNotionManagedStateStore(otherTrainer).read(key), /KEY_SCOPE_MISMATCH/);
  await query('DELETE FROM trainers WHERE id=$1', [trainerId]);
  assert.equal((await query('SELECT 1 FROM notion_managed_state WHERE trainer_id=$1', [trainerId])).rowCount, 0);
});

test('tenant aliases, unlocked writes, unobserved writes and private state are rejected', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId); const key = memberKey();
  for (const invalid of [memberKey(otherTrainer), `notion:member:${trainerId}:synthetic-member`, `${key}:extra`,
    `notion:member:${encodeURIComponent(trainerId)}:%73ynthetic-member`, calendarLock(), `${key}%00`]) {
    await assert.rejects(store.read(invalid), /KEY_SCOPE_MISMATCH/);
  }
  await assert.rejects(store.withLock(calendarKey('event'), async () => {}), /KEY_SCOPE_MISMATCH/);
  await assert.rejects(store.write(key, {}), /LOCK_REQUIRED/);
  await store.withLock(key, async () => {
    await assert.rejects(store.write(key, {}), /READ_REQUIRED/);
    assert.equal(await store.read(key), undefined);
    const unsafe = [
      { token: 'SYNTHETIC_PRIVATE_TOKEN' }, { pageId: 'SYNTHETIC_PRIVATE/CONTENT' },
      { personalizedBlocks: { block: { original: 'SYNTHETIC_PRIVATE_TEXT', current: 'SYNTHETIC_PRIVATE_NAME' } } },
      { surveyBlocks: { '0': { blockId: 'synthetic-block', fingerprint: 'SYNTHETIC_PRIVATE_SURVEY' } } },
      { pendingWrite: { operation: 'create-calendar' } }, { pendingWrite: { operation: 'create-member', body: 'SYNTHETIC_PRIVATE_BODY' } },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const state of unsafe) await assert.rejects(store.write(key, state as NotionManagedState), /STATE_INVALID/);
  });
  assert.equal((await query('SELECT 1 FROM notion_managed_state WHERE trainer_id=$1', [trainerId])).rowCount, 0);
  await assert.rejects(new PostgresNotionManagedStateStore(`unknown-${randomUUID()}`).withLock(memberKey(`unknown`), async () => {}), /KEY_SCOPE_MISMATCH/);
});

test('callback failure preserves the durable pending journal and releases the session lock', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId); const key = memberKey();
  await assert.rejects(store.withLock(key, async () => {
    await store.read(key);
    await store.write(key, { pendingWrite: { operation: 'append-survey' } });
    throw new Error('SYNTHETIC_INTERRUPTION');
  }), /SYNTHETIC_INTERRUPTION/);
  const restarted = new PostgresNotionManagedStateStore(trainerId);
  assert.deepEqual(await restarted.read(key), { pendingWrite: { operation: 'append-survey' } });
  await restarted.withLock(key, async () => {
    await restarted.read(key);
    // A reconciled definite failure may clear the journal without incrementing the committed revision.
    await restarted.write(key, {});
  });
  assert.deepEqual(await restarted.read(key), {});
});

test('independent store instances exclude overlapping execution and fence stale revisions', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId);
  const competitor = new PostgresNotionManagedStateStore(trainerId);
  const key = memberKey(); const entered = barrier(); const finish = barrier();
  const running = store.withLock(key, async () => {
    await store.read(key); await store.write(key, { pendingWrite: { operation: 'create-member' } });
    entered.release(); await finish.promise;
    await assert.rejects(store.read(memberKey(trainerId, 'another-member')), /LOCK_SCOPE_MISMATCH/);
    await store.write(key, { pageId: 'synthetic-created-page', revision: 1 });
  });
  await entered.promise;
  try {
    await assert.rejects(competitor.withLock(key, async () => assert.fail('Overlapping execution')), /STATE_BUSY/);
    assert.deepEqual(await competitor.read(key), { pendingWrite: { operation: 'create-member' } });
  } finally { finish.release(); await running; }
  await competitor.withLock(key, async () => {
    assert.equal((await competitor.read(key))!.revision, 1);
    await assert.rejects(competitor.write(key, { pendingWrite: { operation: 'create-member' } }), /REVISION_CONFLICT/);
    await assert.rejects(competitor.write(key, { revision: 3 }), /REVISION_CONFLICT/);
    await assert.rejects(competitor.write(key, { revision: 2, pageId: 'synthetic-overwrite' }), /REVISION_CONFLICT/);
  });
  assert.equal((await competitor.read(key))!.pageId, 'synthetic-created-page');
});

test('compare-and-swap also fences a changed pending checkpoint at the same revision', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId); const key = memberKey();
  await store.withLock(key, async () => { await store.read(key); await store.write(key, { pendingWrite: { operation: 'append-survey' } }); });
  await assert.rejects(store.withLock(key, async () => {
    await store.read(key);
    // Simulate an administrative/stale SQL writer that bypassed the distributed lock.
    await query('UPDATE notion_managed_state SET state=$3::jsonb WHERE trainer_id=$1 AND state_key=$2', [trainerId, key, JSON.stringify({ pendingWrite: { operation: 'update-survey' } })]);
    await store.write(key, {});
  }), /REVISION_CONFLICT/);
  assert.deepEqual(await store.read(key), { pendingWrite: { operation: 'update-survey' } });
  await store.withLock(key, async () => { assert.ok(await store.read(key)); });
});

test('calendar scope covers its event checkpoints while member scopes stay separate', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId);
  const lock = calendarLock(); const keys = [calendarKey('call:synthetic-member'), calendarKey('training/%/synthetic-member')];
  await store.withLock(lock, async () => {
    await assert.rejects(store.read(memberKey()), /LOCK_SCOPE_MISMATCH/);
    for (const [index, key] of keys.entries()) {
      await store.read(key); await store.write(key, { pendingWrite: { operation: 'create-calendar' } });
      await store.write(key, { revision: 1, pageId: `synthetic-event-${index}` });
    }
  });
  assert.deepEqual((await Promise.all(keys.map(key => store.read(key)))).map(state => state!.revision), [1, 1]);
  await assert.rejects(new PostgresNotionManagedStateStore(otherTrainer).withLock(lock, async () => {}), /KEY_SCOPE_MISMATCH/);
});

test('eight concurrent lock holders reuse their sessions without starving the eight-client pool', { timeout: 15000 }, async () => {
  const store = new PostgresNotionManagedStateStore(trainerId); const allEntered = barrier(); let entered = 0;
  const keys = Array.from({ length: 8 }, (_, index) => memberKey(trainerId, `synthetic-parallel-${index}`));
  await Promise.all(keys.map(key => store.withLock(key, async () => {
    if (++entered === keys.length) allEntered.release();
    await allEntered.promise;
    assert.equal(await store.read(key), undefined);
    await store.write(key, { pendingWrite: { operation: 'create-member' } });
    await store.write(key, { revision: 1, pageId: 'synthetic-parallel-page' });
    assert.equal((await store.read(key))!.revision, 1);
  })));
  assert.equal((await query('SELECT 1 FROM notion_managed_state WHERE trainer_id=$1', [trainerId])).rowCount, 8);
});

test('a detached async descendant cannot use an expired session context after lock release', async () => {
  const store = new PostgresNotionManagedStateStore(trainerId); const key = memberKey(); const continueWork = barrier();
  let detached!: Promise<void>;
  await store.withLock(key, async () => {
    await store.read(key);
    detached = continueWork.promise.then(() => store.write(key, { pendingWrite: { operation: 'create-member' } }));
  });
  continueWork.release();
  await assert.rejects(detached, /LOCK_LOST/);
  assert.equal(await store.read(key), undefined);
});

test('database constraints independently reject raw content, invalid fingerprints and unknown tenants', async () => {
  const key = memberKey();
  for (const state of [
    { token: 'SYNTHETIC_PRIVATE_TOKEN' }, { pendingWrite: {} },
    { personalizedBlocks: { block: { original: 'SYNTHETIC_PRIVATE_TEXT', current: 'SYNTHETIC_PRIVATE_NAME' } } },
    { surveyBlocks: { '0': { blockId: 'synthetic-block', fingerprint: 'SYNTHETIC_PRIVATE_SURVEY' } } },
  ]) {
    await assert.rejects(query('INSERT INTO notion_managed_state(trainer_id,state_key,state) VALUES($1,$2,$3::jsonb)', [trainerId, key, JSON.stringify(state)]), { code: '23514' });
  }
  const missing = `notion-missing-${randomUUID()}`;
  await assert.rejects(query('INSERT INTO notion_managed_state(trainer_id,state_key,state) VALUES($1,$2,$3::jsonb)', [missing, memberKey(missing), '{}']), { code: '23503' });
});
