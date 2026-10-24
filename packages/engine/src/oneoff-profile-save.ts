import{assertRunDestination,parseNotionDestination}from'./runtime-scopes.ts';
import{auditEvent,withAuditContext,withAuditMember,auditReason}from'./audit-log.ts';
import{readFile}from'node:fs/promises';import{randomUUID,createHmac}from'node:crypto';
import{connectDb,query,transaction}from'@trainer/db';
import{OfficialNotionClient,NotionWriteUncertainError,NotionReviewRequiredError,collectNotionPages}from'./live-notion-client.ts';import type{NotionTransport}from'./live-notion-client.ts';
import{MemberInfoStore,pageProperty,protectedProperties}from'./member-info-store.ts';
import{parseLiveReadOnlyConfig}from'./live-runtime.ts';import{CountedCompanyPreviewAdapter}from'./live-company-counted-preview.ts';
import type{CompanyBrowserPage}from'./live-company-types.ts';import{readCompanyCurrentAccountInPage}from'./company-current-account.ts';
import{readCompanyDemographics}from'./company-demographics.ts';import type{CompanyDemographics,DemographicField}from'./company-demographics.ts';
import{PROFILE_SAVE_CONSENT,discoverProfileSchema,validateProfileTargets,profileFieldEmpty,profileValue,createProfileSaveTransport,profileFail}from'./oneoff-profile-scope.ts';import type{ProfileSchema,ProfileTarget}from'./oneoff-profile-scope.ts';
type Settings={configFile:string;tokenFile:string;hmacFile:string;companyPage:CompanyBrowserPage};
type Outcome=ProfileTarget&{status:string;savedFields:DemographicField[];heldFields:DemographicField[];reasons:Partial<Record<DemographicField,string>>;uncertainResponse:boolean;protectedPropertiesUnchanged:boolean;errorCode?:string};
type PlanMember={uid:string;name:string;pageId:string|null;fields:Partial<Record<DemographicField,string>>};
type Row={id:string;status:string;targets:ProfileTarget[];schema_binding:Record<string,string>;report:Record<string,unknown>;expires_at:string;consumed_at:string|null;updated_at:string};
const cols='id,status,targets,schema_binding,report,expires_at,consumed_at,updated_at',fields:DemographicField[]=['birthDate','gender'];
const schemaBinding=(s:ProfileSchema)=>({dataSourceId:s.dataSourceId,birthDate:s.birthDate,gender:s.gender,maleOption:s.maleOption,femaleOption:s.femaleOption});
const publicCode=(e:unknown)=>{const code=e&&typeof e==='object'&&'code'in e?String(e.code):'';return/^[A-Z][A-Z0-9_]{0,80}$/.test(code)?code:'PROFILE_REVIEW_REQUIRED';};
const transport:NotionTransport=async r=>{const response=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body===undefined?undefined:JSON.stringify(r.body),redirect:'error',signal:AbortSignal.timeout(15000)});return{status:response.status,body:await response.json()};};
async function connection(settings:Settings){const config=parseLiveReadOnlyConfig(JSON.parse(await readFile(settings.configFile,'utf8')));if(!config.companyPreview||!config.notion)profileFail('PROFILE_CONNECTION_SCOPE_INVALID');
 const company=new CountedCompanyPreviewAdapter(settings.companyPage,config.companyPreview!,config.trainerId,()=>readCompanyCurrentAccountInPage(settings.companyPage));const inventory=await company.listMembers({trainerId:config.trainerId,cursor:null,scope:'all_assigned'});
 const token=(await readFile(settings.tokenFile,'utf8')).trim();return{config,company,members:inventory.members,token};}
export async function getProfileSaveOnce(){return(await query<Row>('SELECT '+cols+' FROM oneoff_profile_saves WHERE consent_key=$1',[PROFILE_SAVE_CONSENT])).rows[0]??null;}
export async function queueProfileSaveOnce(){return transaction(async c=>{const row=(await c.query<Row>('SELECT '+cols+' FROM oneoff_profile_saves WHERE consent_key=$1 FOR UPDATE',[PROFILE_SAVE_CONSENT])).rows[0];if(!row)profileFail('PROFILE_NOT_PREPARED');if(row!.status!=='prepared')return row!;if(new Date(row!.expires_at).getTime()<=Date.now())profileFail('PROFILE_APPROVAL_EXPIRED');
 return(await c.query<Row>("UPDATE oneoff_profile_saves SET status='queued',updated_at=now() WHERE id=$1 AND status='prepared' RETURNING "+cols,[row!.id])).rows[0]!;});}
