import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, migrate, query } from '@trainer/db';
import type { Member } from '@trainer/core';
import type { CompanyAdapter } from '../src/ports.ts';
import { RetryableError } from '../src/ports.ts';
import { NotionHttpError } from '../src/live-notion-client.ts';
import {
  assertManualSyncLease, claimManualSyncRun, getManualSyncRun, listManualSyncRuns, queueManualSyncRun,
  renewManualSyncLease, runManualSyncOnce, verifyWithdrawalStatusMapping, withManualSyncExecutionLock,
} from '../src/manual-sync.ts';
import type { ManualSyncNotionInventory, ManualSyncRun, ManualSyncWorkerOptions } from '../src/manual-sync.ts';

let trainerId: string;
let otherTrainer: string;
const readiness = { companyRead: true, notionInventoryRead: true };
const previewHmacKey = 'synthetic-integration-preview-key-never-a-real-secret';
const nullCounts = { added: null, skipped: null, failed: null, plannedAdds: null, review: null };
function member(id: string, trainer = trainerId, overrides: Partial<Member> = {}): Member {
  return { trainerId: trainer, companyMemberId: id, name: 'SYNTHETIC_PRIVATE_NAME', status: '\uc9c4\ud589', notionPageId: null,
    registrationDate: null, assignmentDate: null, assignmentEvidence: 'existing', membershipActivity: 'active',
    memo: 'SYNTHETIC_PRIVATE_MEMO', fixedSlot: null, firstTrainingDate: null, callAt: null,
    survey: [{ question: 'SYNTHETIC_PRIVATE_QUESTION', answer: 'SYNTHETIC_PRIVATE_ANSWER' }], manualContent: 'SYNTHETIC_PRIVATE_TEXT', ...overrides };
}
function company(members = [member('SYNTHETIC_PRIVATE_MEMBER')]): CompanyAdapter {
  return { listMembers: async () => ({ members, nextCursor: null, scope: 'all_assigned', completeCoverage: true, snapshotId: 'SYNTHETIC_PRIVATE_SNAPSHOT' }) };
}
function notion(ids: string[] = []): ManualSyncNotionInventory {
  return { listIdentities: async () => ({ identities: ids.map((id, index) => ({ trainerId, companyMemberId: id, pageId: `SYNTHETIC_PRIVATE_PAGE_${index}` })),
    nextCursor: null, scope: 'all_members', completeCoverage: true, snapshotId: 'SYNTHETIC_PRIVATE_NOTION_SNAPSHOT' }) };
}
function options(overrides: Partial<ManualSyncWorkerOptions> = {}): ManualSyncWorkerOptions {
  return { trainerId, readiness, previewHmacKey, company: company(), notion: notion(), ...overrides };
}
async function current(id: string): Promise<ManualSyncRun> {
  const result = await getManualSyncRun(trainerId, id); assert.ok(result); return result;
}
async function due(id: string): Promise<void> { await query('UPDATE manual_sync_runs SET available_at=now() WHERE trainer_id=$1 AND id=$2', [trainerId, id]); }
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required: real PostgreSQL integration tests cannot be skipped.');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('Integration tests require a dedicated *_test database.');
  process.env.DATABASE_URL = url;
  await migrate();
});
after(async () => { await closeDb(); });
beforeEach(async () => {
  trainerId = `manual-synthetic-${randomUUID()}`; otherTrainer = `manual-other-${randomUUID()}`;
  await query('INSERT INTO trainers(id,name) VALUES($1,$2),($3,$4)', [trainerId, 'Synthetic manual trainer', otherTrainer, 'Synthetic other trainer']);
});
afterEach(async () => { await query('DELETE FROM trainers WHERE id IN ($1,$2)', [trainerId, otherTrainer]); });

test('simultaneous blocked clicks dedupe by trainer and every request UUID retains the chosen run', async () => {
  const requestIds = [randomUUID(), randomUUID(), randomUUID()];
  const runs = await Promise.all(requestIds.map(id => queueManualSyncRun(trainerId, id)));
  assert.equal(new Set(runs.map(run => run.id)).size, 1);
  assert.equal(runs[0]!.status, 'needs_connection'); assert.deepEqual(runs[0]!.counts, nullCounts);
  assert.deepEqual(runs[0]!.missingCapabilities, ['company_read_session', 'notion_read_integration']);
  assert.equal((await listManualSyncRuns(trainerId)).length, 1);
  assert.equal((await query('SELECT * FROM manual_sync_requests WHERE trainer_id=$1', [trainerId])).rowCount, 3);
  const isolated = await queueManualSyncRun(otherTrainer, requestIds[0]!);
  assert.notEqual(isolated.id, runs[0]!.id);
  assert.equal(await getManualSyncRun(otherTrainer, runs[0]!.id), null);
  await assert.rejects(queueManualSyncRun(trainerId, 'SYNTHETIC_PRIVATE_REQUEST'), /INVALID_MANUAL_SYNC_REQUEST_ID/);
});

