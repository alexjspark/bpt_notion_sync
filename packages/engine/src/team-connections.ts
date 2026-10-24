import {sweepExpiredBrowsers,stopBrowserInTransaction,requestBrowserOperation}from'./team-browser-store.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query,transaction } from '@trainer/db';
import { assertActor,type TeamActor } from './team-auth.ts';
import { TeamError,requireUuid } from './team-errors.ts';
import { TeamVault,type SecretEnvelope } from './team-vault.ts';
import { destination,validateBinding,type TeamDestination,type CompanyBinding,type CompanySessionProvider,type TeamNotionValidator } from './team-providers.ts';
export interface ConnectionRow{tenant_id:string;id:string;revision:number;company_status:string;company_binding:CompanyBinding|null;active_session_id:string|null;notion_status:string;notion_destination:TeamDestination|null;secret_revision:number|null;expected_company_binding:CompanyBinding|null}
export async function actorTransaction<T>(actor:TeamActor,work:(c:PoolClient)=>Promise<T>):Promise<T>{
 assertActor(actor);return transaction(async c=>{
  const u=await c.query('SELECT 1 FROM team_users u JOIN team_tenants t ON t.id=u.tenant_id JOIN team_sessions a ON(a.user_id=u.id AND a.tenant_id=t.id AND a.token_hash=$4) WHERE u.id=$1 AND u.tenant_id=$2 AND u.active AND t.active AND u.auth_version=$3 AND a.auth_version=u.auth_version AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR SHARE OF u,t,a',[actor.userId,actor.tenantId,actor.authVersion,actor.sessionRef]);
  if(!u.rowCount)throw new TeamError('AUTH_REQUIRED',401);return work(c);
 });
}
export async function lockConnection(c:PoolClient,tenantId:string):Promise<ConnectionRow>{
 await c.query('INSERT INTO team_connections(tenant_id,id) VALUES($1,$2) ON CONFLICT(tenant_id) DO NOTHING',[tenantId,randomUUID()]);
 return(await c.query('SELECT * FROM team_connections WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows[0];
}
export async function invalidateRuns(c:PoolClient,tenantId:string):Promise<void>{
 await c.query("UPDATE team_preview_runs SET status='held',reason_code='CONNECTION_CHANGED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND status IN('queued','running')",[tenantId]);
}
function checkRevision(row:ConnectionRow,revision:number){if(!Number.isSafeInteger(revision)||row.revision!==revision)throw new TeamError('CONNECTION_CHANGED');}
export class TeamConnections{
 constructor(readonly vault:TeamVault,readonly company:CompanySessionProvider,private readonly notion:TeamNotionValidator){}
 async status(actor:TeamActor){
  assertActor(actor);await sweepExpiredBrowsers(actor.tenantId);
  return actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);
   const operation=(await c.query('SELECT action,status,reason_code FROM team_browser_operations WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 1',[actor.tenantId])).rows[0];
   const session=row.active_session_id?(await c.query('SELECT id,status,expires_at,owner_user_id,auth_session_hash FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,row.active_session_id])).rows[0]:null;
   return{id:row.id,revision:row.revision,browserOperation:operation?{action:operation.action,status:operation.status,reasonCode:operation.reason_code}:null,companyStatus:session&&new Date(session.expires_at)>new Date()?row.company_status:'not_connected',notionStatus:row.notion_status,destination:row.notion_destination,session:session?{id:session.id,status:session.status,expiresAt:new Date(session.expires_at).toISOString(),browserUrl:session.owner_user_id===actor.userId&&session.auth_session_hash===actor.sessionRef&&['login_required','verified'].includes(session.status)?'/team/browser/'+session.id+'/':null}:null,vaultReady:this.vault.ready,companyProviderReady:this.company.available&&(this.company.ready?await this.company.ready():true),writesEnabled:false,scheduleEnabled:false,fullSyncComplete:false};
  });
 }
 async connectNotion(actor:TeamActor,input:{revision:number;token:string;destination:unknown}){
  assertActor(actor);if(!this.vault.ready)throw new TeamError('VAULT_UNCONFIGURED');
  const d=destination(input.destination);
  // No unvalidated key is persisted. Provider failure never replaces the current connection.
  const initial=await this.status(actor);if(initial.revision!==input.revision)throw new TeamError('CONNECTION_CHANGED');
  if(typeof input.token!=='string'||input.token.length<8||input.token.length>4096||/[\r\n\0]/.test(input.token))throw new TeamError('SECRET_INVALID',400);
  await this.notion.validate(input.token,d);
  await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,input.revision);const revision=row.revision+1;
   const envelope=this.vault.seal({tenantId:actor.tenantId,connectionId:row.id,revision,purpose:'notion'},input.token);
   await c.query('INSERT INTO team_secrets(tenant_id,connection_id,revision,purpose,envelope) VALUES($1,$2,$3,$4,$5::jsonb)',[actor.tenantId,row.id,revision,'notion',JSON.stringify(envelope)]);
   await c.query("UPDATE team_connections SET revision=$2,notion_status='verified',notion_destination=$3::jsonb,secret_revision=$2,updated_at=now() WHERE tenant_id=$1",[actor.tenantId,revision,JSON.stringify(d)]);
   await invalidateRuns(c,actor.tenantId);
   await c.query('DELETE FROM team_secrets WHERE tenant_id=$1 AND revision<>$2',[actor.tenantId,revision]);
  });return this.status(actor);
 }
 async disconnectNotion(actor:TeamActor,revision:number){
  await actorTransaction(actor,async c=>{const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);await c.query("UPDATE team_connections SET revision=revision+1,notion_status='not_connected',notion_destination=NULL,secret_revision=NULL,updated_at=now() WHERE tenant_id=$1",[actor.tenantId]);await c.query('DELETE FROM team_secrets WHERE tenant_id=$1',[actor.tenantId]);await invalidateRuns(c,actor.tenantId);});return this.status(actor);
 }
 async beginCompany(actor:TeamActor,revision:number){
  assertActor(actor);if(!this.company.available||this.company.ready&&!await this.company.ready())throw new TeamError('PROVIDER_UNAVAILABLE');
  await sweepExpiredBrowsers(actor.tenantId);const id=randomUUID(),scope={tenantId:actor.tenantId,sessionId:id};
  await actorTransaction(actor,async c=>{const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);if(row.active_session_id)throw new TeamError('CONFLICT');await c.query("INSERT INTO team_browser_sessions(id,tenant_id,provider_handle,status,expires_at,owner_user_id,owner_auth_version,auth_session_hash) VALUES($1,$2,'','starting',now()+interval '1 hour',$3,$4,$5)",[id,actor.tenantId,actor.userId,actor.authVersion,actor.sessionRef]);await c.query("UPDATE team_connections SET active_session_id=$2,company_status='login_required',company_binding=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1",[actor.tenantId,id]);await invalidateRuns(c,actor.tenantId);});
  let handle='';
  try{
   const allocation=this.company.begin(scope);let late=false;
   allocation.then(v=>{if(late)void this.company.revoke({...scope,handle:v.handle}).catch(()=>{});}).catch(()=>{});
   let timer:ReturnType<typeof setTimeout>|undefined;
   const allocated=await Promise.race([allocation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{late=true;reject(new TeamError('PROVIDER_UNAVAILABLE'));},15000);})]).finally(()=>clearTimeout(timer));
   handle=allocated.handle;if(!handle||handle.length>256)throw new TeamError('PROVIDER_UNAVAILABLE');
   const accepted=await actorTransaction(actor,async c=>{const row=await lockConnection(c,actor.tenantId);if(row.active_session_id!==id)return false;return(await c.query("UPDATE team_browser_sessions SET provider_handle=$3,status=$4 WHERE tenant_id=$1 AND id=$2 AND status='starting' AND expires_at>now()",[actor.tenantId,id,handle,allocated.status??'login_required'])).rowCount===1;});
   if(!accepted)throw new TeamError('CONNECTION_CHANGED');
  }catch(error){
   await transaction(async c=>{
    await c.query("UPDATE team_browser_sessions SET status='allocation_uncertain' WHERE tenant_id=$1 AND id=$2 AND status='starting'",[actor.tenantId,id]);
    await requestBrowserOperation(c,scope,'stop');
   });
   if(handle)try{await this.company.revoke({...scope,handle});}catch{}
   throw error instanceof TeamError?error:new TeamError('PROVIDER_UNAVAILABLE');
  }return this.status(actor);
 }
 async confirmCompany(actor:TeamActor,sessionId:string,revision:number){
  requireUuid(sessionId);
  const initial=await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);
   const s=(await c.query("SELECT * FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 AND owner_user_id=$3 AND auth_session_hash=$4 AND expires_at>now() AND status IN('login_required','verified')",[actor.tenantId,sessionId,actor.userId,actor.sessionRef])).rows[0];
   if(!s||row.active_session_id!==sessionId)throw new TeamError('NOT_FOUND',404);return s;
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  const binding=validateBinding(await Promise.race([this.company.inspect({tenantId:actor.tenantId,sessionId,handle:initial.provider_handle}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TeamError('ACCOUNT_UNVERIFIED')),10000);})]).finally(()=>clearTimeout(timer)));
  await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);
   if(row.active_session_id!==sessionId)throw new TeamError('CONNECTION_CHANGED');
   const expected=row.expected_company_binding??row.company_binding;
   if(expected&&JSON.stringify(binding)!==JSON.stringify(expected))throw new TeamError('ACCOUNT_CHANGED');
   const updated=await c.query("UPDATE team_browser_sessions SET status='verified' WHERE tenant_id=$1 AND id=$2 AND owner_user_id=$3 AND auth_session_hash=$4 AND expires_at>now() AND status IN('login_required','verified')",[actor.tenantId,sessionId,actor.userId,actor.sessionRef]);
   if(!updated.rowCount)throw new TeamError('CONNECTION_CHANGED');
   await c.query("UPDATE team_connections SET company_status='verified',company_binding=$2::jsonb,expected_company_binding=COALESCE(expected_company_binding,$2::jsonb),revision=revision+1,updated_at=now() WHERE tenant_id=$1",[actor.tenantId,JSON.stringify(binding)]);await invalidateRuns(c,actor.tenantId);
  });return this.status(actor);
 }
 async revokeCompany(actor:TeamActor,sessionId:string,revision:number){
  requireUuid(sessionId);
  const handle=await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);
   const session=(await c.query('SELECT * FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[actor.tenantId,sessionId,actor.userId])).rows[0];
   if(!session||row.active_session_id!==sessionId)throw new TeamError('NOT_FOUND',404);
   await stopBrowserInTransaction(c,{tenantId:actor.tenantId,sessionId},'USER_CANCELLED');return session.provider_handle;
  });
  try{await this.company.revoke({tenantId:actor.tenantId,sessionId,handle});}catch{throw new TeamError('PROVIDER_UNAVAILABLE');}return this.status(actor);
 }
 async tokenForRun(c:PoolClient,row:ConnectionRow):Promise<string>{
  if(!row.secret_revision)throw new TeamError('NOT_READY');
  const secret=(await c.query('SELECT envelope FROM team_secrets WHERE tenant_id=$1 AND connection_id=$2 AND revision=$3 AND purpose=$4',[row.tenant_id,row.id,row.secret_revision,'notion'])).rows[0];
  if(!secret)throw new TeamError('NOT_READY');return this.vault.open({tenantId:row.tenant_id,connectionId:row.id,revision:row.secret_revision,purpose:'notion'},secret.envelope as SecretEnvelope);
 }
}
