import{assertRunDestination}from'./runtime-scopes.ts';
import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{connectDb,query}from'@trainer/db';
import{OfficialNotionClient,NotionReviewRequiredError,NotionWriteUncertainError,NotionHttpError,collectNotionPages,object,string,resourceId}from'./live-notion-client.ts';
import{MemberInfoStore,discoverMemberInfoSchema,pageProperty,notionText,protectedProperties,textValue}from'./member-info-store.ts';import type{MemberInfoSchema,MemberInfoInput}from'./member-info-store.ts';
import{createIsolatedStorageTransport,TEST_VALUES,initialTestText,manualTestText}from'./isolated-storage-scope.ts';
import{claimIsolatedStorageRun}from'./isolated-storage-queue.ts';import{parseLiveReadOnlyConfig}from'./live-runtime.ts';
import{verifyCompanyAccountResponse}from'./company-current-account.ts';import type{CompanyCurrentAccount}from'./company-current-account.ts';
const fail=(code:string):never=>{throw new NotionReviewRequiredError(code);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const para=(text:string)=>({object:'block',type:'paragraph',paragraph:{rich_text:notionText(text)}});
export async function runIsolatedStorageTestOnce(options:{configFile:string;tokenFile:string;readCurrentAccount:()=>Promise<CompanyCurrentAccount>}):Promise<boolean>{
 const lock=await connectDb();let locked=false;let run:Awaited<ReturnType<typeof claimIsolatedStorageRun>>=null;
 try{locked=(await lock.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext('isolated-storage-worker')) AS locked")).rows[0]?.locked===true;if(!locked)return false;
 run=await claimIsolatedStorageRun();if(!run)return false;
 const current=run,report:Record<string,unknown>={...run.report,mode:'isolated_storage_test',realMemberWrites:0,templateWrites:0,calendarWrites:0,scheduledExecution:false};
 const steps=object(report.steps??{});report.steps=steps;
 const persist=async(phase:string)=>{current.phase=phase;await query('UPDATE isolated_storage_tests SET phase=$2,report=$3::jsonb,updated_at=now() WHERE id=$1',[current.id,phase,JSON.stringify(report)]);};
 const config=parseLiveReadOnlyConfig(JSON.parse(await readFile(options.configFile,'utf8')));
 if(!config.companyPreview?.accountResponse||!config.notion)fail('ISOLATED_CONNECTION_UNVERIFIED');
 assertRunDestination(current.report,config.notion!.members);
 const guard=async()=>{await verifyCompanyAccountResponse(config.companyPreview!.accountResponse!,options.readCurrentAccount);};
 await guard();
 const token=(await readFile(options.tokenFile,'utf8')).trim();let schema:MemberInfoSchema|undefined;
 const created=async(id:string)=>{if(current.pageId&&current.pageId!==id)fail('ISOLATED_PAGE_ID_CHANGED');current.pageId=id;await query('UPDATE isolated_storage_tests SET page_id=$2,updated_at=now() WHERE id=$1 AND(page_id IS NULL OR page_id=$2)',[current.id,id]);};
 const transport=createIsolatedStorageTransport({destination:config.notion!.members,scope:()=>({testId:current.testId,pageId:current.pageId,createAttempted:current.createAttempted}),schema:()=>schema,
  delegate:async request=>{const r=await fetch(request.url,{method:request.method,headers:request.headers,redirect:'error',signal:AbortSignal.timeout(15000),...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});return{status:r.status,body:await r.json()};},
  beforeWrite:async(req,kind,ids)=>{await guard();await query('INSERT INTO isolated_storage_operations(run_id,phase,method,target_kind,property_ids) VALUES($1,$2,$3,$4,$5::jsonb)',[current.id,current.phase,req.method,kind,JSON.stringify(ids)]);},created});
 const client=new OfficialNotionClient({token,transport,isolatedTestScope:()=>({dataSourceId:config.notion!.members.dataSourceId,pageId:current.pageId,testId:current.testId}),readPermit:{approved:true},writePermit:{approved:true},maxRateLimitRetries:0});
 schema=await discoverMemberInfoSchema(client,config.notion!.members.databaseId,config.notion!.members.dataSourceId);const s=schema,store=new MemberInfoStore(client,s);
 const statusSchema=await client.read('/data_sources/'+resourceId(s.dataSourceId));const status=Object.values(object(statusSchema.properties)).map(object).find(p=>p.id===s.status);
 if(!status||!Array.isArray(object(status.select).options)||!['\uc2e0\uaddc','\uc720\uc608'].every(n=>(object(status.select).options as unknown[]).some(o=>object(o).name===n)))fail('ISOLATED_STATUS_UNVERIFIED');
 const title='TEST TrainerSync | '+current.testId;
 const input:MemberInfoInput={uid:current.testId,name:title,phone:TEST_VALUES.phone,email:TEST_VALUES.email,createStatus:'\uc2e0\uaddc',bodyOnCreate:[para(initialTestText(current.testId))]};
 const body=async()=>collectNotionPages(cursor=>client.read('/blocks/'+resourceId(current.pageId!)+'/children',{page_size:'100',...(cursor?{start_cursor:cursor}:{})}));
 const bodyFingerprint=async()=>hash((await body()).map(b=>({id:b.id,type:b.type,content:b[b.type as string],has_children:b.has_children})));
 const save=async(value:MemberInfoInput=input)=>store.save(value,{knownPageId:current.pageId??undefined,allowCreate:!current.createAttempted,
  beforeCreate:async()=>{if(current.createAttempted||current.pageId)fail('ISOLATED_CREATE_RECONCILIATION_REQUIRED');current.createAttempted=true;await query("UPDATE isolated_storage_tests SET create_attempted=true,phase='create_pending',updated_at=now() WHERE id=$1",[current.id]);},created,guard});
 if(!steps.create){
  await persist('create');
  if(current.createAttempted&&!current.pageId){const match=await store.find(current.testId);if(!match)fail('ISOLATED_CREATE_RECONCILIATION_REQUIRED');await created(string(match.id));}
  const result=await save();if(!current.pageId)await created(result.pageId);
  const page=await store.readPage(current.pageId!,current.testId);
  if(pageProperty(page,s.phone).phone_number!==TEST_VALUES.phone||pageProperty(page,s.email).email!==TEST_VALUES.email||textValue(pageProperty(page,s.name).title)!==title)fail('ISOLATED_CREATE_READBACK_FAILED');
  if(!(await body()).some(b=>b.type==='paragraph'&&textValue(object(b.paragraph).rich_text)===initialTestText(current.testId)))fail('ISOLATED_INITIAL_BODY_MISSING');
  steps.create={passed:true,pageId:current.pageId,fieldReadback:true,syntheticDataOnly:true};await persist('created_verified');
 }
 if(!steps.replay){
  const before=await bodyFingerprint(),id=current.pageId;await persist('replay');const result=await save();
  if(result.pageId!==id||result.created||result.updatedFields.length||before!==await bodyFingerprint()||string((await store.find(current.testId))!.id)!==id)fail('ISOLATED_REPLAY_FAILED');
  steps.replay={passed:true,samePageId:true,additionalPages:0,additionalFieldWrites:0};await persist('replay_verified');
 }
 if(!steps.manualPreservation){
  await persist('manual_edit_fixture');
  const page=await store.readPage(current.pageId!,current.testId),phone=pageProperty(page,s.phone).phone_number,email=pageProperty(page,s.email).email;
  if(![TEST_VALUES.phone,TEST_VALUES.manualPhone].includes(phone as never)||![TEST_VALUES.email,TEST_VALUES.manualEmail].includes(email as never))fail('ISOLATED_UNEXPECTED_MANUAL_EDIT');
  if(phone!==TEST_VALUES.manualPhone||email!==TEST_VALUES.manualEmail)await client.write('PATCH','/pages/'+resourceId(current.pageId!),{properties:{[s.phone]:{phone_number:TEST_VALUES.manualPhone},[s.email]:{email:TEST_VALUES.manualEmail},[s.status]:{select:{name:'\uc720\uc608'}},[s.firstTraining]:{date:{start:'2099-01-01'}}}});
  const marker=manualTestText(current.testId),existing=(await body()).filter(b=>b.type==='paragraph'&&textValue(object(b.paragraph).rich_text)===marker);
  if(existing.length>1)fail('ISOLATED_MANUAL_BODY_DUPLICATE');
  if(!existing.length){if(report.manualBodyPending===true)fail('ISOLATED_BODY_RECONCILIATION_REQUIRED');report.manualBodyPending=true;await persist('manual_body_pending');await client.write('PATCH','/blocks/'+resourceId(current.pageId!)+'/children',{children:[para(marker)]});report.manualBodyPending=false;}
  const beforePage=await store.readPage(current.pageId!,current.testId),beforeBody=await bodyFingerprint();await persist('manual_preservation');const result=await save();
  const after=await store.readPage(current.pageId!,current.testId);
  if(result.updatedFields.length||hash(protectedProperties(beforePage,[]))!==hash(protectedProperties(after,[]))||beforeBody!==await bodyFingerprint())fail('ISOLATED_MANUAL_PRESERVATION_FAILED');
  steps.manualPreservation={passed:true,preserved:['phone','email','title','status','firstTraining','body']};await persist('manual_preservation_verified');
 }
 if(!steps.fillEmpty){
  await persist('fill_empty_fixture');const page=await store.readPage(current.pageId!,current.testId),email=pageProperty(page,s.email).email;
  if(email!==TEST_VALUES.manualEmail&&email!==null&&email!==TEST_VALUES.filledEmail)fail('ISOLATED_UNEXPECTED_MANUAL_EDIT');
  if(email===TEST_VALUES.manualEmail)await client.write('PATCH','/pages/'+resourceId(current.pageId!),{properties:{[s.email]:{email:null}}});
  const before=await store.readPage(current.pageId!,current.testId),beforeBody=await bodyFingerprint();await persist('fill_empty');
  const result=await save({...input,name:title+' SOURCE NAME CHANGE MUST NOT OVERWRITE',email:TEST_VALUES.filledEmail});
  const after=await store.readPage(current.pageId!,current.testId);
  if(result.created||result.updatedFields.length||JSON.stringify(result.deferredFields)!==JSON.stringify(['email'])||result.outcome!=='held'||result.verified!==false||pageProperty(after,s.email).email!==null||pageProperty(after,s.phone).phone_number!==TEST_VALUES.manualPhone
    ||hash(protectedProperties(before,[s.email]))!==hash(protectedProperties(after,[s.email]))||beforeBody!==await bodyFingerprint())fail('ISOLATED_FILL_EMPTY_FAILED');
  steps.fillEmpty={passed:true,held:true,changedFields:[],deferredFields:['email'],reason:'NOTION_ATOMIC_COMPARE_AND_SET_UNAVAILABLE',otherFieldsAndBodyPreserved:true};await persist('fill_empty_verified');
 }
 if(!steps.cleanup){
  await persist('trash_pending');await guard();await client.trashIsolatedTestPage({pageId:current.pageId!,dataSourceId:s.dataSourceId,titlePropertyId:s.name,adminPropertyId:s.admin,testId:current.testId,title});
  const page=await store.readPage(current.pageId!,current.testId,true);if(page.in_trash!==true)fail('ISOLATED_TRASH_READBACK_FAILED');
  steps.cleanup={passed:true,inTrash:true,recoverable:true,permanentDeletion:false};await persist('trash_verified');
 }
 const operations=await query<{count:string}>('SELECT count(*)::text AS count FROM isolated_storage_operations WHERE run_id=$1',[current.id]);report.testWriteRequests=Number(operations.rows[0]!.count);
 report.pageId=current.pageId;report.completed=true;await persist('complete');
 await query("UPDATE isolated_storage_tests SET status='succeeded',finished_at=now(),error_code=NULL WHERE id=$1",[current.id]);return true;
 }catch(error){
  if(run){const code=error instanceof NotionReviewRequiredError&&/^ISOLATED_[A-Z_]+$|^MEMBER_INFO_[A-Z_]+$/.test(error.code)?error.code:error instanceof NotionWriteUncertainError?'ISOLATED_WRITE_OUTCOME_UNCERTAIN':error instanceof NotionHttpError?'ISOLATED_NOTION_HTTP_'+error.status:'ISOLATED_STORAGE_FAILED';
   await query("UPDATE isolated_storage_tests SET status=$2,error_code=$3,updated_at=now() WHERE id=$1",[run.id,error instanceof NotionWriteUncertainError||code.includes('RECONCILIATION')?'needs_review':'failed',code]);}
  return !!run;
 }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('isolated-storage-worker'))");}finally{lock.release();}}
}