test('connection readiness promotes the existing blocked run and replay remains idempotent after success', async () => {
  const firstRequest = randomUUID(); const joinedRequest = randomUUID();
  const blocked = await queueManualSyncRun(trainerId, firstRequest);
  await queueManualSyncRun(trainerId, joinedRequest);
  const queued = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  assert.equal(queued.id, blocked.id); assert.equal(queued.status, 'queued'); assert.deepEqual(queued.counts, nullCounts);
  await runManualSyncOnce(options());
  assert.equal((await current(blocked.id)).status, 'succeeded');
  assert.equal((await queueManualSyncRun(trainerId, joinedRequest, readiness)).id, blocked.id);
  assert.equal((await queueManualSyncRun(trainerId, firstRequest, readiness)).id, blocked.id);
  const next = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  assert.notEqual(next.id, blocked.id); assert.equal(next.status, 'queued');
});

test('default runner blocks queued work before any injected read and leaves truthful null counts', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  let reads = 0;
  const forbiddenCompany: CompanyAdapter = { listMembers: async () => { reads++; throw new Error('UNEXPECTED_SYNTHETIC_READ'); } };
  const forbiddenNotion: ManualSyncNotionInventory = { listIdentities: async () => { reads++; throw new Error('UNEXPECTED_SYNTHETIC_READ'); } };
  assert.equal(await runManualSyncOnce({ trainerId, company: forbiddenCompany, notion: forbiddenNotion }), true);
  const blocked = await current(run.id);
  assert.equal(blocked.status, 'needs_connection'); assert.equal(blocked.stage, 'connection_required');
  assert.deepEqual(blocked.counts, nullCounts); assert.equal(blocked.previewPlan, null); assert.equal(reads, 0);
  assert.equal(await runManualSyncOnce({ trainerId }), false);
  const truthy = await queueManualSyncRun(trainerId, randomUUID(), { companyRead: 'false', notionInventoryRead: 'false' } as never);
  assert.equal(truthy.status, 'needs_connection');
  await queueManualSyncRun(trainerId, randomUUID(), readiness);
  await runManualSyncOnce({ trainerId, readiness: { companyRead: 'false', notionInventoryRead: 'false' } as never, company: forbiddenCompany, notion: forbiddenNotion });
  assert.equal(reads, 0); assert.equal((await current(run.id)).status, 'needs_connection');
});

test('successful dry-run has no writes, separate planned-add count, hashed preview and tenant isolation', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  let writes = 0;
  const readOnlyNotion = { ...notion(['existing']), createPage: async () => { writes++; }, writeCalendar: async () => { writes++; } };
  await runManualSyncOnce(options({ company: company([member('SYNTHETIC_PRIVATE_MEMBER'), member('existing'), member('review', trainerId, { status: '\ud655\uc778\ud544\uc694', membershipActivity: 'unknown' })]), notion: readOnlyNotion }));
  const completed = await current(run.id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.mode, 'dry_run'); assert.equal(completed.progressPercent, 100);
  assert.deepEqual(completed.counts, { added: 0, skipped: 1, failed: 0, plannedAdds: 1, review: 1 });
  assert.ok(completed.finishedAt); assert.equal(writes, 0);
  assert.equal((await query('SELECT * FROM members WHERE trainer_id=$1', [trainerId])).rowCount, 0);
  assert.equal((await query('SELECT * FROM mock_notion_pages WHERE trainer_id=$1', [trainerId])).rowCount, 0);
  assert.equal((await query('SELECT * FROM jobs WHERE trainer_id=$1', [trainerId])).rowCount, 0);
  const persisted = (await query<{ data: unknown }>('SELECT row_to_json(r) AS data FROM manual_sync_runs r WHERE trainer_id=$1', [trainerId])).rows[0]!.data;
  assert.doesNotMatch(JSON.stringify(persisted), /SYNTHETIC_PRIVATE/);
  assert.equal((await listManualSyncRuns(otherTrainer)).length, 0);
});

