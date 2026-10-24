import {test}from'node:test';import assert from'node:assert/strict';
import {syntheticMembers}from'@trainer/db';
import {ScopedTeamAdapterPreview,type TeamPreviewInput}from'../src/team-adapter-preview.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const input=(tenantId:string):TeamPreviewInput=>({tenantId,connectionId:A,revision:1,sessionId:B,handle:'synthetic',binding:{accountId:'synthetic',trainerId:'synthetic'},destination:{databaseId:A,dataSourceId:B,templateId:A},token:'SYNTHETIC_TOKEN',assertCurrent:async()=>{}});
function adapters(tenantId:string,unknown=0,wrong=false){
 const m={...syntheticMembers(tenantId)[0]!,companyMemberId:'SYNTHETIC_SHARED_UID'};
 return{
  company:{listMembers:async()=>({members:[{...m,trainerId:wrong?'wrong-tenant':tenantId}],nextCursor:null,scope:'all_assigned' as const,completeCoverage:true,snapshotId:'synthetic'})},
  notion:{listIdentities:async()=>({identities:unknown?[]:[{trainerId:tenantId,companyMemberId:m.companyMemberId,pageId:'synthetic-page'}],nextCursor:null,scope:'all_members' as const,completeCoverage:true,snapshotId:'synthetic'}),
   ...(unknown?{listPreviewIdentitiesPartial:async()=>({identities:[],reviewRows:Array.from({length:unknown},(_,i)=>({pageId:'synthetic-unknown-'+i,label:'SYNTHETIC',reason:'missing_admin_url' as const})),queryCoverage:'complete' as const,identityCoverage:'partial' as const,canProveAbsence:false,snapshotId:'synthetic'})}:{})},
  withdrawals:{listWithdrawalRequests:async()=>({requests:[],nextCursor:null,scope:'withdrawal_requests' as const,completeCoverage:true,snapshotId:'synthetic'})}
 };
}
test('scoped adapter uses existing planner with identical source UID in A/B; fresh adapters every run, summary only',async()=>{
 const seen:string[]=[];let guards=0;const p=new ScopedTeamAdapterPreview(async i=>{seen.push(i.tenantId);return adapters(i.tenantId);},Buffer.alloc(32,2));
 for(const tenantId of[A,B,A]){const r=await p.preview({...input(tenantId),assertCurrent:async()=>{guards++;}});assert.deepEqual(r,{members:1,matched:1,held:0,creates:0,updates:0});assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SHARED_UID'));}
 assert.deepEqual(seen,[A,B,A]);assert.ok(guards>=20);
});
test('unknown Notion identity rows block duplicate-prone creation without name matching',async()=>{
 const p=new ScopedTeamAdapterPreview(async()=>adapters(A,10),Buffer.alloc(32,2));assert.deepEqual(await p.preview(input(A)),{members:1,matched:0,held:1,creates:0,updates:0});
});
test('cross-tenant source identity and incomplete coverage are rejected before planning',async()=>{
 const p=new ScopedTeamAdapterPreview(async()=>adapters(A,0,true),Buffer.alloc(32,2));await assert.rejects(p.preview(input(A)),{code:'TENANT_MISMATCH'});
 const a=adapters(A);a.company.listMembers=async()=>({...await adapters(A).company.listMembers(),completeCoverage:false});
 const q=new ScopedTeamAdapterPreview(async()=>a,Buffer.alloc(32,2));await assert.rejects(q.preview(input(A)),{code:'COMPANY_COVERAGE_UNVERIFIED'});
});