export async function prepareProfileSaveOnce(settings:Settings){
 const prior=await getProfileSaveOnce();if(prior)return prior;const{config,company,members,token}=await connection(settings);
 const client=new OfficialNotionClient({token,readPermit:{approved:true},transport:async r=>{if(r.method!=='GET'&&!(r.method==='POST'&&new URL(r.url).pathname.endsWith('/query')))profileFail('PROFILE_READONLY_BOUNDARY');return transport(r);}});
 const s=await discoverProfileSchema(client,config.notion!.members.databaseId,config.notion!.members.dataSourceId),store=new MemberInfoStore(client,s);
 const rows=await collectNotionPages(cursor=>client.read('/data_sources/'+s.dataSourceId+'/query',undefined,{page_size:100,...(cursor?{start_cursor:cursor}:{})}));
 const targets:ProfileTarget[]=[],plan:PlanMember[]=[];let unmatched=0,matched=0,preservedExisting=0,sourceHeldFields=0;
 for(const member of members){
  const uid=member.companyMemberId,name=member.name,matches=rows.filter(p=>pageProperty(p,s.admin).url===store.admin(uid));
  const entry:PlanMember={uid,name,pageId:null,fields:{}};plan.push(entry);
  if(matches.length!==1){unmatched++;entry.fields={birthDate:'uid_unverified',gender:'uid_unverified'};continue;}
  const page=matches[0]!;store.assertPage(page,uid);entry.pageId=String(page.id);matched++;
  const needed=fields.filter(f=>{if(profileFieldEmpty(page,f,s))return true;entry.fields[f]='preserved_existing';preservedExisting++;return false;});if(!needed.length)continue;
  try{const source=await readCompanyDemographics(settings.companyPage,uid,name,()=>company.verifyAccount()),valid:DemographicField[]=[];
   for(const f of needed){if(source[f]!==null){valid.push(f);entry.fields[f]='planned';}else{entry.fields[f]=source.reasons[f]??'source_missing';sourceHeldFields++;}}
   if(valid.length)targets.push({uid,pageId:String(page.id),name,fields:valid});
  }catch(e){for(const f of needed){entry.fields[f]=publicCode(e);sourceHeldFields++;}}
 }
 await company.verifyAccount();validateProfileTargets(targets);
 const unresolvedRows=rows.filter(p=>{const u=pageProperty(p,s.admin).url;return typeof u!=='string'||!/^https:\/\/admin\.biz-pt\.com\/manage\/members\/\d+$/.test(u);}).length;
 const report={destination:parseNotionDestination(config.notion!.members),mode:'profile_one_time_editing_paused',sourceMemberCount:members.length,matchedMemberCount:matched,uidUnverifiedMemberCount:unmatched,unresolvedNotionRows:unresolvedRows,preservedExistingFieldCount:preservedExisting,sourceHeldFieldCount:sourceHeldFields,plan,targets:targets.map(t=>({...t,status:'pending',savedFields:[],heldFields:[],reasons:{}})),scheduledExecution:false,atomicConcurrencyGuarantee:false};
 await query("INSERT INTO oneoff_profile_saves(id,trainer_id,consent_key,status,targets,schema_binding,report,expires_at) VALUES($1,'trainer-live-one',$2,'prepared',$3::jsonb,$4::jsonb,$5::jsonb,now()+interval '30 minutes') ON CONFLICT(consent_key) DO NOTHING",[randomUUID(),PROFILE_SAVE_CONSENT,JSON.stringify(targets),JSON.stringify(schemaBinding(s)),JSON.stringify(report)]);
 return(await getProfileSaveOnce())!;
}
function currentScalar(page:Record<string,unknown>,field:DemographicField,s:ProfileSchema):unknown{const p=pageProperty(page,s[field]);if(field==='birthDate'){const d=p.date as {start?:unknown;end?:unknown;time_zone?:unknown}|null;return d&&d.end==null&&d.time_zone==null?d.start:null;}return(p.select as {id?:unknown}|null)?.id??null;}
async function executeProfileSaveOnce(settings:Settings){
 const lock=await connectDb();let locked=false,run:Row|undefined;
 try{
  locked=(await lock.query<{ok:boolean}>("SELECT pg_try_advisory_lock(hashtext('oneoff-profile-save')) AS ok")).rows[0]?.ok===true;if(!locked)return false;
  run=await transaction(async c=>{const r=(await c.query<Row>('SELECT '+cols+" FROM oneoff_profile_saves WHERE consent_key=$1 AND status='queued' FOR UPDATE SKIP LOCKED",[PROFILE_SAVE_CONSENT])).rows[0];if(!r)return undefined;return(await c.query<Row>("UPDATE oneoff_profile_saves SET status='running',consumed_at=now(),updated_at=now() WHERE id=$1 RETURNING "+cols,[r.id])).rows[0];});if(!run)return false;await auditEvent({stage:'claim',outcome:'succeeded',provider:'local',operation:'execute'});
  const targets=validateProfileTargets(run.targets),report={...run.report},outcomes:Outcome[]=targets.map(t=>({...t,status:'pending',savedFields:[],heldFields:[],reasons:{},uncertainResponse:false,protectedPropertiesUnchanged:true}));report.targets=outcomes;
  const persist=async()=>{await query('UPDATE oneoff_profile_saves SET report=$2::jsonb,updated_at=now() WHERE id=$1',[run!.id,JSON.stringify(report)]);};
  if(new Date(run.expires_at).getTime()<=Date.now())profileFail('PROFILE_APPROVAL_EXPIRED');
  const approvalConfig=parseLiveReadOnlyConfig(JSON.parse(await readFile(settings.configFile,'utf8')));if(!approvalConfig.notion)profileFail('PROFILE_CONNECTION_SCOPE_INVALID');assertRunDestination(run.report,approvalConfig.notion!.members);
  const{config,company,members,token}=await connection(settings),intended=new Map<string,CompanyDemographics>();
  const key=(await readFile(settings.hmacFile,'utf8')).trim(),hash=(v:unknown)=>createHmac('sha256',key).update(JSON.stringify(v)).digest('hex');let schema:ProfileSchema|undefined;
  const scoped=createProfileSaveTransport({destination:config.notion!.members,targets,schema:()=>schema,intended,delegate:transport,consumeWrite:async(pageId,sent)=>{
   const result=await query("UPDATE oneoff_profile_targets AS t SET dispatched=true,dispatched_at=now(),sent_fields=$3::jsonb FROM oneoff_profile_saves AS r WHERE t.run_id=$1 AND t.page_id=$2 AND t.dispatched=false AND r.id=t.run_id AND r.status='running' AND r.consumed_at IS NOT NULL AND r.expires_at>now()",[run!.id,pageId,JSON.stringify(sent)]);if(result.rowCount!==1)profileFail('PROFILE_ATTEMPT_ALREADY_CONSUMED');
  }});
  const client=new OfficialNotionClient({token,transport:scoped,readPermit:{approved:true},writePermit:{approved:true},maxRateLimitRetries:0});schema=await discoverProfileSchema(client,config.notion!.members.databaseId,config.notion!.members.dataSourceId);
  const s=schema;if(Object.keys(run.schema_binding).length!==5||Object.entries(schemaBinding(s)).some(([k,v])=>run!.schema_binding[k]!==v))profileFail('PROFILE_SCHEMA_CHANGED');
  const store=new MemberInfoStore(client,s);
  for(let i=0;i<targets.length;i++){
   const t=targets[i]!,out=outcomes[i]!;
   try{
    const sourceMember=members.filter(m=>m.companyMemberId===t.uid&&m.name.trim()===t.name.trim());if(sourceMember.length!==1)profileFail('PROFILE_SOURCE_IDENTITY_CHANGED');
    const match=await store.find(t.uid);if(!match||match.id!==t.pageId)profileFail('PROFILE_IDENTITY_CONFLICT');
    const source=await readCompanyDemographics(settings.companyPage,t.uid,t.name,()=>company.verifyAccount());intended.set(t.uid,source);
    const expected:Partial<Record<DemographicField,string>>={};
    for(const f of t.fields)if(source[f]!==null)expected[f]=hash(f==='birthDate'?source.birthDate:source.gender==='M'?s.maleOption:s.femaleOption);
    await query('INSERT INTO oneoff_profile_targets(run_id,page_id,uid,expected_hashes,dispatched) VALUES($1,$2,$3,$4::jsonb,false) ON CONFLICT(run_id,page_id) DO NOTHING',[run.id,t.pageId,t.uid,JSON.stringify(expected)]);
    await company.verifyAccount();const before=await store.readPage(t.pageId,t.uid),properties:Record<string,unknown>={},send:DemographicField[]=[];
    for(const f of t.fields){if(!profileFieldEmpty(before,f,s)){out.heldFields.push(f);out.reasons[f]='existing_value';}else if(source[f]===null){out.heldFields.push(f);out.reasons[f]=source.reasons[f]??'source_missing';}else{properties[s[f]]=profileValue(source,f,s);send.push(f);}}
    for(const f of out.heldFields)await auditEvent({stage:'map',outcome:'held',memberId:t.uid,fields:[f],reasonCode:auditReason(out.reasons[f]??'source_missing'),beforeState:out.reasons[f]==='existing_value'?'present':'empty',afterState:'not_written'});
    if(!send.length){out.status='held';await persist();continue;}
    let uncertain=false;try{await withAuditMember(t.uid,send,()=>client.write('PATCH','/pages/'+t.pageId,{properties}));}catch(e){if(e instanceof NotionWriteUncertainError)uncertain=true;else throw e;}
    out.uncertainResponse=uncertain;const after=await store.readPage(t.pageId,t.uid);
    for(const f of send){if(hash(currentScalar(after,f,s))===expected[f])out.savedFields.push(f);else out.reasons[f]='readback_unverified';}
    out.protectedPropertiesUnchanged=JSON.stringify(protectedProperties(before,send.map(f=>s[f])))===JSON.stringify(protectedProperties(after,send.map(f=>s[f])));
    out.status=out.savedFields.length===send.length&&out.protectedPropertiesUnchanged?(uncertain?'observed_match_after_uncertain':'verified'):'needs_review';
    await auditEvent({stage:'readback',outcome:out.status==='verified'?'succeeded':out.uncertainResponse?'uncertain':'failed',memberId:t.uid,fields:send,provider:'notion',operation:'reconcile',readbackMatch:out.savedFields.length===send.length,protectedUnchanged:out.protectedPropertiesUnchanged,afterState:out.savedFields.length===send.length?'matched':'mismatched'});
    await query('UPDATE oneoff_profile_targets SET outcome=$3::jsonb WHERE run_id=$1 AND page_id=$2',[run.id,t.pageId,JSON.stringify(out)]);await persist();
   }catch(e){await auditEvent({stage:'error',outcome:'failed',memberId:t.uid,fields:t.fields,error:e});const dispatched=(await query<{dispatched:boolean}>('SELECT dispatched FROM oneoff_profile_targets WHERE run_id=$1 AND page_id=$2',[run.id,t.pageId])).rows[0]?.dispatched===true;out.status=dispatched?'needs_review':'held';out.errorCode=publicCode(e);for(const f of t.fields)if(!out.savedFields.includes(f)&&!out.heldFields.includes(f)){out.heldFields.push(f);out.reasons[f]=out.errorCode;}await persist();}
  }
  await company.verifyAccount();report.completed=true;report.savedFieldCount=outcomes.reduce((n,o)=>n+o.savedFields.length,0);report.executionHeldFieldCount=outcomes.reduce((n,o)=>n+o.heldFields.length,0);report.authorizationConsumed=true;report.reusable=false;await persist();
  const status=outcomes.some(o=>o.status==='needs_review'||o.uncertainResponse)?'needs_review':outcomes.some(o=>o.heldFields.length||o.status!=='verified')?'partial':'succeeded';
  await query('UPDATE oneoff_profile_saves SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1',[run.id,status]);return true;
 }catch(e){if(run)await auditEvent({stage:'error',outcome:'failed',error:e});if(run)await query("UPDATE oneoff_profile_saves SET status='needs_review',error_code=$2,finished_at=now(),updated_at=now() WHERE id=$1",[run.id,publicCode(e)]);return !!run;}
 finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('oneoff-profile-save'))");}finally{lock.release();}}
}
export function publicProfileSaveOnce(r:Row|null){return r?{id:r.id,status:r.status,targets:r.targets,report:r.report,authorizationConsumed:r.consumed_at!==null,reusable:r.status==='prepared',expiresAt:r.expires_at}:null;}

export async function runProfileSaveOnce(settings:Settings){const row=await getProfileSaveOnce();if(row?.status!=='queued')return false;return withAuditContext({runId:row.id,runKind:'profile_once',accountId:'trainer-live-one',attempt:1},async()=>{const start=Date.now();const worked=await executeProfileSaveOnce(settings);if(worked){const after=await getProfileSaveOnce();await auditEvent({stage:'complete',outcome:after?.status==='succeeded'?'succeeded':after?.status==='needs_review'?'uncertain':'held',durationMs:Date.now()-start,counts:{saved:Number(after?.report.savedFieldCount??0),held:Number(after?.report.executionHeldFieldCount??0)}});}return worked;});}
