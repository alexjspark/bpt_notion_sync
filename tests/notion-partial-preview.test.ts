import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialNotionAdapter } from '../packages/engine/src/live-notion.ts';
import { OfficialNotionClient } from '../packages/engine/src/live-notion-client.ts';
import type { NotionRequest, NotionResponse, NotionTransport } from '../packages/engine/src/live-notion-client.ts';
import { buildPartialManualSyncPreviewPlan, parseCompanyObservedUiSnapshot } from '../packages/engine/src/partial-manual-preview.ts';
import { createManualSyncIdentityHasher } from '../packages/engine/src/manual-sync-plan.ts';
import { verifyWithdrawalStatusMapping } from '../packages/engine/src/withdrawal-plan.ts';
import { runNotionPartialPreview } from '../scripts/notion-partial-preview.ts';

const databaseId='11111111-1111-4111-8111-111111111111',dataSourceId='22222222-2222-4222-8222-222222222222',trainerId='trainer-live-one';
const token='SYNTHETIC_PARTIAL_AUTH_NEVER_OUTPUT',privateBody='SYNTHETIC_RAW_PROVIDER_OMITTED';
const progressing='\uc9c4\ud589',requested='\ud0c8\ud1f4\uc694\uccad',newStatus='\uc2e0\uaddc';
const databaseUrl='https://api.notion.com/v1/databases/'+databaseId,sourceUrl='https://api.notion.com/v1/data_sources/'+dataSourceId,queryUrl=sourceUrl+'/query';
const config=()=>({version:1,trainerId,notion:{members:{databaseId,dataSourceId,allowedTrainerIds:[trainerId],
  identity:{mode:'exclusive-data-source-admin-url',trainerId,exclusiveOwnershipApproved:true,adminUrl:{id:'admin',type:'url'},adminOrigin:'https://admin.biz-pt.com',memberPathPrefix:'/manage/members/'},
  name:{id:'name',type:'title'},status:{id:'status',type:'select'},statuses:{},createStatus:{[newStatus]:newStatus,['\ud0c8\ud1f4 \uc694\uccad']:requested}}}});
function page(uid:string|null,id='synthetic-page-a',url: string|null=uid===null?null:'https://admin.biz-pt.com/manage/members/'+uid,status=progressing) {
  return {object:'page',id,parent:{type:'data_source_id',data_source_id:dataSourceId},properties:{
    Name:{id:'name',type:'title',title:[{type:'text',text:{content:'SYNTHETIC_LABEL_'+id}}]},
    Status:{id:'status',type:'select',select:{name:status}},Admin:{id:'admin',type:'url',url},
  },ignoredProviderText:privateBody};
}
const source=()=>({properties:{Name:{id:'name',type:'title'},Admin:{id:'admin',type:'url'},
  Status:{id:'status',type:'select',select:{options:[{id:'new-option',name:newStatus},{id:'request-option',name:requested},{id:'active-option',name:progressing}]}}}});
function harness(rows=[page('known'),page(null,'synthetic-missing')],alter?:(request:NotionRequest,queryPass:number)=>NotionResponse|undefined) {
  const requests:NotionRequest[]=[];let queryPass=0;
  const transport:NotionTransport=async request=>{
    requests.push(request);if(request.url===queryUrl)queryPass++;
    const changed=alter?.(request,queryPass);if(changed)return changed;
    if(request.url===databaseUrl)return{status:200,body:{data_sources:[{id:dataSourceId}]}};
    if(request.url===sourceUrl)return{status:200,body:source()};
    if(request.url===queryUrl)return{status:200,body:{results:rows,has_more:false,next_cursor:null,request_status:{type:'complete'}}};
    assert.fail('UNEXPECTED_READ_ROUTE');
  };
  const adapter=new OfficialNotionAdapter({client:new OfficialNotionClient({token,transport,readPermit:{approved:true},maxRateLimitRetries:0}),members:config().notion.members as never});
  return{requests,transport,adapter};
}
const observed=()=>({version:1,scope:'observed-ui-only',origin:'https://admin.biz-pt.com',memberPath:'/manage/members',
  progressHeader:'\uc9c4\ud589 \uc5ec\ubd80',progressFilter:progressing,progressFilterValue:'Y',verifiedActiveRowValue:'Y',
  progressOptions:[{label:progressing,value:'Y'},{label:'\ud0c8\ud1f4',value:'N'}],totals:{all:4,filtered:3},
  members:[{uid:'known',name:'SYNTHETIC_COMPANY_KNOWN',activity:'Y',cellCount:15},{uid:'new',name:'SYNTHETIC_COMPANY_NEW',activity:'Y',cellCount:15},{uid:'pending',name:'SYNTHETIC_COMPANY_PENDING',activity:'Y',cellCount:15}],
  requestsPath:'/manage/self-withdrawals',requestsHeading:'\ud68c\uc6d0 \ud0c8\ud1f4 \uc694\uccad \ub9ac\uc2a4\ud2b8',requestScopeConfirmedByHuman:true,
  requests:[{uid:'pending',name:'SYNTHETIC_COMPANY_PENDING',cellCount:10}]});
