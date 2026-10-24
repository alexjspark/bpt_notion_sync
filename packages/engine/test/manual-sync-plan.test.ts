import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member } from '@trainer/core';
import type { CompanyAdapter, CompanyPage } from '../src/ports.ts';
import { RetryableError } from '../src/ports.ts';
import { NotionAccessDeniedError, NotionHttpError } from '../src/live-notion-client.ts';
import { CompanyDomError } from '../src/live-company-dom.ts';
import {
  buildManualSyncPreviewPlan, createManualSyncIdentityHasher, ManualSyncError,
  readManualSyncCompanySummary, readManualSyncNotionSummary,
} from '../src/manual-sync-plan.ts';
import type { ManualSyncNotionInventory } from '../src/manual-sync-plan.ts';
import { manualSyncSafeFailure, UNCONNECTED_MANUAL_SYNC_READINESS } from '../src/manual-sync.ts';

const trainerId = 'synthetic-trainer';
const key = 'synthetic-preview-key-for-unit-tests-only-32-bytes';
const hash = createManualSyncIdentityHasher(trainerId, key);
function member(id: string, overrides: Partial<Member> = {}): Member {
  return { trainerId, companyMemberId: id, name: 'SYNTHETIC_SENSITIVE_NAME', status: '\uc9c4\ud589', notionPageId: null,
    registrationDate: null, assignmentDate: null, assignmentEvidence: 'existing', membershipActivity: 'active',
    memo: 'SYNTHETIC_SENSITIVE_MEMO', fixedSlot: null, firstTrainingDate: null, callAt: null,
    survey: [{ question: 'SYNTHETIC_SENSITIVE_QUESTION', answer: 'SYNTHETIC_SENSITIVE_ANSWER' }], manualContent: 'SYNTHETIC_SENSITIVE_TEXT', ...overrides };
}
function company(members: Member[]): CompanyAdapter {
  return { listMembers: async () => ({ members, nextCursor: null, scope: 'all_assigned', completeCoverage: true, snapshotId: 'synthetic-snapshot' }) };
}
function inventory(ids: string[]): ManualSyncNotionInventory {
  return { listIdentities: async () => ({ identities: ids.map((id, index) => ({ trainerId, companyMemberId: id, pageId: `synthetic-page-${index}` })),
    nextCursor: null, scope: 'all_members', completeCoverage: true, snapshotId: 'synthetic-notion-snapshot' }) };
}

test('default connection readiness is frozen and disabled; failures contain only fixed codes', () => {
  assert.deepEqual(UNCONNECTED_MANUAL_SYNC_READINESS, { companyRead: false, notionInventoryRead: false });
  assert.ok(Object.isFrozen(UNCONNECTED_MANUAL_SYNC_READINESS));
  assert.deepEqual(manualSyncSafeFailure(new Error('SYNTHETIC_SECRET_ERROR')), { code: 'READ_FAILED', retryable: true, retryAfterMs: 0 });
  assert.deepEqual(manualSyncSafeFailure(new RetryableError('SYNTHETIC_SECRET_ERROR', 60000)), { code: 'READ_RATE_LIMITED', retryable: true, retryAfterMs: 60000 });
  assert.equal(manualSyncSafeFailure(new ManualSyncError('TENANT_MISMATCH')).retryable, false);
  assert.equal(manualSyncSafeFailure(new ManualSyncError('SYNTHETIC_PRIVATE_TOKEN' as never)).code, 'READ_FAILED');
  assert.deepEqual(manualSyncSafeFailure(new NotionHttpError(401, 'SYNTHETIC_PRIVATE_TOKEN')), { code: 'READ_AUTH_REQUIRED', retryable: false, retryAfterMs: 0 });
  assert.equal(manualSyncSafeFailure(new NotionHttpError(403, 'SYNTHETIC_PRIVATE_TOKEN')).code, 'READ_AUTH_REQUIRED');
  assert.equal(manualSyncSafeFailure(new CompanyDomError('COMPANY_AUTH_REQUIRED')).code, 'READ_AUTH_REQUIRED');
  assert.equal(manualSyncSafeFailure(new CompanyDomError('COMPANY_AUTH_SYNTHETIC_PRIVATE_TOKEN')).code, 'READ_FAILED');
  assert.equal(manualSyncSafeFailure(new NotionAccessDeniedError('read')).code, 'READ_FAILED');
});

