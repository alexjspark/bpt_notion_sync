import test from'node:test';import assert from'node:assert/strict';
import{OfficialNotionClient,NotionWriteUncertainError,object}from'../src/live-notion-client.ts';import type{NotionTransport}from'../src/live-notion-client.ts';
import{MemberInfoStore,discoverMemberInfoSchema,pageProperty,notionText}from'../src/member-info-store.ts';
import{createIsolatedStorageTransport,TEST_VALUES}from'../src/isolated-storage-scope.ts';
const db='11111111-1111-4111-8111-111111111111',ds='22222222-2222-4222-8222-222222222222',uid='trainersync-test-11111111-2222-4333-8444-555555555555',title='TEST TrainerSync | '+uid;
function harness(uncertain=false){
 let page:any=null,creates=0,patches:any[]=[],throwOnce=uncertain;
 const fields=[['\ud68c\uc6d0\uba85','title','title'],['\uc0c1\ud0dc','status','select'],['\uc5b4\ub4dc\ubbfc','admin','url'],['\uc804\ud654\ubc88\ud638','phone','phone_number'],['\uc774\uba54\uc77c','email','email'],['\uccab \ud2b8\ub808\uc774\ub2dd','date','date']];
 const schema=Object.fromEntries(fields.map(([name,id,type])=>[name!,{id,name,type,...(type==='select'?{select:{options:[{name:'\uc2e0\uaddc'},{name:'\uc720\uc608'}]}}:{})}]));
 const transport:NotionTransport=async req=>{const path=new URL(req.url).pathname.replace('/v1',''),b=req.body as any;
  if(path==='/databases/'+db)return{status:200,body:{data_sources:[{id:ds}]}};
  if(path==='/data_sources/'+ds)return{status:200,body:{id:ds,parent:{database_id:db},properties:schema}};
  if(path==='/data_sources/'+ds+'/query')return{status:200,body:{results:page&&!page.in_trash&&page.properties.admin.url===b.filter.url.equals?[structuredClone(page)]:[],has_more:false,next_cursor:null}};
  if(req.method==='POST'&&path==='/pages'){creates++;page={id:'synthetic-page',parent:{data_source_id:ds},in_trash:false,properties:{},body:'SYNTHETIC_BODY'};for(const[id,value]of Object.entries(b.properties))page.properties[id]={id,type:Object.keys(value as object)[0],...(value as object)};page.properties.date={id:'date',type:'date',date:null};if(throwOnce){throwOnce=false;throw new Error('SYNTHETIC_UNCERTAIN_AFTER_COMMIT');}return{status:200,body:structuredClone(page)};}
  if(path==='/pages/synthetic-page'&&req.method==='GET')return{status:200,body:structuredClone(page)};
  if(path==='/pages/synthetic-page'&&req.method==='PATCH'){patches.push(structuredClone(b));if(typeof b.in_trash==='boolean')page.in_trash=b.in_trash;else for(const[id,value]of Object.entries(b.properties))page.properties[id]={id,type:Object.keys(value as object)[0],...(value as object)};return{status:200,body:structuredClone(page)};}
  throw new Error('UNEXPECTED_TEST_ROUTE');};
 const client=new OfficialNotionClient({isolatedTestScope:()=>({dataSourceId:ds,pageId:'synthetic-page',testId:uid}),token:'SYNTHETIC_TOKEN_NEVER_OUTPUT',readPermit:{approved:true},writePermit:{approved:true},transport,maxRateLimitRetries:0});
 return{client,transport,page:()=>page,creates:()=>creates,patches};
}
const input={uid,name:title,phone:TEST_VALUES.phone,email:TEST_VALUES.email,createStatus:'\uc2e0\uaddc'};
test('shared member store creates once, preserves manual data and holds empty-field patches without atomic preconditions',async()=>{
 const h=harness(),s=await discoverMemberInfoSchema(h.client,db,ds),store=new MemberInfoStore(h.client,s);let known:string|undefined,attempts=0;
 const options=()=>({knownPageId:known,allowCreate:known===undefined,beforeCreate:async()=>{attempts++;},created:async(id:string)=>{known=id;},guard:async()=>{}});
 const first=await store.save(input,options());assert.equal(first.created,true);assert.equal(h.creates(),1);assert.equal(attempts,1);
 assert.equal(pageProperty(h.page(),s.phone).phone_number,TEST_VALUES.phone);assert.equal(pageProperty(h.page(),s.email).email,TEST_VALUES.email);
 const replay=await store.save(input,options());assert.equal(replay.created,false);assert.deepEqual(replay.updatedFields,[]);assert.equal(h.creates(),1);
 h.page().properties.phone.phone_number=TEST_VALUES.manualPhone;h.page().properties.email.email=TEST_VALUES.manualEmail;
 h.page().properties.status.select.name='\uc720\uc608';h.page().properties.date.date={start:'2099-01-01'};h.page().body='USER_EDIT_PRESERVE';
 const before=structuredClone(h.page());assert.deepEqual((await store.save(input,options())).updatedFields,[]);assert.deepEqual(h.page(),before);
 h.page().properties.email.email=null;
 const filled=await store.save({...input,name:'SOURCE_NAME_MUST_NOT_REPLACE',email:TEST_VALUES.filledEmail},options());
 assert.deepEqual(filled.updatedFields,[]);assert.deepEqual(filled.deferredFields,['email']);assert.equal(filled.deferredReason,'NOTION_ATOMIC_COMPARE_AND_SET_UNAVAILABLE');assert.equal(filled.outcome,'held');assert.equal(filled.verified,false);assert.equal(h.page().properties.email.email,null);assert.equal(h.page().properties.phone.phone_number,TEST_VALUES.manualPhone);
 assert.equal(h.page().properties.status.select.name,'\uc720\uc608');assert.equal(h.page().properties.date.date.start,'2099-01-01');
 assert.equal(h.page().body,'USER_EDIT_PRESERVE');assert.equal(h.page().properties.title.title[0].text.content,title);
 assert.equal(h.patches.length,0);
});
test('uncertain creation is reconciled by exact UID and known page without another POST',async()=>{
 const h=harness(true),s=await discoverMemberInfoSchema(h.client,db,ds),store=new MemberInfoStore(h.client,s);let attempted=false;
 await assert.rejects(store.save(input,{allowCreate:true,beforeCreate:async()=>{attempted=true;},guard:async()=>{}}),NotionWriteUncertainError);
 assert.equal(attempted,true);const found=await store.find(uid);assert.ok(found);const replay=await store.save(input,{knownPageId:String(found.id),allowCreate:false,guard:async()=>{}});
 assert.equal(replay.created,false);assert.equal(h.creates(),1);
});
test('ordinary trash stays forbidden; isolated cleanup requires the exact TEST identity and is idempotent',async()=>{
 const h=harness(),s=await discoverMemberInfoSchema(h.client,db,ds),store=new MemberInfoStore(h.client,s);
 await store.save(input,{allowCreate:true,guard:async()=>{}});
 await assert.rejects(h.client.write('PATCH','/pages/synthetic-page',{in_trash:true}),/NOTION_DESTRUCTIVE_WRITE_FORBIDDEN/);
 await assert.rejects(h.client.trashIsolatedTestPage({pageId:'synthetic-page',dataSourceId:ds,titlePropertyId:s.name,adminPropertyId:s.admin,testId:'900001',title}),/ISOLATED_TRASH_SCOPE_INVALID/);
 const target={pageId:'synthetic-page',dataSourceId:ds,titlePropertyId:s.name,adminPropertyId:s.admin,testId:uid,title};
 await h.client.trashIsolatedTestPage(target);assert.equal(h.page().in_trash,true);const writes=h.patches.length;
 await h.client.trashIsolatedTestPage(target);assert.equal(h.patches.length,writes);await h.client.restoreIsolatedTestPage(target);assert.equal(h.page().in_trash,false);await assert.rejects(h.client.restoreIsolatedTestPage({...target,testId:'real-member'}),/ISOLATED_TRASH_SCOPE_INVALID/);
});
test('last transport boundary rejects real-page writes and any second creation',async()=>{
 const h=harness(),s=await discoverMemberInfoSchema(h.client,db,ds);let forwarded=0;
 const transport=createIsolatedStorageTransport({destination:{databaseId:db,dataSourceId:ds},scope:()=>({testId:uid,pageId:'synthetic-page',createAttempted:true}),schema:()=>s,delegate:async req=>{forwarded++;return h.transport(req);},beforeWrite:async()=>{},created:async()=>{}});
 await assert.rejects(transport({method:'PATCH',url:'https://api.notion.com/v1/pages/real-member',headers:{},body:{properties:{phone:{phone_number:TEST_VALUES.phone}}}}),/ISOLATED_TRANSPORT_SCOPE_REJECTED/);
 await assert.rejects(transport({method:'POST',url:'https://api.notion.com/v1/pages',headers:{},body:{}}),/ISOLATED_TRANSPORT_SCOPE_REJECTED/);
 assert.equal(forwarded,0);
});

