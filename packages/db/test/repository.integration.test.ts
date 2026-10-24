import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ScheduleEvent } from '@trainer/core';
import { migrate, query, closeDb, getMembers, getMember, upsertMember, syntheticMembers, saveSchedules, getSchedules, getDashboard, enqueueJob, saveSettings, getSettings, defaultSettings, transaction } from '../src/index.ts';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is required for real PostgreSQL integration tests.');
if (!decodeURIComponent(new URL(testUrl).pathname).endsWith('_test')) throw new Error('Integration tests require a dedicated database ending in _test.');
process.env.DATABASE_URL = testUrl;
const prefix = `repository-test-${randomUUID()}`;
const trainerA = `${prefix}-a`;
const trainerB = `${prefix}-b`;
const now = '2026-10-22T00:00:00.000Z';
const memberA = syntheticMembers(trainerA, now)[0]!;
const memberB = { ...syntheticMembers(trainerB, now)[0]!, name: '격리된 사용자 B의 데이터' };

before(async () => {
  await migrate();
  await query('INSERT INTO trainers(id,name) VALUES($1,$2),($3,$4)', [trainerA, '테스트 A', trainerB, '테스트 B']);
});
after(async () => {
  await query('DELETE FROM trainers WHERE id = ANY($1::text[])', [[trainerA, trainerB]]);
  await closeDb();
});

test('real PostgreSQL: migrations are idempotent and defaults keep daily operations disabled', async () => {
  await migrate();
  assert.deepEqual(await getSettings(trainerA), defaultSettings);
  assert.equal((await getSettings(trainerA)).mockScheduleEnabled, false);
});

test('real PostgreSQL: legacy initial status is normalized on read without rewriting stored JSON', async () => {
  const legacyId = 'synthetic-legacy-status';
  const legacy = { ...memberA, companyMemberId: legacyId, status: '\uce74\ud1a1\uc804' };
  await query('INSERT INTO members(trainer_id,company_member_id,data) VALUES($1,$2,$3::jsonb)', [trainerA, legacyId, JSON.stringify(legacy)]);
  try {
    assert.equal((await getMember(trainerA, legacyId))?.status, '\uc2e0\uaddc');
    assert.equal((await getMembers(trainerA)).find(member => member.companyMemberId === legacyId)?.status, '\uc2e0\uaddc');
    const stored = (await query<{ status: string }>("SELECT data->>'status' AS status FROM members WHERE trainer_id=$1 AND company_member_id=$2", [trainerA, legacyId])).rows[0]!;
    assert.equal(stored.status, '\uce74\ud1a1\uc804');
  } finally {
    await query('DELETE FROM members WHERE trainer_id=$1 AND company_member_id=$2', [trainerA, legacyId]);
  }
});

test('real PostgreSQL: identical company IDs remain isolated between trainers', async () => {
  await upsertMember(trainerA, memberA);
  await upsertMember(trainerB, memberB);
  assert.equal((await getMember(trainerA, memberA.companyMemberId))?.name, memberA.name);
  assert.equal((await getMember(trainerB, memberA.companyMemberId))?.name, memberB.name);
  assert.equal((await getMembers(trainerA)).length, 1);
  await assert.rejects(upsertMember(trainerA, memberB), /Tenant mismatch/);
  await assert.rejects(query('INSERT INTO members(trainer_id,company_member_id,data) VALUES($1,$2,$3::jsonb)', [trainerA, 'wrong-tenant', JSON.stringify({ ...memberB, companyMemberId: 'wrong-tenant' })]), /check constraint/);
});

test('real PostgreSQL: upsert and concurrent queue requests do not produce duplicates', async () => {
  await Promise.all(Array.from({ length: 12 }, () => upsertMember(trainerA, memberA)));
  assert.equal((await getMembers(trainerA)).length, 1);
  const jobIds = await Promise.all(Array.from({ length: 12 }, () => enqueueJob(trainerA, 'company_sync')));
  assert.equal(new Set(jobIds).size, 1);
  const count = await query<{ count: string }>('SELECT count(*) FROM jobs WHERE trainer_id=$1 AND kind=$2', [trainerA, 'company_sync']);
  assert.equal(Number(count.rows[0]?.count), 1);
});

test('real PostgreSQL: schedule upsert preserves stored manual metadata and scopes reads', async () => {
  const event: ScheduleEvent = { key: 'same-company-session', trainerId: trainerA, companyMemberId: memberA.companyMemberId, kind: 'training', start: '2026-10-25T06:00:00.000Z', end: '2026-10-25T07:00:00.000Z', status: 'active', manualOverride: true, sourceStart: '2026-10-25T05:00:00.000Z', sourceEnd: '2026-10-25T06:00:00.000Z' };
  await saveSchedules(trainerA, [event]);
  await saveSchedules(trainerA, [event]);
  await saveSchedules(trainerB, [{ ...event, trainerId: trainerB }]);
  assert.deepEqual(await getSchedules(trainerA), [event]);
  assert.equal((await getSchedules(trainerB))[0]?.trainerId, trainerB);
  await assert.rejects(saveSchedules(trainerA, [{ ...event, trainerId: trainerB }]), /Tenant mismatch/);
});