test('partial company read retries with null counts and no partial data or raw provider error persisted', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  const partial: CompanyAdapter = { listMembers: async ({ cursor }) => {
    if (cursor !== null) throw new RetryableError('SYNTHETIC_PRIVATE_ERROR_TOKEN', 60000);
    return { members: [member('SYNTHETIC_PRIVATE_MEMBER')], nextCursor: 'SYNTHETIC_PRIVATE_CURSOR', scope: 'all_assigned', completeCoverage: true, snapshotId: 'SYNTHETIC_PRIVATE_SNAPSHOT' };
  } };
  await runManualSyncOnce(options({ company: partial }));
  const retry = await current(run.id);
  assert.equal(retry.status, 'retry'); assert.equal(retry.errorCode, 'READ_RATE_LIMITED');
  assert.deepEqual(retry.counts, nullCounts); assert.equal(retry.previewPlan, null);
  const persisted = (await query<{ data: { company_checkpoint: unknown } }>('SELECT row_to_json(r) AS data FROM manual_sync_runs r WHERE id=$1', [run.id])).rows[0]!.data;
  assert.equal(persisted.company_checkpoint, null); assert.doesNotMatch(JSON.stringify(persisted), /SYNTHETIC_PRIVATE/);
  await due(run.id); await runManualSyncOnce(options());
  const completed = await current(run.id); assert.equal(completed.status, 'succeeded'); assert.equal(completed.attempts, 2);
  assert.equal(completed.counts.plannedAdds, 1);
});

test('interrupted Notion inventory restarts its pagination and reuses only the complete hashed company checkpoint', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  const partialNotion: ManualSyncNotionInventory = { listIdentities: async ({ cursor }) => {
    if (cursor !== null) throw new RetryableError('SYNTHETIC_PRIVATE_NOTION_TOKEN');
    return { identities: [], nextCursor: 'SYNTHETIC_PRIVATE_CURSOR', scope: 'all_members', completeCoverage: true, snapshotId: 'SYNTHETIC_PRIVATE_SNAPSHOT' };
  } };
  await runManualSyncOnce(options({ notion: partialNotion }));
  assert.equal((await current(run.id)).status, 'retry'); assert.deepEqual((await current(run.id)).counts, nullCounts);
  const checkpoint = (await query<{ company_checkpoint: unknown }>('SELECT company_checkpoint FROM manual_sync_runs WHERE id=$1', [run.id])).rows[0]!.company_checkpoint;
  assert.ok(Array.isArray(checkpoint)); assert.doesNotMatch(JSON.stringify(checkpoint), /SYNTHETIC_PRIVATE/);
  let companyReads = 0; let notionReads = 0;
  await due(run.id);
  await runManualSyncOnce(options({ company: { listMembers: async () => { companyReads++; throw new Error('UNEXPECTED_SYNTHETIC_READ'); } },
    notion: { listIdentities: async input => { notionReads++; assert.equal(input.cursor, null); return notion().listIdentities(input); } } }));
  assert.equal(companyReads, 0); assert.equal(notionReads, 1); assert.equal((await current(run.id)).status, 'succeeded');
  assert.equal((await query<{ company_checkpoint: unknown }>('SELECT company_checkpoint FROM manual_sync_runs WHERE id=$1', [run.id])).rows[0]!.company_checkpoint, null);
});

test('missing HMAC key and invalid tenant snapshots fail before publishing counts', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  let reads = 0;
  await runManualSyncOnce(options({ previewHmacKey: undefined, company: { listMembers: async () => { reads++; throw new Error('UNEXPECTED_SYNTHETIC_READ'); } } }));
  assert.equal(reads, 0); assert.equal((await current(run.id)).errorCode, 'PREVIEW_KEY_REQUIRED');
  assert.equal((await current(run.id)).status, 'failed'); assert.deepEqual((await current(run.id)).counts, nullCounts);
  const foreign = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  await runManualSyncOnce(options({ company: company([member('synthetic-foreign', otherTrainer)]) }));
  assert.equal((await current(foreign.id)).status, 'failed'); assert.equal((await current(foreign.id)).errorCode, 'TENANT_MISMATCH');
  assert.deepEqual((await current(foreign.id)).counts, nullCounts);
  const auth = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  await runManualSyncOnce(options({ notion: { listIdentities: async () => { throw new NotionHttpError(403, 'SYNTHETIC_PRIVATE_AUTH_TOKEN'); } } }));
  assert.equal((await current(auth.id)).status, 'failed'); assert.equal((await current(auth.id)).errorCode, 'READ_AUTH_REQUIRED');
  assert.deepEqual((await current(auth.id)).counts, nullCounts);
  assert.doesNotMatch(JSON.stringify((await current(auth.id))), /SYNTHETIC_PRIVATE_AUTH_TOKEN/);
});