test('complete inventories produce additions, skips and reviews using hashed keys only', async () => {
  const companySummary = await readManualSyncCompanySummary(company([
    member('SYNTHETIC_RAW_ID_ADD'), member('existing'), member('unknown', { status: '\ud655\uc778\ud544\uc694' }),
    member('inactive', { status: '\uc720\uc608' }), member('unknown-activity', { membershipActivity: 'unknown' }),
    member('withdrawn', { membershipActivity: 'withdrawn' }), member('duplicate'),
  ]), trainerId, hash);
  const notionSummary = await readManualSyncNotionSummary(inventory(['existing', 'duplicate', 'duplicate']), trainerId, hash);
  const plan = buildManualSyncPreviewPlan(companySummary, notionSummary);
  assert.equal(plan.members.filter(item => item.decision === 'planned_add').length, 3);
  assert.equal(plan.members.filter(item => item.decision === 'skip').length, 2);
  assert.equal(plan.members.filter(item => item.decision === 'review').length, 2);
  assert.ok(plan.members.filter(item => item.decision === 'planned_add').every(item => item.targetStatus === '신규'));
  assert.equal(plan.sourceScope, 'active-assigned');
  assert.equal(plan.members.find(item => item.memberKey === hash('duplicate'))?.reason, 'duplicate_notion_identity');
  assert.equal(plan.companyCount, 7); assert.equal(plan.notionIdentityCount, 3);
  const serialized = JSON.stringify({ companySummary, plan });
  assert.doesNotMatch(serialized, /SYNTHETIC_(?:RAW_ID|SENSITIVE)/);
  assert.ok(plan.members.every(item => /^[a-f0-9]{64}$/.test(item.memberKey)));
});

test('company activity does not impersonate Notion workflow; active missing members are proposed as 신규', async () => {
  const summary = await readManualSyncCompanySummary(company([member('synthetic-unknown', { status: 'unmapped-status' as Member['status'] })]), trainerId, hash);
  const plan = buildManualSyncPreviewPlan(summary, await readManualSyncNotionSummary(inventory([]), trainerId, hash));
  assert.equal(plan.members[0]!.decision, 'planned_add'); assert.equal(plan.members[0]!.targetStatus, '신규');
});

test('HMAC identities require a strong injected key and separate trainers and secrets', () => {
  assert.throws(() => createManualSyncIdentityHasher(trainerId, 'short'), /PREVIEW_KEY_REQUIRED/);
  assert.notEqual(hash('1'), createManualSyncIdentityHasher('other-synthetic-trainer', key)('1'));
  assert.notEqual(hash('1'), createManualSyncIdentityHasher(trainerId, `${key}-changed`)('1'));
  assert.equal(hash('1'), createManualSyncIdentityHasher(trainerId, key)('1'));
});

test('company collection rejects incomplete coverage, tenant mismatch and conflicting duplicates', async () => {
  const invalid: CompanyPage = { members: [], nextCursor: null, scope: 'all_assigned', completeCoverage: false, snapshotId: 'synthetic' };
  await assert.rejects(readManualSyncCompanySummary({ listMembers: async () => invalid }, trainerId, hash), /COMPANY_COVERAGE_UNVERIFIED/);
  await assert.rejects(readManualSyncCompanySummary(company([member('foreign', { trainerId: 'other-synthetic' })]), trainerId, hash), /TENANT_MISMATCH/);
  await assert.rejects(readManualSyncCompanySummary(company([member('duplicate'), member('duplicate', { memo: 'synthetic changed' })]), trainerId, hash), /COMPANY_CONFLICTING_DUPLICATE/);
});

