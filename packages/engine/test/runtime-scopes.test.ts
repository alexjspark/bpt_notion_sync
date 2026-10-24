import test from'node:test';import assert from'node:assert/strict';
import{parseNotionDestination,parseContactApproval,parseIsolatedTestFixture,assertRunDestination}from'../src/runtime-scopes.ts';
import{parseLiveReadOnlyConfig,LIVE_MANUAL_TRAINER_ID}from'../src/live-runtime.ts';
import{createContactSaveTransport,CONTACT_SAVE_CONSENT,validateContactTargets}from'../src/oneoff-contact-scope.ts';
import{PROFILE_SAVE_CONSENT}from'../src/oneoff-profile-scope.ts';
import{OfficialNotionClient}from'../src/live-notion-client.ts';
import{discoverNotionSchema}from'../../../scripts/notion-schema-discovery.ts';
import{runNotionSchemaDiscoveryCommand}from'../../../scripts/discover-notion-schema.ts';
const destination={databaseId:'11111111-1111-4111-8111-111111111111',dataSourceId:'22222222-2222-4222-8222-222222222222'};
const approved=[{uid:'900001',pageId:'33333333-3333-4333-8333-333333333333',name:'SYNTHETIC_MEMBER_A'},{uid:'900002',pageId:'44444444-4444-4444-8444-444444444444',name:'SYNTHETIC_MEMBER_B'}];
const fixture={suiteKey:'synthetic-suite',pageId:'55555555-5555-4555-8555-555555555555',testId:'trainersync-test-66666666-6666-4666-8666-666666666666'};
const config=()=>({version:1,trainerId:LIVE_MANUAL_TRAINER_ID,notion:{members:{...destination,allowedTrainerIds:[LIVE_MANUAL_TRAINER_ID],name:{id:'title',type:'title'},status:{id:'status',type:'select'},createStatus:{},statuses:{}}}});
test('destination comes from valid server config without a personal default, fixed tenant and write guards remain',()=>{
 assert.deepEqual(parseNotionDestination(destination),destination);
 assert.deepEqual(parseLiveReadOnlyConfig(config()).notion!.members.databaseId,destination.databaseId);
 for(const bad of [undefined,{}, {...destination,dataSourceId:destination.databaseId},{...destination,databaseId:'https://unapproved.invalid'}])assert.throws(()=>parseNotionDestination(bad));
 assert.throws(()=>parseLiveReadOnlyConfig({...config(),trainerId:'client-selected'}));
 const expanded=config();expanded.notion.members.allowedTrainerIds.push('another');assert.throws(()=>parseLiveReadOnlyConfig(expanded));
 const template=config();Object.assign(template.notion.members,{template:{id:'unapproved'}});assert.throws(()=>parseLiveReadOnlyConfig(template));
});
test('private contact approval is explicit and exact; copying source targets cannot expand an approval',()=>{
 const scope=parseContactApproval({consentKey:CONTACT_SAVE_CONSENT,targets:approved});
 const targets=approved.map(t=>({...t,fields:['phone','email']as('phone'|'email')[]}));
 assert.equal(validateContactTargets(targets,scope.targets).length,2);
 assert.throws(()=>validateContactTargets(targets,[]));
 assert.throws(()=>validateContactTargets(targets.map(t=>({...t,uid:'900099'})),scope.targets));
 for(const bad of [undefined,{consentKey:'x',targets:[approved[0]]},{consentKey:'x',targets:[approved[0],approved[0]]}])assert.throws(()=>parseContactApproval(bad));
});
test('portable config preserves optional private scopes and rejects credential-shaped extra fields',()=>{
 const c={...config(),contactSaveApproval:{consentKey:CONTACT_SAVE_CONSENT,targets:approved},isolatedTestFixture:fixture};
 const parsed=parseLiveReadOnlyConfig(c);assert.deepEqual(parsed.contactSaveApproval!.targets,approved);assert.deepEqual(parsed.isolatedTestFixture,fixture);
 assert.throws(()=>parseLiveReadOnlyConfig({...c,contactSaveApproval:{...c.contactSaveApproval,password:'SYNTHETIC_NEVER_PRINT'}}));
 assert.throws(()=>parseIsolatedTestFixture({...fixture,testId:'real-member'}));
});
test('contact boundary freezes configured targets and denies destination/schema drift before forwarding',async()=>{
 const targets=approved.map(t=>({...t,fields:['phone','email']as('phone'|'email')[]}));
 let forwarded=0;const schema={...destination,dataSourceId:'77777777-7777-4777-8777-777777777777',name:'title',status:'status',admin:'admin',phone:'phone',email:'email',firstTraining:'first'};
 const transport=createContactSaveTransport({destination,approvedTargets:approved,targets,schema:()=>schema,intended:new Map([['900001',{uid:'900001',name:'SYNTHETIC_MEMBER_A',phone:'00000000000',email:'synthetic@example.invalid'}]]),consumeWrite:async()=>{},delegate:async()=>{forwarded++;return{status:200,body:{}};}});
 await assert.rejects(transport({method:'PATCH',url:'https://api.notion.com/v1/pages/'+targets[0]!.pageId,headers:{},body:{properties:{phone:{phone_number:'00000000000'}}}}));
 await assert.rejects(transport({method:'GET',url:'https://api.notion.com/v1/databases/'+schema.dataSourceId,headers:{}}));
 assert.equal(forwarded,0);
});
test('isolated trash has no implicit source default and requires journal-owned source/page/test binding',async()=>{
 let reads=0;const client=new OfficialNotionClient({token:'SYNTHETIC_TOKEN',readPermit:{approved:true},writePermit:{approved:true},transport:async()=>{reads++;throw Error('UNEXPECTED');}});
 const input={pageId:fixture.pageId,dataSourceId:destination.dataSourceId,titlePropertyId:'title',adminPropertyId:'admin',testId:fixture.testId,title:'TEST TrainerSync | '+fixture.testId};
 await assert.rejects(client.trashIsolatedTestPage(input),/ISOLATED_TRASH_SCOPE_INVALID/);
 const wrong=new OfficialNotionClient({token:'SYNTHETIC_TOKEN',readPermit:{approved:true},writePermit:{approved:true},isolatedTestScope:()=>({...input,pageId:'77777777-7777-4777-8777-777777777777'}),transport:async()=>{reads++;throw Error('UNEXPECTED');}});
 await assert.rejects(wrong.trashIsolatedTestPage(input),/ISOLATED_TRASH_SCOPE_INVALID/);assert.equal(reads,0);
});
test('schema discovery missing destination never reads authentication and CLI requires explicit private config',async()=>{
 let reads=0;const deps={readText:async()=>{reads++;throw Error('SYNTHETIC_PRIVATE_ERROR');},transport:async()=>{throw Error('UNEXPECTED');}};
 const result=await discoverNotionSchema({tokenFile:'/synthetic/token',destination:undefined as never},deps);assert.equal(result.report.status,'invalid_configuration');assert.equal(reads,0);
 const cli=await runNotionSchemaDiscoveryCommand([],{},deps);assert.equal(JSON.parse(cli.output).status,'invalid_configuration');assert.equal(reads,0);
});
test('completed one-time consent keys are unchanged by portability work',()=>{
 assert.equal(CONTACT_SAVE_CONSENT,'2026-10-24-two-members-four-fields-v1');
 assert.equal(PROFILE_SAVE_CONSENT,'2026-10-24-dob-gender-v1');
});

test('pending operations require pinned destination and cannot follow a changed private configuration',()=>{
 assert.doesNotThrow(()=>assertRunDestination({destination},destination));
 assert.throws(()=>assertRunDestination({},destination));
 assert.throws(()=>assertRunDestination({destination},{...destination,dataSourceId:'77777777-7777-4777-8777-777777777777'}),/APPROVAL_DESTINATION_CHANGED/);
});
