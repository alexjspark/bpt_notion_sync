import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManualSyncPreviewPlan, createManualSyncIdentityHasher } from '../src/manual-sync-plan.ts';
import { buildWithdrawalRequestPreview, readWithdrawalRequestSummary, verifyWithdrawalStatusMapping, WithdrawalReadError } from '../src/withdrawal-plan.ts';
import type { CompanyWithdrawalRequestInventory, VerifiedWithdrawalStatusMapping } from '../src/withdrawal-plan.ts';
import { manualSyncSafeFailure } from '../src/manual-sync.ts';
const trainerId='synthetic-request-trainer';
const hash=createManualSyncIdentityHasher(trainerId,'synthetic-withdrawal-preview-key-at-least-32-bytes');
const mapping=()=>verifyWithdrawalStatusMapping({optionName:'탈퇴요청',dataSourceId:'synthetic-source',propertyId:'synthetic-status',actualOptions:['신규','진행','탈퇴요청','탈퇴'].map((name,index)=>({id:`synthetic-option-${index}`,name}))});
function source(ids:string[]):CompanyWithdrawalRequestInventory{
  return {listWithdrawalRequests:async()=>({requests:ids.map(companyMemberId=>({trainerId,companyMemberId})),nextCursor:null,scope:'withdrawal_requests',completeCoverage:true,snapshotId:'synthetic-snapshot'})};
}
test('withdrawal requests require exactly one stable identity match and expose exact actual option',()=>{
  const requests=['one','missing','duplicate'].map(id=>({memberKey:hash(id)}));
  const result=buildWithdrawalRequestPreview(requests,new Map([[hash('one'),1],[hash('duplicate'),2]]),mapping());
  assert.deepEqual(result.find(item=>item.memberKey===hash('one')),{memberKey:hash('one'),decision:'planned_status_update',reason:'withdrawal_request_matched',targetStatus:'탈퇴 요청',targetOptionName:'탈퇴요청',targetOptionId:'synthetic-option-2'});
  assert.equal(result.find(item=>item.memberKey===hash('missing'))?.reason,'withdrawal_member_missing');
  assert.equal(result.find(item=>item.memberKey===hash('duplicate'))?.reason,'duplicate_notion_identity');
  assert.ok(result.every(item=>(item.decision as string)!=='planned_add'));
});
test('status mapping must be exact, schema verified and issued in memory; booleans/JSON cannot grant it',()=>{
  assert.throws(()=>verifyWithdrawalStatusMapping({optionName:'탈퇴 요청',dataSourceId:'synthetic',propertyId:'status',actualOptions:[{id:'synthetic',name:'탈퇴요청'}]}),/WITHDRAWAL_STATUS_MAPPING_UNVERIFIED/);
  assert.throws(()=>verifyWithdrawalStatusMapping({optionName:' 탈퇴요청 ',dataSourceId:'synthetic',propertyId:'status',actualOptions:[{id:'synthetic',name:'탈퇴요청'}]}),/WITHDRAWAL_STATUS_MAPPING_UNVERIFIED/);
  const forged=JSON.parse(JSON.stringify(mapping())) as VerifiedWithdrawalStatusMapping;
  assert.equal(buildWithdrawalRequestPreview([{memberKey:hash('one')}],new Map([[hash('one'),1]]),forged)[0]?.reason,'withdrawal_status_unverified');
  assert.equal(buildWithdrawalRequestPreview([{memberKey:hash('one')}],new Map([[hash('one'),1]]))[0]?.decision,'review');
});
test('request priority suppresses same-batch new imports, including missing and duplicated Notion members',()=>{
  const company=['matched','missing','normal'].map(id=>({memberKey:hash(id),classification:'eligible' as const,reason:null}));
  const plan=buildManualSyncPreviewPlan(company,{identities:new Map([[hash('matched'),1]]),identityCount:1},
    {withdrawalRequests:[{memberKey:hash('matched')},{memberKey:hash('missing')}],withdrawalStatusMapping:mapping()});
  assert.equal(plan.members.length,3);
  assert.equal(plan.members.find(item=>item.memberKey===hash('matched'))?.decision,'planned_status_update');
  assert.equal(plan.members.find(item=>item.memberKey===hash('missing'))?.decision,'review');
  assert.equal(plan.members.find(item=>item.memberKey===hash('normal'))?.targetStatus,'신규');
  assert.deepEqual(plan.withdrawal,{coverage:'complete',requestCount:2,plannedStatusUpdates:1,calendarPolicy:'continue_existing_training'});
  assert.ok(!('operations' in plan));
});
test('absence from request tab never proposes restoration or confirmed withdrawal',()=>{
  const plan=buildManualSyncPreviewPlan([{memberKey:hash('existing'),classification:'eligible',reason:null}],
    {identities:new Map([[hash('existing'),1]]),identityCount:1},{withdrawalRequests:[],withdrawalStatusMapping:mapping()});
  assert.deepEqual(plan.members,[{memberKey:hash('existing'),decision:'skip',reason:'already_exists'}]);
  assert.equal(plan.withdrawal.plannedStatusUpdates,0);
  assert.equal(buildManualSyncPreviewPlan([],{identities:new Map(),identityCount:0}).withdrawal.coverage,'not_connected');
});
test('withdrawal complete pagination deduplicates stable identities and emits HMAC keys only',async()=>{
  let reads=0;
  const result=await readWithdrawalRequestSummary({listWithdrawalRequests:async({cursor})=>{
    reads++;return {requests:[{trainerId,companyMemberId:cursor===null?'SYNTHETIC_PRIVATE_UID':'SYNTHETIC_PRIVATE_UID'}],
      nextCursor:cursor===null?'SYNTHETIC_PRIVATE_CURSOR':null,scope:'withdrawal_requests',completeCoverage:true,snapshotId:'SYNTHETIC_PRIVATE_SNAPSHOT'};
  }},trainerId,hash);
  assert.equal(reads,2);assert.equal(result.length,1);assert.match(result[0]!.memberKey,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE/);
});
test('withdrawal reader rejects incomplete scope, cross-tenant rows, names/URLs instead of UID, loops and changed snapshots',async()=>{
  const base=await source(['synthetic']).listWithdrawalRequests({trainerId,cursor:null,scope:'withdrawal_requests'});
  await assert.rejects(readWithdrawalRequestSummary({listWithdrawalRequests:async()=>({...base,completeCoverage:false})},trainerId,hash),/WITHDRAWAL_COVERAGE_UNVERIFIED/);
  await assert.rejects(readWithdrawalRequestSummary({listWithdrawalRequests:async()=>({...base,requests:[{trainerId:'other',companyMemberId:'synthetic'}]})},trainerId,hash),/TENANT_MISMATCH/);
  await assert.rejects(readWithdrawalRequestSummary(source(['https://example.com/member']),trainerId,hash),/WITHDRAWAL_IDENTITY_INVALID/);
  await assert.rejects(readWithdrawalRequestSummary({listWithdrawalRequests:async()=>({...base,nextCursor:'same'})},trainerId,hash),/WITHDRAWAL_PAGINATION_INVALID/);
  let calls=0;
  await assert.rejects(readWithdrawalRequestSummary({listWithdrawalRequests:async()=>({...base,nextCursor:calls===0?'next':null,snapshotId:`synthetic-${calls++}`})},trainerId,hash),/WITHDRAWAL_SNAPSHOT_CHANGED/);
});
test('withdrawal guards stop reads before lost leases and failures use allowlisted codes',async()=>{
  let calls=0;
  await assert.rejects(readWithdrawalRequestSummary({listWithdrawalRequests:async()=>{calls++;throw new Error('unexpected');}},trainerId,hash,async()=>{throw new Error('lease lost');}),/lease lost/);
  assert.equal(calls,0);
  assert.deepEqual(manualSyncSafeFailure(new WithdrawalReadError('WITHDRAWAL_SNAPSHOT_CHANGED',true)),{code:'WITHDRAWAL_SNAPSHOT_CHANGED',retryable:true,retryAfterMs:0});
});