test('company collection validates a consistent snapshot and finite nonlooping pagination', async () => {
  let calls = 0;
  const changed: CompanyAdapter = { listMembers: async () => ({ members: [], nextCursor: calls === 0 ? 'next' : null,
    scope: 'all_assigned', completeCoverage: true, snapshotId: `synthetic-${calls++}` }) };
  await assert.rejects(readManualSyncCompanySummary(changed, trainerId, hash), /COMPANY_SNAPSHOT_CHANGED/);
  const loop: CompanyAdapter = { listMembers: async () => ({ members: [], nextCursor: 'same', scope: 'all_assigned', completeCoverage: true, snapshotId: 'synthetic' }) };
  await assert.rejects(readManualSyncCompanySummary(loop, trainerId, hash), /COMPANY_PAGINATION_INVALID/);
});

test('Notion collection rejects incomplete coverage, cross-tenant identities, loops and changing snapshots', async () => {
  const base = await inventory(['synthetic-member']).listIdentities({ trainerId, cursor: null, scope: 'all_members' });
  await assert.rejects(readManualSyncNotionSummary({ listIdentities: async () => ({ ...base, completeCoverage: false }) }, trainerId, hash), /NOTION_COVERAGE_UNVERIFIED/);
  await assert.rejects(readManualSyncNotionSummary({ listIdentities: async () => ({ ...base, identities: [{ trainerId: 'other-synthetic', companyMemberId: 'synthetic', pageId: 'synthetic-page' }] }) }, trainerId, hash), /TENANT_MISMATCH/);
  await assert.rejects(readManualSyncNotionSummary({ listIdentities: async () => ({ ...base, nextCursor: 'same' }) }, trainerId, hash), /NOTION_PAGINATION_INVALID/);
  let calls = 0;
  await assert.rejects(readManualSyncNotionSummary({ listIdentities: async () => ({ ...base, nextCursor: calls === 0 ? 'next' : null, snapshotId: `synthetic-${calls++}` }) }, trainerId, hash), /NOTION_SNAPSHOT_CHANGED/);
});

test('Notion repeated pages for the same identity dedupe while different pages request review', async () => {
  const page = { trainerId, companyMemberId: 'synthetic-member', pageId: 'synthetic-page' };
  const summary = await readManualSyncNotionSummary({ listIdentities: async () => ({ identities: [page, page], nextCursor: null,
    scope: 'all_members', completeCoverage: true, snapshotId: 'synthetic' }) }, trainerId, hash);
  assert.equal(summary.identityCount, 1); assert.equal(summary.identities.get(hash('synthetic-member')), 1);
});

test('read guards fence every page and prevent further processing after lease loss', async () => {
  let reads = 0;
  const fenced: CompanyAdapter = { listMembers: async () => { reads++; return { members: [], nextCursor: null,
    scope: 'all_assigned', completeCoverage: true, snapshotId: 'synthetic' }; } };
  await assert.rejects(readManualSyncCompanySummary(fenced, trainerId, hash, async () => { throw new ManualSyncError('MANUAL_SYNC_LEASE_LOST'); }), /MANUAL_SYNC_LEASE_LOST/);
  assert.equal(reads, 0);
});