const hash=createManualSyncIdentityHasher(trainerId,'synthetic-partial-preview-key-32-bytes-minimum');
const mapping=()=>verifyWithdrawalStatusMapping({optionName:requested,dataSourceId,propertyId:'status',actualOptions:[{id:'request-option',name:requested}]});

test('partial inventory isolates only missing/malformed URLs and strict inventory still rejects them',async()=>{
  const h=harness([page('known'),page(null,'synthetic-missing'),page('wrong','synthetic-invalid','https://foreign.invalid/member')]);
  await assert.rejects(h.adapter.listIdentities({trainerId,cursor:null,scope:'all_members'}),/NOTION_ADMIN_URL_REQUIRED/);
  const partial=await h.adapter.listPreviewIdentitiesPartial({trainerId,scope:'all_members'});
  assert.equal(partial.identities.length,1);assert.equal(partial.identities[0]!.companyMemberId,'known');
  assert.deepEqual(partial.reviewRows.map(r=>r.reason).sort(),['invalid_admin_url','missing_admin_url']);
  assert.equal(partial.canProveAbsence,false);assert.equal(partial.identityCoverage,'partial');assert.equal(partial.queryCoverage,'complete');
  assert.equal(JSON.stringify(partial).includes('foreign.invalid'),false);assert.equal(JSON.stringify(partial).includes(token),false);
});
test('duplicate valid UIDs remain visible rather than being collapsed',async()=>{
  const h=harness([page('same','synthetic-a'),page('same','synthetic-b')]);
  const partial=await h.adapter.listPreviewIdentitiesPartial({trainerId,scope:'all_members'});
  assert.equal(partial.identities.length,2);assert.deepEqual(partial.identities.map(i=>i.companyMemberId),['same','same']);
});
test('wrong parent, duplicate page IDs, incomplete pagination and snapshot churn remain global errors',async()=>{
  const foreign=page('known');foreign.parent.data_source_id='foreign-source';
  const cases=[
    harness([foreign]),
    harness([page('known'),page('other')]),
    harness([],request=>request.url===queryUrl?{status:200,body:{results:[],has_more:false,next_cursor:null,request_status:{type:'incomplete'}}}:undefined),
    harness([], (request,pass)=>request.url===queryUrl?{status:200,body:{results:[page(pass===1?'first':'second')],has_more:false,next_cursor:null}}:undefined),
    harness([],request=>request.url===queryUrl?{status:200,body:{results:[],has_more:true,next_cursor:'repeated'}}:undefined),
  ];
  for(const h of cases)await assert.rejects(h.adapter.listPreviewIdentitiesPartial({trainerId,scope:'all_members'}));
});
test('unknown identities suppress new additions while unique reads and UID-matched withdrawal plans survive',()=>{
  const company=['known','new','pending','duplicate'].map(id=>({memberKey:hash(id),classification:'eligible' as const,reason:null}));
  const plan=buildPartialManualSyncPreviewPlan(company,{identityCount:4,identities:new Map([[hash('known'),1],[hash('pending'),1],[hash('duplicate'),2]])},
    {unknownNotionIdentityRows:1,withdrawalRequests:[{memberKey:hash('pending')},{memberKey:hash('missing-request')}],withdrawalStatusMapping:mapping()});
  const byKey=new Map(plan.members.map(m=>[m.memberKey,m]));
  assert.equal(byKey.get(hash('known'))!.decision,'skip');
  assert.deepEqual(byKey.get(hash('new')),{memberKey:hash('new'),decision:'review',reason:'notion_identity_unresolved'});
  assert.equal(byKey.get(hash('pending'))!.decision,'planned_status_update');assert.equal(byKey.get(hash('duplicate'))!.decision,'review');
  assert.equal(byKey.get(hash('missing-request'))!.reason,'withdrawal_member_missing');
  assert.equal(plan.members.filter(m=>m.memberKey===hash('pending')).length,1);
  assert.equal(plan.ordinaryRuntimeReady,false);assert.equal(plan.sourceScope,'observed-ui-only');assert.equal(plan.withdrawal.calendarPolicy,'continue_existing_training');
});
test('complete valid identities allow ordinary missing-member preview without granting runtime readiness',()=>{
  const plan=buildPartialManualSyncPreviewPlan([{memberKey:hash('new'),classification:'eligible',reason:null}],{identityCount:0,identities:new Map()},
    {unknownNotionIdentityRows:0,withdrawalRequests:[]});
  assert.equal(plan.members[0]!.decision,'planned_add');assert.equal(plan.members[0]!.targetStatus,newStatus);assert.equal(plan.ordinaryRuntimeReady,false);
});
test('UI snapshot parser rejects N/unknown activity, wrong request screen, duplicate UID and wrong option meaning',()=>{
  const good=observed();assert.equal(parseCompanyObservedUiSnapshot(good).members.length,3);
  const badActivity=observed();badActivity.members[0]!.activity='N';
  const wrongRoute=observed();wrongRoute.requestsPath='/manage/withdrawal-requests';
  const duplicate=observed();duplicate.members[1]!.uid='known';
  const wrongOption=observed();wrongOption.progressOptions[0]!.value='N';
  for(const value of [badActivity,wrongRoute,duplicate,wrongOption])assert.throws(()=>parseCompanyObservedUiSnapshot(value),/UI_SNAPSHOT_INVALID/);
});
test('partial service reads only approved inputs/routes and publishes counts without names/IDs/credentials',async()=>{
  const h=harness([page('known'),page('pending','synthetic-pending'),page(null,'synthetic-unidentified')]),reads:string[]=[];
  const result=await runNotionPartialPreview({configFile:'/virtual/config',tokenFile:'/virtual/auth',companySnapshotFile:'/virtual/ui'},{
    readText:async path=>{reads.push(path);if(path==='/virtual/config')return JSON.stringify(config());if(path==='/virtual/ui')return JSON.stringify(observed());if(path==='/virtual/auth')return token;throw new Error('UNEXPECTED_READER');},
    transport:h.transport,
  });
  assert.deepEqual(reads,['/virtual/config','/virtual/ui','/virtual/auth']);
  assert.equal(result.report.plannedAdds,0);assert.equal(result.report.plannedStatusUpdates,1);assert.equal(result.report.preservedCompanyMembers,1);
  assert.equal(result.report.heldCompanyMembers,1);assert.equal(result.report.heldNotionRows,1);assert.equal(result.report.status,'partial');
  assert.equal(result.report.externalWritesEnabled,false);assert.equal(result.report.automaticSyncEnabled,false);assert.equal(result.report.ordinaryRuntimeReady,false);
  const output=JSON.stringify(result.report);for(const text of [token,privateBody,'known','pending','SYNTHETIC_COMPANY','synthetic-page'])assert.equal(output.includes(text),false);
  assert.equal(JSON.stringify(result.detail).includes(token),false);assert.equal(JSON.stringify(result.detail).includes(privateBody),false);
  assert.ok(h.requests.every(r=>r.method==='GET'||r.method==='POST'&&r.url===queryUrl));
  assert.equal(h.requests.filter(r=>r.url===queryUrl).length,2);
});
test('invalid observed UI input is rejected before any authentication read or request',async()=>{
  const reads:string[]=[];const invalid=observed();invalid.members[0]!.activity='';
  await assert.rejects(runNotionPartialPreview({configFile:'/virtual/config',tokenFile:'/virtual/auth',companySnapshotFile:'/virtual/ui'},{
    readText:async path=>{reads.push(path);if(path==='/virtual/config')return JSON.stringify(config());if(path==='/virtual/ui')return JSON.stringify(invalid);throw new Error('AUTH_MUST_NOT_BE_READ');},
    transport:async()=>assert.fail('NO_NETWORK'),
  }));
  assert.deepEqual(reads,['/virtual/config','/virtual/ui']);
});
test('an already requested exact option is preserved without a redundant status-change plan',async()=>{
  const h=harness([page('known'),page('pending','synthetic-pending',undefined,requested),page(null,'synthetic-unidentified')]);
  const result=await runNotionPartialPreview({configFile:'/virtual/config',tokenFile:'/virtual/auth',companySnapshotFile:'/virtual/ui'},{
    readText:async path=>path==='/virtual/config'?JSON.stringify(config()):path==='/virtual/ui'?JSON.stringify(observed()):token,transport:h.transport,
  });
  const target=result.detail.targets.find(t=>t.companyMemberId==='pending')!;
  assert.equal(target.decision,'skip');assert.equal(target.reason,'withdrawal_status_already_set');
  assert.equal('targetStatus' in target,false);assert.equal(result.report.plannedStatusUpdates,0);assert.equal(result.report.preservedCompanyMembers,2);
  assert.equal(result.report.calendarPolicy,'continue_existing_training');
});
