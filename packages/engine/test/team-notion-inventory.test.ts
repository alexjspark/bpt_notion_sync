import{test}from'node:test';import assert from'node:assert/strict';import{TeamNotionInventory}from'../src/team-notion-inventory.ts';
const d={databaseId:'11111111-1111-4111-8111-111111111111',dataSourceId:'22222222-2222-4222-8222-222222222222',templateId:'33333333-3333-4333-8333-333333333333'};
function fixture(unknown=false,conflict=false){
 return new TeamNotionInventory('synthetic-tenant','SYNTHETIC_TOKEN',d,async r=>({status:200,body:r.url.endsWith('/query')?{results:[{id:'synthetic-page',parent:{data_source_id:d.dataSourceId},properties:{admin:{id:'admin',type:'url',url:unknown?null:'https://admin.biz-pt.com/manage/members/SYNTHETIC_UID'},status:{id:'status',type:'select',select:{name:'진행'}},uid:{id:'uid',type:'rich_text',rich_text:[{plain_text:conflict?'DIFFERENT_UID':'SYNTHETIC_UID'}]}}}],has_more:false,next_cursor:null}:r.url.includes('/databases/')?{id:d.databaseId,data_sources:[{id:d.dataSourceId}]}:{id:d.dataSourceId,parent:{database_id:d.databaseId},properties:{admin:{id:'admin',name:'어드민',type:'url'},status:{id:'status',name:'상태',type:'select',select:{options:[{id:'withdraw',name:'탈퇴요청'}]}},uid:{id:'uid',name:'UID',type:'rich_text'}}}}),async()=>{});
}
test('Notion inventory uses exact destination/schema and UID; no name matching or mutation',async()=>{
 const n=fixture(),r=await n.listPreviewIdentitiesPartial({trainerId:'synthetic-tenant',scope:'all_members'});assert.equal(r.identities[0]!.companyMemberId,'SYNTHETIC_UID');assert.equal(r.identityCoverage,'complete');assert.equal((await n.withdrawalMapping())!.optionName,'탈퇴요청');await assert.rejects(n.listPreviewIdentitiesPartial({trainerId:'another',scope:'all_members'}),{code:'TENANT_MISMATCH'});
});
test('missing URL holds identity; conflicting explicit UID blocks inventory without guessing',async()=>{
 const r=await fixture(true).listPreviewIdentitiesPartial({trainerId:'synthetic-tenant',scope:'all_members'});assert.equal(r.identities.length,0);assert.equal(r.reviewRows.length,1);assert.equal(r.canProveAbsence,false);
 await assert.rejects(fixture(false,true).listPreviewIdentitiesPartial({trainerId:'synthetic-tenant',scope:'all_members'}),{code:'NOTION_COVERAGE_UNVERIFIED'});
});
