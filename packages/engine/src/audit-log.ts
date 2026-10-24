import{AsyncLocalStorage}from'node:async_hooks';import{createHmac}from'node:crypto';import pg from'pg';import type{QueryResultRow}from'pg';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const AUDIT_STAGES=['ui_request','queued','claim','collect','map','plan','write','readback','complete','retry','error']as const;
export const AUDIT_OUTCOMES=['started','succeeded','held','failed','uncertain','skipped']as const;
export const AUDIT_FIELDS=['name','companyUid','phone','email','birthDate','gender','adminUrl','memo','fixedSlot','firstTrainingDate','callAt','status','template','survey','withdrawal','calendar']as const;
const KINDS=['preview','contact_once','profile_once','isolated_test','mock_job']as const;
const REASONS=['MISSING_SOURCE_VALUE','MASKED_SOURCE_VALUE','INVALID_SOURCE_VALUE','IDENTITY_UNVERIFIED','EXISTING_VALUE_PRESERVED','UNSUPPORTED_MAPPING','UNSUPPORTED_SCHEMA','ATOMIC_UPDATE_UNAVAILABLE','WRITE_OUTCOME_UNCERTAIN','READBACK_MISMATCH','APPROVAL_EXPIRED','REPLAY_BLOCKED','NOT_CONNECTED','UNRESOLVED_UID','RATE_LIMITED','LEASE_LOST','UID_CONFLICT','UID_REPRESENTATION_UNSAFE','UID_SCHEMA_UNSUPPORTED','UID_READBACK_MISMATCH','CONNECTION_CHANGED','ACCOUNT_CHANGED','NOT_READY','PROVIDER_UNAVAILABLE','PREVIEW_FAILED','BROWSER_EXPIRED','USER_CANCELLED','CLEANUP_PENDING','RUNNER_UNAVAILABLE','RUNNER_SCOPE_INVALID','ACCOUNT_UNVERIFIED','UNKNOWN_REASON']as const;
const ERRORS=['CONNECTION_CHANGED','ACCOUNT_CHANGED','NOT_READY','PROVIDER_UNAVAILABLE','PREVIEW_FAILED','LEASE_LOST','BROWSER_EXPIRED','USER_CANCELLED','CLEANUP_PENDING','RUNNER_UNAVAILABLE','RUNNER_SCOPE_INVALID','ACCOUNT_UNVERIFIED','UNCLASSIFIED_ERROR','NOTION_HTTP_ERROR','NOTION_TRANSPORT_UNAVAILABLE','NOTION_WRITE_OUTCOME_UNCERTAIN','NOTION_RESPONSE_INVALID','READ_FAILED','READ_RETRYABLE','READ_RATE_LIMITED','READ_AUTH_REQUIRED','WORKER_INTERRUPTED','EXECUTION_BUSY','COMPANY_AUTH_REQUIRED','COMPANY_ACCOUNT_BINDING_UNVERIFIED','COMPANY_ACCOUNT_MISMATCH','COMPANY_COVERAGE_UNVERIFIED','COMPANY_SNAPSHOT_CHANGED','COMPANY_UID_MISMATCH','COMPANY_FILTER_SCOPE_PARTIAL','COMPANY_ROW_SHAPE_MISMATCH','COMPANY_DEMOGRAPHIC_FIELD_UNVERIFIED','COMPANY_DEMOGRAPHIC_IDENTITY_UNVERIFIED','WITHDRAWAL_COVERAGE_UNVERIFIED','WITHDRAWAL_SNAPSHOT_CHANGED','WITHDRAWAL_PAGINATION_INVALID','WITHDRAWAL_IDENTITY_INVALID','MANUAL_SYNC_LEASE_LOST','TENANT_MISMATCH','INVALID_IDENTITY','PROFILE_REVIEW_REQUIRED','PROFILE_IDENTITY_CONFLICT','PROFILE_SCHEMA_CHANGED','PROFILE_APPROVAL_EXPIRED','PROFILE_ATTEMPT_ALREADY_CONSUMED','CONTACT_SAVE_REVIEW_REQUIRED','CONTACT_SAVE_IDENTITY_CONFLICT','CONTACT_SAVE_APPROVAL_EXPIRED','CONTACT_SAVE_ATTEMPT_ALREADY_CONSUMED','MEMBER_INFO_ATOMIC_UPDATE_UNAVAILABLE']as const;
const ERROR_SUMMARY:Record<string,string>={NOTION_HTTP_ERROR:'Notion request failed; inspect status and run trace.',NOTION_WRITE_OUTCOME_UNCERTAIN:'Write acknowledgement uncertain; read-only reconciliation required.',NOTION_TRANSPORT_UNAVAILABLE:'Provider transport unavailable.',UNCLASSIFIED_ERROR:'Operation failed; original error text omitted.'};
type Kind=typeof KINDS[number];type Stage=typeof AUDIT_STAGES[number];type Outcome=typeof AUDIT_OUTCOMES[number];export type AuditField=typeof AUDIT_FIELDS[number];
export interface AuditContext{runId:string;runKind:Kind;requestId?:string;accountId?:string;verifiedAccountId?:string;memberId?:string;attempt?:number;fields?:readonly string[]}
export interface AuditInput{stage:Stage;outcome:Outcome;runId?:string;runKind?:Kind;requestId?:string;accountId?:string;verifiedAccountId?:string;memberId?:string;attempt?:number;retryCount?:number;fields?:readonly string[];reasonCode?:string;errorCode?:string;error?:unknown;durationMs?:number;httpStatus?:number;provider?:string;operation?:string;beforeState?:string;afterState?:string;readbackMatch?:boolean;protectedUnchanged?:boolean;counts?:Partial<Record<'members'|'requests'|'mapped'|'held'|'saved'|'missing',number>>}
export interface SafeAuditEvent{runId:string;runKind:Kind;occurredAt:string;level:'info'|'warn'|'error';stage:Stage;outcome:Outcome;requestId?:string;accountRef?:string;tenantRef?:string;memberRef?:string;attempt:number;retryCount:number;fields:AuditField[];reasonCode?:string;errorCode?:string;errorSummary?:string;durationMs?:number;httpStatus?:number;provider?:string;operation?:string;beforeState?:string;afterState?:string;readbackMatch?:boolean;protectedUnchanged?:boolean;counts?:Record<string,number>}
type TestSink={key:string;sink:(event:SafeAuditEvent)=>Promise<void>};
const context=new AsyncLocalStorage<AuditContext&{testSink?:TestSink}>();
export function setVerifiedAuditAccount(uid:string,trainerId:string):void{const c=context.getStore();if(c&&/^[A-Za-z0-9_-]{1,128}$/.test(uid)&&/^[A-Za-z0-9_-]{1,128}$/.test(trainerId))c.verifiedAccountId=JSON.stringify([uid,trainerId]);}
export function currentAuditContext():AuditContext|undefined{return context.getStore();}
export function withAuditContext<T>(value:AuditContext,work:()=>Promise<T>):Promise<T>{return context.run({...context.getStore(),...value},work);}
export function withAuditMember<T>(memberId:string,fields:readonly string[],work:()=>Promise<T>):Promise<T>{const c=context.getStore();return c?context.run({...c,memberId,fields},work):work();}
/** Test injection is scoped to this async chain; sanitized events only reach its sink. Never enabled by env or HTTP. */
export function withAuditTestSink<T>(value:AuditContext,sink:TestSink,work:()=>Promise<T>):Promise<T>{return context.run({...value,testSink:sink},work);}
const bounded=(v:unknown,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.min(max,Math.floor(v)):undefined;
export function safeAuditError(error:unknown):{code:string;summary:string;httpStatus?:number}{
 const e=error&&typeof error==='object'?error as Record<string,unknown>:{};
 const code=typeof e.code==='string'&&(ERRORS as readonly string[]).includes(e.code)?e.code:e.name==='NotionWriteUncertainError'?'NOTION_WRITE_OUTCOME_UNCERTAIN':e.name==='NotionHttpError'?'NOTION_HTTP_ERROR':e.name==='RetryableError'||typeof e.retryAfterMs==='number'?'READ_RETRYABLE':'UNCLASSIFIED_ERROR';
 const status=bounded(e.status,599);return{code,summary:ERROR_SUMMARY[code]??'Operation failed with an allowlisted code; original details omitted.',...(status!==undefined&&status>=400?{httpStatus:status}:{})};
}
export function buildSafeAuditEvent(input:AuditInput,base:AuditContext|undefined,key:string,now=new Date()):SafeAuditEvent|null{
 const runId=input.runId??base?.runId,kind=input.runKind??base?.runKind;
 if(!runId||!UUID.test(runId)||!kind||!(KINDS as readonly string[]).includes(kind)||!(AUDIT_STAGES as readonly string[]).includes(input.stage)||!(AUDIT_OUTCOMES as readonly string[]).includes(input.outcome)||key.length<32)return null;
 const ref=(domain:string,value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=512?createHmac('sha256',key).update(JSON.stringify([domain,value])).digest('hex').slice(0,24):undefined;
 const event:SafeAuditEvent={runId,runKind:kind,occurredAt:now.toISOString(),level:input.outcome==='failed'?'error':['held','uncertain'].includes(input.outcome)||input.stage==='retry'?'warn':'info',stage:input.stage,outcome:input.outcome,attempt:bounded(input.attempt??base?.attempt,100)??0,retryCount:bounded(input.retryCount,100)??0,fields:[...new Set((input.fields??base?.fields??[]).filter((f):f is AuditField=>(AUDIT_FIELDS as readonly string[]).includes(f)))].slice(0,16)};
 const requestId=input.requestId??base?.requestId;if(requestId&&UUID.test(requestId))event.requestId=requestId;
 const tenant=ref('tenant',input.accountId??base?.accountId),account=ref('verified-company-account',input.verifiedAccountId??base?.verifiedAccountId),member=ref('member',input.memberId??base?.memberId);if(tenant)event.tenantRef=tenant;if(account)event.accountRef=account;if(member)event.memberRef=member;
 if(input.reasonCode)event.reasonCode=(REASONS as readonly string[]).includes(input.reasonCode)?input.reasonCode:'UNKNOWN_REASON';
 if(input.error!==undefined||input.errorCode){const safe=input.error!==undefined?safeAuditError(input.error):{code:(ERRORS as readonly string[]).includes(input.errorCode!)?input.errorCode!:'UNCLASSIFIED_ERROR',summary:''};event.errorCode=safe.code;event.errorSummary=safe.summary||ERROR_SUMMARY[safe.code]||'Operation failed with an allowlisted code; original details omitted.';if('httpStatus'in safe&&safe.httpStatus)event.httpStatus=safe.httpStatus;}
 for(const k of ['durationMs','httpStatus']as const){const n=bounded(input[k],k==='durationMs'?3600000:599);if(n!==undefined&&(k!=='httpStatus'||n>=100))event[k]=n;}
 for(const[k,values]of [['provider',['ui','company','notion','local']],['operation',['read','query','transform','update','create','queue','execute','reconcile']]]as const)if(input[k]&&values.includes(input[k] as never))event[k]=input[k];
 const states=['empty','present','unchanged','matched','mismatched','unverified','not_written'];for(const k of ['beforeState','afterState']as const)if(input[k]&&states.includes(input[k]!))event[k]=input[k];
 for(const k of ['readbackMatch','protectedUnchanged']as const)if(typeof input[k]==='boolean')event[k]=input[k];
 if(input.counts){const c:Record<string,number>={};for(const k of ['members','requests','mapped','held','saved','missing']as const){const n=bounded(input.counts[k],100000);if(n!==undefined)c[k]=n;}if(Object.keys(c).length)event.counts=c;}
 return Buffer.byteLength(JSON.stringify(event))<=2048?event:null;
}
let keyPromise:Promise<string>|undefined,lastWarning=0,dropped=0,auditPool:pg.Pool|undefined;
export function auditPoolLimits(){return{max:1,connectionTimeoutMillis:500,statement_timeout:1000,query_timeout:1500,idleTimeoutMillis:1000,allowExitOnIdle:true};}
async function query<T extends QueryResultRow=QueryResultRow>(sql:string,values:unknown[]=[]){if(!auditPool){if(!process.env.DATABASE_URL)throw Error('AUDIT_DATABASE_UNAVAILABLE');auditPool=new pg.Pool({connectionString:process.env.DATABASE_URL,...auditPoolLimits()});auditPool.on('error',()=>{keyPromise=undefined;dropped++;if(Date.now()-lastWarning>60000){lastWarning=Date.now();console.warn(JSON.stringify({code:'AUDIT_IDLE_CONNECTION_ERROR',droppedEvents:dropped}));}});}if(auditPool.waitingCount>=20)throw Error('AUDIT_BUFFER_FULL');return auditPool.query<T>(sql,values);}
export async function closeAuditLog(){if(auditPool){await auditPool.end();auditPool=undefined;}keyPromise=undefined;}
async function getKey(){if(!keyPromise)keyPromise=query<{pseudonym_key:string}>('SELECT pseudonym_key FROM sync_audit_settings WHERE singleton=true').then(r=>{if(!r.rows[0]?.pseudonym_key)throw Error('AUDIT_KEY_UNAVAILABLE');return r.rows[0].pseudonym_key;}).catch(e=>{keyPromise=undefined;throw e;});return keyPromise;}
export async function pruneAuditLog():Promise<void>{
 await query("DELETE FROM sync_audit_events WHERE occurred_at<now()-interval '30 days'");
 await query('DELETE FROM sync_audit_events WHERE id IN(SELECT id FROM sync_audit_events ORDER BY id DESC OFFSET 18000)');
}
export async function auditEvent(input:AuditInput):Promise<boolean>{
 const base=context.getStore();if(!base&&!input.runId)return false;
 try{const key=base?.testSink?.key??await getKey(),event=buildSafeAuditEvent(input,base,key);if(!event)return false;
  if(base?.testSink){await base.testSink.sink(event);return true;}
  const inserted=await query('INSERT INTO sync_audit_events(run_id,occurred_at,level,run_kind,stage,outcome,event) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE(SELECT count(*) FROM sync_audit_events)<20000',[event.runId,event.occurredAt,event.level,event.runKind,event.stage,event.outcome,JSON.stringify(event)]);
  if(inserted.rowCount!==1)throw Error('AUDIT_CAPACITY_REACHED');return true;
 }catch{dropped++;if(Date.now()-lastWarning>60000){lastWarning=Date.now();console.warn(JSON.stringify({code:'AUDIT_PERSISTENCE_UNAVAILABLE',droppedEvents:dropped}));}return false;}
}
export function auditReason(reason:string):string{
 if(reason==='source_missing')return'MISSING_SOURCE_VALUE';if(reason==='source_masked')return'MASKED_SOURCE_VALUE';
 if(['source_format_uncertain','source_invalid_date','source_selection_uncertain'].includes(reason))return'INVALID_SOURCE_VALUE';
 if(['source_field_unverified','source_options_unverified'].includes(reason))return'UNSUPPORTED_SCHEMA';
 if(['existing_value','preserved_existing'].includes(reason))return'EXISTING_VALUE_PRESERVED';
 if(reason.includes('ATOMIC'))return'ATOMIC_UPDATE_UNAVAILABLE';if(reason.includes('EXPIRED'))return'APPROVAL_EXPIRED';
 if(reason.includes('IDENTITY')||reason==='uid_unverified')return'IDENTITY_UNVERIFIED';return'UNKNOWN_REASON';
}