test('real PostgreSQL: foreign member references cannot be inserted across tenant boundaries', async () => {
  const bOnly = { ...memberB, companyMemberId: 'b-only' };
  await upsertMember(trainerB, bOnly);
  const event: ScheduleEvent = { key: 'foreign-member', trainerId: trainerA, companyMemberId: bOnly.companyMemberId, kind: 'call', start: '2026-10-25T00:00:00Z', end: '2026-10-25T01:00:00Z', status: 'active', manualOverride: false, sourceStart: '2026-10-25T00:00:00Z', sourceEnd: '2026-10-25T01:00:00Z' };
  await assert.rejects(saveSchedules(trainerA, [event]), /foreign key constraint/);
});

test('real PostgreSQL: settings reject missing time, invalid timezones and too-fast polling', async () => {
  await assert.rejects(saveSettings(trainerA, { ...defaultSettings, mockScheduleEnabled: true }), /Choose a time/);
  await assert.rejects(saveSettings(trainerA, { ...defaultSettings, dailyTime: '25:00' }), /HH:mm/);
  await assert.rejects(saveSettings(trainerA, { ...defaultSettings, timezone: 'Invalid/Zone' }), /timezone/);
  await assert.rejects(saveSettings(trainerA, { ...defaultSettings, notionPollMinutes: 1 }), /5..1440/);
  const next = { ...defaultSettings, dailyTime: '09:30', mockScheduleEnabled: true };
  await saveSettings(trainerA, next);
  assert.deepEqual(await getSettings(trainerA), next);
  assert.deepEqual(await getSettings(trainerB), defaultSettings);
});

test('real PostgreSQL: dashboard never includes another trainer member, job or schedule', async () => {
  await enqueueJob(trainerB, 'notion_poll');
  const dashboard = await getDashboard(trainerA);
  assert.equal(dashboard.trainer.id, trainerA);
  assert.equal(dashboard.mode, 'mock');
  assert.ok(dashboard.members.every((member) => member.trainerId === trainerA));
  assert.ok(dashboard.schedules.every((event) => event.trainerId === trainerA));
  assert.equal(dashboard.jobs.length, 1);
  assert.equal(dashboard.jobs[0]?.kind, 'company_sync');
  assert.ok(dashboard.connections.every((connection) => connection.status === 'mock'));
});

test('real PostgreSQL: connection metadata is tenant scoped and real connections fail closed', async () => {
  await query('INSERT INTO connections(trainer_id,provider,public_config) VALUES($1,$2,$3::jsonb)', [trainerA, 'company', JSON.stringify({ syntheticScope: trainerA })]);
  await query('INSERT INTO connections(trainer_id,provider,public_config) VALUES($1,$2,$3::jsonb)', [trainerB, 'company', JSON.stringify({ syntheticScope: trainerB })]);
  const a = await query<{ public_config: { syntheticScope: string } }>('SELECT public_config FROM connections WHERE trainer_id=$1 AND provider=$2', [trainerA, 'company']);
  assert.equal(a.rows[0]?.public_config.syntheticScope, trainerA);
  await assert.rejects(query('UPDATE connections SET enabled=true WHERE trainer_id=$1', [trainerA]), /check constraint/);
  await assert.rejects(query('UPDATE connections SET mode=$2 WHERE trainer_id=$1', [trainerA, 'real']), /check constraint/);
});

test('real PostgreSQL: a failed transaction rolls back partial writes', async () => {
  await assert.rejects(transaction(async (client) => {
    await client.query('UPDATE trainers SET name=$2 WHERE id=$1', [trainerA, 'must-rollback']);
    throw new Error('injected partial failure');
  }), /injected partial failure/);
  const result = await query<{ name: string }>('SELECT name FROM trainers WHERE id=$1', [trainerA]);
  assert.equal(result.rows[0]?.name, '테스트 A');
});

test('real PostgreSQL: changed timing resets only the affected durable scheduler cursors', async () => {
  const putCursors = async () => {
    await query("INSERT INTO scheduler_state(trainer_id,kind,next_due) VALUES($1,'company_sync',now()),($1,'notion_poll',now()) ON CONFLICT(trainer_id,kind) DO UPDATE SET next_due=EXCLUDED.next_due", [trainerA]);
  };
  const kinds = async () => (await query<{ kind: string }>('SELECT kind FROM scheduler_state WHERE trainer_id=$1 ORDER BY kind', [trainerA])).rows.map((row) => row.kind);
  await putCursors();
  const changed = { ...await getSettings(trainerA), dailyTime: '10:00', timezone: 'UTC', notionPollMinutes: 6 };
  await saveSettings(trainerA, changed);
  assert.deepEqual(await kinds(), []);
  await putCursors();
  await saveSettings(trainerA, changed);
  assert.deepEqual(await kinds(), ['company_sync', 'notion_poll']);
  await saveSettings(trainerA, { ...changed, mockScheduleEnabled: false });
  assert.deepEqual(await kinds(), ['notion_poll']);
});
