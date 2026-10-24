import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, getMember, getSchedules, migrate, query, syntheticMembers } from '@trainer/db';
import { MockCompanyAdapter } from '../src/company.ts';
import { MockNotionAdapter } from '../src/notion.ts';
import { pollNotion, syncCompany } from '../src/sync.ts';

let trainerId: string;
const start = '2026-10-22T00:00:00Z';
const request = '\ud0c8\ud1f4 \uc694\uccad';
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated *_test PostgreSQL required.');
  process.env.DATABASE_URL = url;
  process.env.ADAPTER_MODE = 'mock';
  process.env.EXTERNAL_CONNECTIONS_ENABLED = 'false';
  await migrate();
});
after(async () => { await closeDb(); });
beforeEach(async () => {
  trainerId = `request-series-${randomUUID()}`;
  await query('INSERT INTO trainers(id,name) VALUES($1,$2)', [trainerId, 'Synthetic request schedule trainer']);
});
afterEach(async () => { await query('DELETE FROM trainers WHERE id=$1', [trainerId]); });

async function setRemoteStatus(memberId: string, status: string): Promise<void> {
  await query(`UPDATE mock_notion_pages SET member_data=jsonb_set(member_data,'{status}',to_jsonb($3::text))
    WHERE trainer_id=$1 AND company_member_id=$2`, [trainerId, memberId, status]);
}

test('PostgreSQL request activation survives poll, connection restart, company reimport and horizon replenishment until confirmed withdrawal', async () => {
  const source = syntheticMembers(trainerId, start).find(member => member.status === '\uc9c4\ud589')!;
  const notion = new MockNotionAdapter({ templateDelayMs: 0 });
  let now = start;
  const adapters = { company: new MockCompanyAdapter({ members: [source] }), notion, now: () => now };
  await syncCompany(trainerId, adapters);
  const before = await getSchedules(trainerId, source.companyMemberId);
  assert.ok(before.length > 5);
  await setRemoteStatus(source.companyMemberId, request);
  await pollNotion(trainerId, adapters);
  assert.equal((await getMember(trainerId, source.companyMemberId))?.trainingRecurrenceActive, true);
  assert.deepEqual(await getSchedules(trainerId, source.companyMemberId), before);

  // Drop the local connection pool so the next poll must recover activation from PostgreSQL JSON.
  await closeDb();
  now = '2026-12-01T00:00:00+09:00';
  await pollNotion(trainerId, adapters);
  await syncCompany(trainerId, adapters);
  await pollNotion(trainerId, adapters);
  const restored = await getMember(trainerId, source.companyMemberId);
  assert.equal(restored?.status, request);
  assert.equal(restored?.trainingRecurrenceActive, true);
  const expanded = await getSchedules(trainerId, source.companyMemberId);
  assert.ok(expanded.some(event => event.status === 'active' && Date.parse(event.start) > Date.parse(before.at(-1)!.start)));
  for (const old of before) assert.deepEqual(expanded.find(event => event.key === old.key), old);

  await setRemoteStatus(source.companyMemberId, '\ud0c8\ud1f4');
  await pollNotion(trainerId, adapters);
  const stopped = await getSchedules(trainerId, source.companyMemberId);
  assert.equal((await getMember(trainerId, source.companyMemberId))?.trainingRecurrenceActive, false);
  assert.ok(stopped.filter(event => Date.parse(event.start) >= Date.parse(now)).every(event => event.status === 'cancelled'));
  for (const old of expanded.filter(event => Date.parse(event.start) < Date.parse(now))) {
    assert.deepEqual(stopped.find(event => event.key === old.key), old);
  }
  await setRemoteStatus(source.companyMemberId, request);
  await pollNotion(trainerId, adapters);
  assert.equal((await getMember(trainerId, source.companyMemberId))?.trainingRecurrenceActive, false);
  assert.deepEqual(await getSchedules(trainerId, source.companyMemberId), stopped);
});

test('PostgreSQL new/call to request transitions do not start training even when a first date and fixed slot exist', async () => {
  const training = syntheticMembers(trainerId, start).find(member => member.status === '\uc9c4\ud589')!;
  const initial = [
    { ...training, companyMemberId: 'new-member', status: '\uc2e0\uaddc' as const, assignmentEvidence: 'new' as const },
    { ...training, companyMemberId: 'call-member', status: '\ud1b5\ud654' as const, callAt: '2026-10-23T16:00:00+09:00' },
  ];
  const adapters = { company: new MockCompanyAdapter({ members: initial }), notion: new MockNotionAdapter({ templateDelayMs: 0 }), now: () => start };
  await syncCompany(trainerId, adapters);
  const before = await getSchedules(trainerId);
  assert.equal(before.filter(event => event.kind === 'training').length, 0);
  for (const member of initial) await setRemoteStatus(member.companyMemberId, request);
  await pollNotion(trainerId, adapters);
  await closeDb();
  await pollNotion(trainerId, { ...adapters, now: () => '2026-12-01T00:00:00+09:00' });
  assert.deepEqual(await getSchedules(trainerId), before);
  for (const member of initial) assert.equal((await getMember(trainerId, member.companyMemberId))?.trainingRecurrenceActive, false);
});