test('expired lease recovery retains run identity and rejects stale claim fencing', async () => {
  const run = await queueManualSyncRun(trainerId, randomUUID(), readiness);
  const initial = await claimManualSyncRun(trainerId); assert.ok(initial); assert.equal(initial.id, run.id);
  await query("UPDATE manual_sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id]);
  const recovered = await claimManualSyncRun(trainerId); assert.ok(recovered); assert.equal(recovered.id, run.id); assert.equal(recovered.attempts, 2);
  assert.notEqual(initial.leaseToken, recovered.leaseToken);
  await assert.rejects(assertManualSyncLease(initial), /MANUAL_SYNC_LEASE_LOST/);
  await assert.rejects(renewManualSyncLease(initial), /MANUAL_SYNC_LEASE_LOST/);
  await assertManualSyncLease(recovered);
  await query("UPDATE manual_sync_runs SET attempts=5,lease_until=now()-interval '1 second' WHERE id=$1", [run.id]);
  assert.equal(await claimManualSyncRun(trainerId), null);
  const failed = await current(run.id); assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'WORKER_INTERRUPTED'); assert.ok(failed.finishedAt);
  assert.deepEqual(failed.counts, nullCounts);
});

test('trainer execution advisory lock prevents overlapping read-only attempts', async () => {
  await queueManualSyncRun(trainerId, randomUUID(), readiness);
  const run = await claimManualSyncRun(trainerId); assert.ok(run);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = withManualSyncExecutionLock(run, async () => { entered(); await held; });
  await started;
  try { await assert.rejects(withManualSyncExecutionLock(run, async () => {}), /EXECUTION_BUSY/); }
  finally { release(); await first; }
});

test('eight concurrent trainers reuse their lock connections without exhausting the eight-client pool', { timeout: 15000 }, async () => {
  const trainers = Array.from({ length: 8 }, () => `manual-parallel-${randomUUID()}`);
  try {
    await Promise.all(trainers.map(id => query('INSERT INTO trainers(id,name) VALUES($1,$2)', [id, 'Synthetic parallel trainer'])));
    const queued = await Promise.all(trainers.map(id => queueManualSyncRun(id, randomUUID(), readiness)));
    await Promise.all(trainers.map(id => runManualSyncOnce(options({ trainerId: id, company: company([member('synthetic-parallel-member', id)]), notion: notion() }))));
    const completed = await Promise.all(trainers.map((id, index) => getManualSyncRun(id, queued[index]!.id)));
    assert.ok(completed.every(run => run?.status === 'succeeded'));
    assert.ok(completed.every(run => run?.counts.added === 0 && run.counts.plannedAdds === 1));
  } finally { await query('DELETE FROM trainers WHERE id=ANY($1::text[])', [trainers]); }
});

test('withdrawal preview persists exact-option proposals without creating missing request members or any external writes', async () => {
  const requestedExisting='SYNTHETIC_PRIVATE_REQUEST_EXISTING',requestedMissing='SYNTHETIC_PRIVATE_REQUEST_MISSING';
  const run=await queueManualSyncRun(trainerId,randomUUID(),readiness);
  let sourceReads=0;
  const statusMapping=verifyWithdrawalStatusMapping({optionName:'탈퇴요청',dataSourceId:'synthetic-source',propertyId:'synthetic-status',
    actualOptions:[{id:'synthetic-request-option-id',name:'탈퇴요청'}]});
  await runManualSyncOnce(options({company:company([member(requestedExisting),member(requestedMissing),member('SYNTHETIC_PRIVATE_NORMAL')]),
    notion:notion([requestedExisting]),withdrawalStatusMapping:statusMapping,withdrawalRequests:{listWithdrawalRequests:async()=>{
      sourceReads++;return {requests:[requestedExisting,requestedMissing].map(companyMemberId=>({trainerId,companyMemberId})),
        nextCursor:null,scope:'withdrawal_requests',completeCoverage:true,snapshotId:'SYNTHETIC_PRIVATE_WITHDRAWAL_SNAPSHOT'};
    }}}));
  const result=await current(run.id);
  assert.equal(result.status,'succeeded');assert.equal(sourceReads,1);
  assert.deepEqual(result.counts,{added:0,skipped:0,failed:0,plannedAdds:1,review:1});
  assert.deepEqual(result.previewPlan?.withdrawal,{coverage:'complete',requestCount:2,plannedStatusUpdates:1,calendarPolicy:'continue_existing_training'});
  const update=result.previewPlan?.members.find(item=>item.decision==='planned_status_update');
  assert.equal(update?.targetStatus,'탈퇴 요청');assert.equal(update?.targetOptionName,'탈퇴요청');assert.equal(update?.targetOptionId,'synthetic-request-option-id');
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE/);
  assert.equal((await query('SELECT * FROM members WHERE trainer_id=$1',[trainerId])).rowCount,0);
  assert.equal((await query('SELECT * FROM mock_notion_pages WHERE trainer_id=$1',[trainerId])).rowCount,0);
  assert.equal((await query('SELECT * FROM schedules WHERE trainer_id=$1',[trainerId])).rowCount,0);
});
