import{assertRunDestination,parseNotionDestination}from'./runtime-scopes.ts';
import{auditEvent,withAuditContext,withAuditMember,auditReason}from'./audit-log.ts';
import{readFile}from'node:fs/promises';import{randomUUID,createHmac}from'node:crypto';
import{connectDb,query,transaction}from'@trainer/db';
import{OfficialNotionClient,NotionWriteUncertainError,NotionReviewRequiredError,object,collectNotionPages}from'./live-notion-client.ts';
import type{NotionTransport}from'./live-notion-client.ts';
import{MemberInfoStore,discoverMemberInfoSchema,pageProperty,textValue,protectedProperties}from'./member-info-store.ts';import type{MemberInfoSchema}from'./member-info-store.ts';
import{parseLiveReadOnlyConfig}from'./live-runtime.ts';
import{CountedCompanyPreviewAdapter}from'./live-company-counted-preview.ts';import type{CompanyBrowserPage}from'./live-company-types.ts';
import{readCompanyCurrentAccountInPage}from'./company-current-account.ts';
import{CONTACT_SAVE_CONSENT,contactMemberName,validateContactTargets,assertSourceContacts,createContactSaveTransport,contactFail}from'./oneoff-contact-scope.ts';
import type{ContactSaveTarget,ContactValues}from'./oneoff-contact-scope.ts';
type Settings={configFile:string;tokenFile:string;hmacFile:string;companyPage:CompanyBrowserPage};
type Row={id:string;status:string;targets:ContactSaveTarget[];report:Record<string,unknown>;expires_at:string;consumed_at:string|null;updated_at:string};
const cols='id,status,targets,report,expires_at,consumed_at,updated_at';
export async function getContactSaveOnce(){return(await query<Row>('SELECT '+cols+' FROM oneoff_contact_saves WHERE consent_key=$1',[CONTACT_SAVE_CONSENT])).rows[0]??null;}
export async function queueContactSaveOnce(){return transaction(async c=>{
 const r=(await c.query<Row>('SELECT '+cols+' FROM oneoff_contact_saves WHERE consent_key=$1 FOR UPDATE',[CONTACT_SAVE_CONSENT])).rows[0];if(!r)contactFail('CONTACT_SAVE_NOT_PREPARED');
 if(r!.status!=='prepared')return r!;
 if(new Date(r!.expires_at).getTime()<=Date.now())contactFail('CONTACT_SAVE_APPROVAL_EXPIRED');
 return(await c.query<Row>("UPDATE oneoff_contact_saves SET status='queued',updated_at=now() WHERE id=$1 AND status='prepared' RETURNING "+cols,[r!.id])).rows[0]!;
});}
const fetchTransport:NotionTransport=async request=>{const r=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body),redirect:'error',signal:AbortSignal.timeout(15000)});return{status:r.status,body:await r.json()};};
async function connection(settings:Settings){
 const config=parseLiveReadOnlyConfig(JSON.parse(await readFile(settings.configFile,'utf8')));if(!config.companyPreview||!config.notion||config.contactSaveApproval?.consentKey!==CONTACT_SAVE_CONSENT)contactFail('CONTACT_SAVE_CONNECTION_SCOPE_INVALID');
 const company=new CountedCompanyPreviewAdapter(settings.companyPage,config.companyPreview!,config.trainerId,()=>readCompanyCurrentAccountInPage(settings.companyPage));
 const contacts=await company.listAssignedContactSnapshot();const token=(await readFile(settings.tokenFile,'utf8')).trim();
 return{config,company,contacts,token};
}
export async function prepareContactSaveOnce(settings:Settings){
 const prior=await getContactSaveOnce();if(prior)return prior;
 const {config,company,contacts,token}=await connection(settings);
 const client=new OfficialNotionClient({token,readPermit:{approved:true},transport:async r=>{if(r.method!=='GET'&&!(r.method==='POST'&&new URL(r.url).pathname.endsWith('/query')))contactFail('CONTACT_SAVE_READONLY_BOUNDARY');return fetchTransport(r);}});
 const s=await discoverMemberInfoSchema(client,config.notion!.members.databaseId,config.notion!.members.dataSourceId);
 const rows=await collectNotionPages(cursor=>client.read('/data_sources/'+s.dataSourceId+'/query',undefined,{page_size:100,...(cursor?{start_cursor:cursor}:{})}));
 const store=new MemberInfoStore(client,s),targets:ContactSaveTarget[]=[];
 for(const approved of config.contactSaveApproval!.targets){const sources=contacts.filter(c=>c.uid===approved.uid&&contactMemberName(c.name)===approved.name);if(sources.length!==1)contactFail('CONTACT_SAVE_SOURCE_IDENTITY_CHANGED');const source=sources[0]!;assertSourceContacts(source);const matches=rows.filter(p=>pageProperty(p,s.admin).url===store.admin(approved.uid));if(matches.length!==1||matches[0]!.id!==approved.pageId)contactFail('CONTACT_SAVE_IDENTITY_CONFLICT');const p=matches[0]!;store.assertPage(p,approved.uid);if(contactMemberName(textValue(pageProperty(p,s.name).title))!==approved.name)contactFail('CONTACT_SAVE_NAME_CONFLICT');targets.push({...approved,fields:['phone','email']});}
 validateContactTargets(targets,config.contactSaveApproval!.targets);await company.verifyAccount();
 const report={destination:parseNotionDestination(config.notion!.members),mode:'one_time_editing_paused',scheduledExecution:false,atomicConcurrencyGuarantee:false,targets:targets.map(t=>({...t,status:'pending',savedFields:[],heldFields:[]}))};
 await query("INSERT INTO oneoff_contact_saves(id,trainer_id,consent_key,status,targets,report,expires_at) VALUES($1,'trainer-live-one',$2,'prepared',$3::jsonb,$4::jsonb,now()+interval '30 minutes') ON CONFLICT(consent_key) DO NOTHING",[randomUUID(),CONTACT_SAVE_CONSENT,JSON.stringify(targets),JSON.stringify(report)]);
 return(await getContactSaveOnce())!;
}
async function executeContactSaveOnce(settings:Settings){
 const lock=await connectDb();let locked=false,run:Row|undefined;
 try{
  locked=(await lock.query<{ok:boolean}>("SELECT pg_try_advisory_lock(hashtext('oneoff-contact-save')) AS ok")).rows[0]?.ok===true;if(!locked)return false;
  run=await transaction(async c=>{const r=(await c.query<Row>('SELECT '+cols+" FROM oneoff_contact_saves WHERE consent_key=$1 AND status='queued' FOR UPDATE SKIP LOCKED",[CONTACT_SAVE_CONSENT])).rows[0];if(!r)return undefined;
   return(await c.query<Row>("UPDATE oneoff_contact_saves SET status='running',consumed_at=now(),updated_at=now() WHERE id=$1 RETURNING "+cols,[r.id])).rows[0];});if(!run)return false;await auditEvent({stage:'claim',outcome:'succeeded',provider:'local',operation:'execute'});
  const approvalConfig=parseLiveReadOnlyConfig(JSON.parse(await readFile(settings.configFile,'utf8')));
  if(approvalConfig.contactSaveApproval?.consentKey!==CONTACT_SAVE_CONSENT)contactFail('CONTACT_SAVE_CONNECTION_SCOPE_INVALID');
  assertRunDestination(run.report,approvalConfig.notion!.members);
  const targets=validateContactTargets(run.targets,approvalConfig.contactSaveApproval!.targets),report={...run.report} as Record<string,unknown>;
  const outcomes=targets.map(t=>({...t,status:'pending',savedFields:[] as string[],heldFields:[] as string[],uncertainResponse:false,protectedPropertiesUnchanged:true}));report.targets=outcomes;
  const persist=async()=>{await query('UPDATE oneoff_contact_saves SET report=$2::jsonb,updated_at=now() WHERE id=$1',[run!.id,JSON.stringify(report)]);};
  if(new Date(run.expires_at).getTime()<=Date.now())contactFail('CONTACT_SAVE_APPROVAL_EXPIRED');
  const{config,company,contacts,token}=await connection(settings),intended=new Map<string,ContactValues>();
  for(const t of targets){const matches=contacts.filter(c=>c.uid===t.uid);if(matches.length!==1||contactMemberName(matches[0]!.name)!==contactMemberName(t.name))contactFail('CONTACT_SAVE_SOURCE_IDENTITY_CHANGED');assertSourceContacts(matches[0]!);intended.set(t.uid,matches[0]!);}
  const key=(await readFile(settings.hmacFile,'utf8')).trim(),hash=(value:string)=>createHmac('sha256',key).update(value).digest('hex');let schema:MemberInfoSchema|undefined;
  const transport=createContactSaveTransport({destination:config.notion!.members,approvedTargets:config.contactSaveApproval!.targets,targets,intended,schema:()=>schema,delegate:fetchTransport,consumeWrite:async(pageId,fields)=>{
   const count=await query("UPDATE oneoff_contact_targets AS t SET dispatched=true,dispatched_at=now(),sent_fields=$3::jsonb FROM oneoff_contact_saves AS r WHERE t.run_id=$1 AND t.page_id=$2 AND t.dispatched=false AND r.id=t.run_id AND r.status='running' AND r.consumed_at IS NOT NULL AND r.expires_at>now()",[run!.id,pageId,JSON.stringify(fields)]);if(count.rowCount!==1)contactFail('CONTACT_SAVE_ATTEMPT_ALREADY_CONSUMED');
  }});
  const client=new OfficialNotionClient({token,readPermit:{approved:true},writePermit:{approved:true},transport,maxRateLimitRetries:0});
  schema=await discoverMemberInfoSchema(client,config.notion!.members.databaseId,config.notion!.members.dataSourceId);const s=schema,store=new MemberInfoStore(client,s);
  for(let i=0;i<targets.length;i++){
   const t=targets[i]!,out=outcomes[i]!,source=intended.get(t.uid)!;
   try{
    await company.verifyAccount();const match=await store.find(t.uid);if(!match||match.id!==t.pageId)contactFail('CONTACT_SAVE_IDENTITY_CONFLICT');
    const expected={phone:hash(source.phone!),email:hash(source.email!)};
    await query("INSERT INTO oneoff_contact_targets(run_id,page_id,uid,expected_hashes,dispatched) VALUES($1,$2,$3,$4::jsonb,false) ON CONFLICT(run_id,page_id) DO NOTHING",[run.id,t.pageId,t.uid,JSON.stringify(expected)]);
    await company.verifyAccount();
    // This final read narrows the gap; the explicit editing pause is still required.
    const before=await store.readPage(t.pageId,t.uid),props:Record<string,unknown>={},fields:string[]=[];
    for(const [field,id,type]of [['phone',s.phone,'phone_number'],['email',s.email,'email']]as const){const p=pageProperty(before,id);if(p.type!==type)contactFail('CONTACT_SAVE_SCHEMA_CHANGED');if(p[type]===null||p[type]===''){props[id]={[type]:source[field]};fields.push(field);}else out.heldFields.push(field);}
    for(const f of out.heldFields)await auditEvent({stage:'map',outcome:'held',memberId:t.uid,fields:[f],reasonCode:'EXISTING_VALUE_PRESERVED',beforeState:'present',afterState:'not_written'});
    if(!fields.length){out.status='held';await persist();continue;}
    let uncertain=false;
    try{await withAuditMember(t.uid,fields,()=>client.write('PATCH','/pages/'+t.pageId,{properties:props}));}
    catch(error){if(error instanceof NotionWriteUncertainError)uncertain=true;else throw error;}
    // A failed or uncertain request is never re-PATCHed.
    const after=await store.readPage(t.pageId,t.uid);out.uncertainResponse=uncertain;
    for(const field of fields){const id=field==='phone'?s.phone:s.email,type=field==='phone'?'phone_number':'email',value=pageProperty(after,id)[type];if(typeof value==='string'&&hash(value)===expected[field as 'phone'|'email'])out.savedFields.push(field);}
    out.protectedPropertiesUnchanged=JSON.stringify(protectedProperties(before,fields.map(f=>f==='phone'?s.phone:s.email)))===JSON.stringify(protectedProperties(after,fields.map(f=>f==='phone'?s.phone:s.email)));
    out.status=out.savedFields.length===fields.length&&out.protectedPropertiesUnchanged?(uncertain?'observed_match_after_uncertain':'verified'):'needs_review';
    await auditEvent({stage:'readback',outcome:out.status==='verified'?'succeeded':out.uncertainResponse?'uncertain':'failed',memberId:t.uid,fields,provider:'notion',operation:'reconcile',readbackMatch:out.savedFields.length===fields.length,protectedUnchanged:out.protectedPropertiesUnchanged,afterState:out.savedFields.length===fields.length?'matched':'mismatched'});
    await query('UPDATE oneoff_contact_targets SET outcome=$3::jsonb WHERE run_id=$1 AND page_id=$2',[run.id,t.pageId,JSON.stringify(out)]);await persist();
   }catch(error){await auditEvent({stage:'error',outcome:'failed',memberId:t.uid,fields:t.fields,error});out.status=(await query<{dispatched:boolean}>('SELECT dispatched FROM oneoff_contact_targets WHERE run_id=$1 AND page_id=$2',[run.id,t.pageId])).rows[0]?.dispatched?'needs_review':'held';Object.assign(out,{errorCode:error instanceof NotionReviewRequiredError?error.code:'CONTACT_SAVE_TARGET_REVIEW_REQUIRED'});await persist();}
  }
  await company.verifyAccount();report.completed=true;report.savedFieldCount=outcomes.reduce((n,o)=>n+o.savedFields.length,0);report.heldFieldCount=outcomes.reduce((n,o)=>n+o.heldFields.length,0);report.authorizationConsumed=true;report.reusable=false;await persist();
  const status=outcomes.every(o=>o.status==='verified'&&o.heldFields.length===0&&o.savedFields.length===2)?'succeeded':outcomes.some(o=>o.status==='needs_review'||o.uncertainResponse)?'needs_review':'partial';
  await query('UPDATE oneoff_contact_saves SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1',[run.id,status]);return true;
 }catch(error){
  if(run)await auditEvent({stage:'error',outcome:'failed',error});if(run)await query("UPDATE oneoff_contact_saves SET status='needs_review',error_code=$2,finished_at=now(),updated_at=now() WHERE id=$1",[run.id,error instanceof NotionReviewRequiredError?error.code:'CONTACT_SAVE_REVIEW_REQUIRED']);return !!run;
 }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('oneoff-contact-save'))");}finally{lock.release();}}
}
export function publicContactSaveOnce(row:Row|null){return row?{id:row.id,status:row.status,delayed:row.status==='running'&&Date.now()-new Date(row.updated_at).getTime()>120000,targets:row.targets.map(t=>({...t,pageUrl:'https://app.notion.com/p/'+t.pageId.replaceAll('-','')})),report:row.report,expiresAt:row.expires_at,authorizationConsumed:row.consumed_at!==null,reusable:row.status==='prepared'}:null;}

export async function runContactSaveOnce(settings:Settings){const row=await getContactSaveOnce();if(row?.status!=='queued')return false;return withAuditContext({runId:row.id,runKind:'contact_once',accountId:'trainer-live-one',attempt:1},async()=>{const start=Date.now();const worked=await executeContactSaveOnce(settings);if(worked){const after=await getContactSaveOnce();await auditEvent({stage:'complete',outcome:after?.status==='succeeded'?'succeeded':after?.status==='needs_review'?'uncertain':'held',durationMs:Date.now()-start,counts:{saved:Number(after?.report.savedFieldCount??0),held:Number(after?.report.heldFieldCount??0)}});}return worked;});}