test('stale empty-field read cannot cause a PATCH that overwrites a concurrent manual edit',async()=>{
 const h=harness(),s=await discoverMemberInfoSchema(h.client,db,ds),setup=new MemberInfoStore(h.client,s);await setup.save(input,{allowCreate:true,guard:async()=>{}});h.page().properties.email.email=null;
 let reads=0,injected=false,patches=0;const transport:NotionTransport=async req=>{if(req.method==='PATCH')patches++;const target=req.method==='GET'&&new URL(req.url).pathname==='/v1/pages/synthetic-page';if(target)reads++;const response=await h.transport(req);if(target&&reads===2){h.page().properties.email.email=TEST_VALUES.manualEmail;h.page().body='CONCURRENT_MANUAL_BODY';injected=true;}return response;};
 const client=new OfficialNotionClient({token:'SYNTHETIC_TEST_ONLY',readPermit:{approved:true},writePermit:{approved:true},transport});const result=await new MemberInfoStore(client,s).save(input,{knownPageId:'synthetic-page',allowCreate:false,guard:async()=>{}});
 assert.equal(injected,true);assert.equal(patches,0);assert.deepEqual(result.deferredFields,['email']);assert.equal(result.outcome,'held');assert.equal(h.page().properties.email.email,TEST_VALUES.manualEmail);assert.equal(h.page().body,'CONCURRENT_MANUAL_BODY');
});
