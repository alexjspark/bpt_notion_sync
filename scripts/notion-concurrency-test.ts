import{assertRunDestination}from'../packages/engine/src/runtime-scopes.ts';
import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{chromium}from'@playwright/test';
import{connectDb,query,closeDb}from'@trainer/db';
import{OfficialNotionClient,object,resourceId,collectNotionPages}from'../packages/engine/src/live-notion-client.ts';
import type{NotionTransport}from'../packages/engine/src/live-notion-client.ts';
import{MemberInfoStore,discoverMemberInfoSchema,pageProperty,notionText,protectedProperties}from'../packages/engine/src/member-info-store.ts';
import type{MemberInfoSchema}from'../packages/engine/src/member-info-store.ts';
import{createIsolatedStorageTransport,TEST_VALUES,manualTestText}from'../packages/engine/src/isolated-storage-scope.ts';
import{parseLiveReadOnlyConfig}from'../packages/engine/src/live-runtime.ts';
import{readCompanyCurrentAccountInPage,verifyCompanyAccountResponse}from'../packages/engine/src/company-current-account.ts';

const mode=process.argv[2];
if(!['legacy-probe','protected'].includes(mode??''))throw Error('TEST_MODE_REQUIRED');
const config=parseLiveReadOnlyConfig(JSON.parse(await readFile(process.env.LIVE_READONLY_CONFIG_FILE!,'utf8')));
if(!config.isolatedTestFixture)throw Error('TEST_FIXTURE_CONFIGURATION_REQUIRED');
const fixedPage=config.isolatedTestFixture.pageId,fixedTest=config.isolatedTestFixture.testId;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const lock=await connectDb();let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
let mayPersist=false;let currentPhase='preflight',runId='',schema:MemberInfoSchema|undefined,client:OfficialNotionClient|undefined,cleanupReady=false;
const concurrency:Record<string,unknown>={mode,status:'running',realMemberWrites:0,additionalPages:0,scheduledExecution:false};
const persist=async(phase:string)=>{currentPhase=phase;concurrency.phase=phase;await query("UPDATE isolated_storage_tests SET report=jsonb_set(report,'{concurrency}', $2::jsonb),updated_at=now() WHERE id=$1",[runId,JSON.stringify(concurrency)]);};
try{
 if(!(await lock.query<{ok:boolean}>("SELECT pg_try_advisory_lock(hashtext('isolated-storage-worker')) AS ok")).rows[0]?.ok)throw Error('TEST_WORKER_BUSY');
 const r=(await query<{id:string;test_id:string;page_id:string;status:string;report:Record<string,unknown>}>("SELECT id,test_id,page_id,status,report FROM isolated_storage_tests WHERE trainer_id='trainer-live-one' AND suite_key=$1",[config.isolatedTestFixture.suiteKey])).rows[0];
 if(!r||r.page_id!==fixedPage||r.test_id!==fixedTest||r.status!=='succeeded')throw Error('TEST_JOURNAL_SCOPE_MISMATCH');
 assertRunDestination(r.report,config.notion!.members);
 runId=r.id;
 const previous=object(r.report.concurrency??{});
 if(previous.status==='running'||previous.status==='needs_review')throw Error('TEST_PREVIOUS_OUTCOME_REVIEW_REQUIRED');
 if(previous.mode===mode&&previous.status==='completed'){console.log(JSON.stringify(previous));process.exitCode=0;}
 else{
  if(mode==='protected'&&previous.mode!=='legacy-probe')throw Error('TEST_BASELINE_REQUIRED');
  if(mode==='legacy-probe'&&previous.mode)throw Error('TEST_BASELINE_ALREADY_RECORDED');
  concurrency.previous=previous;mayPersist=true;
  if(!config.notion||!config.companyPreview?.accountResponse||process.env.COMPANY_CDP_ENDPOINT!=='http://company-browser:9222')throw Error('TEST_CONNECTION_SCOPE_MISMATCH');
  browser=await chromium.connectOverCDP(process.env.COMPANY_CDP_ENDPOINT,{timeout:15000});
  const page=browser.contexts()[0]?.pages().find(p=>p.url().startsWith('https://admin.biz-pt.com/'));
  if(!page)throw Error('TEST_COMPANY_PAGE_MISSING');
  const guard=async()=>{await verifyCompanyAccountResponse(config.companyPreview!.accountResponse!,()=>readCompanyCurrentAccountInPage(page));};
  await guard();
  const token=(await readFile(process.env.NOTION_TOKEN_FILE!,'utf8')).trim();
  const transport=createIsolatedStorageTransport({destination:config.notion.members,scope:()=>({testId:fixedTest,pageId:fixedPage,createAttempted:true}),schema:()=>schema,allowTestRestore:true,
   delegate:async request=>{const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body),redirect:'error',signal:AbortSignal.timeout(15000)});return{status:response.status,body:await response.json()};},
   beforeWrite:async(request,kind,ids)=>{await guard();await query('INSERT INTO isolated_storage_operations(run_id,phase,method,target_kind,property_ids) VALUES($1,$2,$3,$4,$5::jsonb)',[runId,'concurrency_'+currentPhase,request.method,kind,JSON.stringify(ids)]);},
   created:async()=>{throw Error('TEST_CREATION_FORBIDDEN');}});
  const makeClient=(t:NotionTransport)=>new OfficialNotionClient({token,transport:t,isolatedTestScope:()=>({dataSourceId:config.notion!.members.dataSourceId,pageId:fixedPage,testId:fixedTest}),readPermit:{approved:true},writePermit:{approved:true},maxRateLimitRetries:0});
  client=makeClient(transport);schema=await discoverMemberInfoSchema(client,config.notion.members.databaseId,config.notion.members.dataSourceId);
  const s=schema,identity={pageId:fixedPage,dataSourceId:s.dataSourceId,titlePropertyId:s.name,adminPropertyId:s.admin,testId:fixedTest,title:'TEST TrainerSync | '+fixedTest};
  const setup=new MemberInfoStore(client,s);
  await setup.readPage(fixedPage,fixedTest,true);
  await persist('restore_pending');cleanupReady=true;await client.restoreIsolatedTestPage(identity);
  const body=()=>collectNotionPages(cursor=>client!.read('/blocks/'+fixedPage+'/children',{page_size:'100',...(cursor?{start_cursor:cursor}:{})}));
  const bodyHash=async()=>digest((await body()).map(b=>({id:b.id,type:b.type,content:b[String(b.type)],has_children:b.has_children})));
  const manual=async()=>{await client!.write('PATCH','/pages/'+fixedPage,{properties:{[s.email]:{email:TEST_VALUES.manualEmail}}});if(pageProperty(await setup.readPage(fixedPage,fixedTest),s.email).email!==TEST_VALUES.manualEmail)throw Error('TEST_MANUAL_EDIT_READBACK_FAILED');await client!.write('PATCH','/blocks/'+fixedPage+'/children',{children:[{object:'block',type:'paragraph',paragraph:{rich_text:notionText(manualTestText(fixedTest))}}]});};
  const input={uid:fixedTest,name:identity.title,phone:TEST_VALUES.phone,email:TEST_VALUES.filledEmail,createStatus:'\uc2e0\uaddc'};
  if(mode==='legacy-probe'){
   await persist('baseline_reset');await client.write('PATCH','/pages/'+fixedPage,{properties:{[s.email]:{email:null}}});
   const protectedBefore=digest(protectedProperties(await setup.readPage(fixedPage,fixedTest),[s.email]));
   let injected=false,expectedBody='',applicationPatchRequests=0;
   const app=makeClient(async req=>{
    if(req.method==='PATCH'&&object(object(req.body).properties)[s.email]){
     applicationPatchRequests++;await persist('baseline_inflight_barrier');await manual();injected=true;expectedBody=await bodyHash();
     await persist('baseline_dispatch_after_manual_edit');
    }
    return transport(req);
   });
   await persist('baseline_store');const result=await new MemberInfoStore(app,s).save(input,{knownPageId:fixedPage,allowCreate:false,guard});
   const after=await setup.readPage(fixedPage,fixedTest);
   concurrency.baseline={barrier:'after_last_read_and_patch_prepared_before_network_dispatch',injected,applicationPatchRequests,
    manualEmailPreserved:pageProperty(after,s.email).email===TEST_VALUES.manualEmail,
    lostUpdateReproduced:pageProperty(after,s.email).email===TEST_VALUES.filledEmail,
    bodyPreserved:await bodyHash()===expectedBody,otherPropertiesPreserved:protectedBefore===digest(protectedProperties(after,[s.email])),storeReportedVerified:result.verified};
   if(!injected||applicationPatchRequests!==1||!object(concurrency.baseline).lostUpdateReproduced)throw Error('TEST_BASELINE_NOT_REPRODUCED');
   concurrency.safetyGate='failed_no_real_member_writes';
  }else{
   const outcomes:unknown[]=[];
   for(const point of ['before_final_read','after_last_read_response']as const){
    await persist('protected_'+point+'_reset');await client.write('PATCH','/pages/'+fixedPage,{properties:{[s.email]:{email:null}}});
    const protectedBefore=digest(protectedProperties(await setup.readPage(fixedPage,fixedTest),[s.email]));
    let reads=0,injected=false,expectedBody='',applicationPatchRequests=0;
    const app=makeClient(async req=>{
     if(req.method==='PATCH')applicationPatchRequests++;
     const target=req.method==='GET'&&new URL(req.url).pathname==='/v1/pages/'+fixedPage;
     if(target)reads++;
     if(target&&reads===2&&point==='before_final_read'){await persist('protected_inject_before_read');await manual();injected=true;expectedBody=await bodyHash();}
     const response=await transport(req);
     if(target&&reads===2&&point==='after_last_read_response'){await persist('protected_inject_stale_read');await manual();injected=true;expectedBody=await bodyHash();}
     return response;
    });
    await persist('protected_store_'+point);
    const result=await new MemberInfoStore(app,s).save(input,{knownPageId:fixedPage,allowCreate:false,guard});
    const after=await setup.readPage(fixedPage,fixedTest);
    const outcome={point,injected,applicationPatchRequests,manualEmailPreserved:pageProperty(after,s.email).email===TEST_VALUES.manualEmail,
     bodyPreserved:await bodyHash()===expectedBody,otherPropertiesPreserved:protectedBefore===digest(protectedProperties(after,[s.email])),
     deferred:result.deferredFields,deferredReason:result.deferredReason,outcome:result.outcome,verified:result.verified};
    if(point==='after_last_read_response'&&(JSON.stringify(result.deferredFields)!==JSON.stringify(['email'])||result.deferredReason!=='NOTION_ATOMIC_COMPARE_AND_SET_UNAVAILABLE'||result.outcome!=='held'||result.verified!==false))throw Error('TEST_DEFERRED_POLICY_MISSING');
    if(point==='before_final_read'&&(result.deferredFields.length||result.outcome!=='unchanged'))throw Error('TEST_NONEMPTY_POLICY_MISSING');
    if(!injected||applicationPatchRequests||!outcome.manualEmailPreserved||!outcome.bodyPreserved||!outcome.otherPropertiesPreserved)throw Error('TEST_PROTECTED_PRESERVATION_FAILED');
    outcomes.push(outcome);concurrency.protectedCases=outcomes;await persist('protected_case_verified');
   }
   concurrency.safetyGate='existing_updates_deferred_no_atomic_condition';
   concurrency.inFlightExistingPatchTest='not_applicable_no_patch_sent';
  }
  await persist('cleanup_pending');await client.trashIsolatedTestPage(identity);
  const final=await setup.readPage(fixedPage,fixedTest,true);if(final.in_trash!==true)throw Error('TEST_CLEANUP_UNVERIFIED');
  concurrency.cleanup={inTrash:true,recoverable:true,pageId:fixedPage};concurrency.status='completed';await persist('complete');
  console.log(JSON.stringify(concurrency));
 }
}catch(error){
 concurrency.status='needs_review';concurrency.errorCode=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'TEST_EXECUTION_REVIEW_REQUIRED';
 if(runId&&mayPersist)await persist('stopped');
 console.log(JSON.stringify(concurrency));process.exitCode=1;
}finally{
 if(browser)await browser.close();
 try{await lock.query("SELECT pg_advisory_unlock(hashtext('isolated-storage-worker'))");}finally{lock.release();await closeDb();}
}