test('exact existing withdrawal option is a no-op in the ordinary planner too',async()=>{
  const {buildManualSyncPreviewPlan,createManualSyncIdentityHasher,verifyWithdrawalStatusMapping}=await import('../src/manual-sync-plan.ts');
  const hash=createManualSyncIdentityHasher('synthetic-idempotency','synthetic-idempotency-key-at-least-32-bytes');
  const key=hash('synthetic-existing');
  const mapping=verifyWithdrawalStatusMapping({optionName:'\ud0c8\ud1f4\uc694\uccad',dataSourceId:'synthetic-source',propertyId:'synthetic-status',actualOptions:[{id:'synthetic-option',name:'\ud0c8\ud1f4\uc694\uccad'}]});
  const plan=buildManualSyncPreviewPlan([{memberKey:key,classification:'eligible',reason:null}],
    {identityCount:1,identities:new Map([[key,1]]),existingStatuses:new Map([[key,'\ud0c8\ud1f4\uc694\uccad']])},
    {withdrawalRequests:[{memberKey:key}],withdrawalStatusMapping:mapping});
  assert.deepEqual(plan.members,[{memberKey:key,decision:'skip',reason:'withdrawal_status_already_set'}]);
  assert.equal(plan.withdrawal.plannedStatusUpdates,0);
  const duplicated=buildManualSyncPreviewPlan([],{identityCount:2,identities:new Map([[key,2]]),existingStatuses:new Map([[key,mapping.optionName]])},{withdrawalRequests:[{memberKey:key}],withdrawalStatusMapping:mapping});
  assert.equal(duplicated.members[0]!.reason,'duplicate_notion_identity');
});

test('ordinary Notion collection retains exact status only for a unique page and detects conflicting reads',async()=>{
  const {readManualSyncNotionSummary,createManualSyncIdentityHasher}=await import('../src/manual-sync-plan.ts');
  const hash=createManualSyncIdentityHasher('synthetic-status','synthetic-status-key-at-least-thirty-two-bytes');
  const inventory={listIdentities:async()=>({identities:[{trainerId:'synthetic-status',companyMemberId:'one',pageId:'page-one',existingStatus:'raw-option'}],nextCursor:null,scope:'all_members' as const,completeCoverage:true,snapshotId:'fixed'})};
  const summary=await readManualSyncNotionSummary(inventory,'synthetic-status',hash);
  assert.equal(summary.existingStatuses?.get(hash('one')),'raw-option');
  const bad={listIdentities:async()=>({identities:[{trainerId:'synthetic-status',companyMemberId:'one',pageId:'page-one',existingStatus:'a'},{trainerId:'synthetic-status',companyMemberId:'one',pageId:'page-one',existingStatus:'b'}],nextCursor:null,scope:'all_members' as const,completeCoverage:true,snapshotId:'fixed'})};
  await assert.rejects(readManualSyncNotionSummary(bad,'synthetic-status',hash),/NOTION_SNAPSHOT_CHANGED/);
});

test('ordinary partial inventory preserves known UIDs and holds unmatched additions without leaking review rows',async()=>{
  const source:ManualSyncNotionInventory={listIdentities:async()=>{throw new Error('STRICT_PATH_MUST_NOT_BE_FALLBACK');},
    listPreviewIdentitiesPartial:async()=>({identities:[{trainerId,companyMemberId:'known',pageId:'known-page',label:'SYNTHETIC_PRIVATE_NAME',existingStatus:null}],
      reviewRows:[{pageId:'unknown-page',label:'SYNTHETIC_PRIVATE_ROW',reason:'missing_admin_url'}],queryCoverage:'complete',identityCoverage:'partial',canProveAbsence:false,snapshotId:'stable-partial'})};
  const known=await readManualSyncNotionSummary(source,trainerId,hash);
  const plan=buildManualSyncPreviewPlan([{memberKey:hash('known'),classification:'eligible',reason:null},{memberKey:hash('unmatched'),classification:'eligible',reason:null}],known);
  assert.equal(plan.unresolvedNotionRows,1);assert.equal(plan.notionIdentityCoverage,'partial');
  assert.equal(plan.members.find(m=>m.memberKey===hash('known'))?.reason,'already_exists');
  assert.equal(plan.members.find(m=>m.memberKey===hash('unmatched'))?.reason,'notion_identity_unresolved');
  assert.equal(plan.members.some(m=>m.decision==='planned_add'),false);
  assert.doesNotMatch(JSON.stringify(plan),/SYNTHETIC_PRIVATE|unknown-page|known-page/);
});
