import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query,transaction } from '@trainer/db';
import { assertActor,type TeamActor } from './team-auth.ts';
import { TeamError,requireUuid } from './team-errors.ts';
import { TeamVault,type SecretEnvelope } from './team-vault.ts';
import { destination,validateBinding,type TeamDestination,type CompanyBinding,type CompanySessionProvider,type TeamNotionValidator } from './team-providers.ts';
export interface ConnectionRow{tenant_id:string;id:string;revision:number;company_status:string;company_binding:CompanyBinding|null;active_session_id:string|null;notion_status:string;notion_destination:TeamDestination|null;secret_revision:number|null}
export async function actorTransaction<T>(actor:TeamActor,work:(c:PoolClient)=>Promise<T>):Promise<T>{
 assertActor(actor);return transaction(async c=>{
  const u=await c.query('SELECT 1 FROM team_users u JOIN team_tenants t ON t.id=u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2 AND u.active AND t.active AND u.auth_version=$3 FOR SHARE OF u,t',[actor.userId,actor.tenantId,actor.authVersion]);
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
  return actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);
   const session=row.active_session_id?(await c.query('SELECT id,status,expires_at FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2',[actor.tenantId,row.active_session_id])).rows[0]:null;
   return{id:row.id,revision:row.revision,companyStatus:session&&new Date(session.expires_at)>new Date()?row.company_status:'not_connected',notionStatus:row.notion_status,destination:row.notion_destination,session:session?{id:session.id,status:session.status,expiresAt:new Date(session.expires_at).toISOString()}:null,vaultReady:this.vault.ready,companyProviderReady:this.company.available,writesEnabled:false,scheduleEnabled:false,fullSyncComplete:false};
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
  if(!this.company.available)throw new TeamError('PROVIDER_UNAVAILABLE');
  // Commit a server-generated pending session before any provider allocation; uncertain allocation is never blindly retried.
  const id=randomUUID();
  await actorTransaction(actor,async c=>{const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);if(row.active_session_id)throw new TeamError('CONFLICT');await c.query("INSERT INTO team_browser_sessions(id,tenant_id,provider_handle,status,expires_at) VALUES($1,$2,'','starting',now()+interval '1 hour')",[id,actor.tenantId]);await c.query("UPDATE team_connections SET active_session_id=$2,company_status='login_required',company_binding=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1",[actor.tenantId,id]);await invalidateRuns(c,actor.tenantId);});
  try{
   const allocated=await this.company.begin({tenantId:actor.tenantId,sessionId:id});
   if(!allocated.handle||allocated.handle.length>256)throw new TeamError('PROVIDER_UNAVAILABLE');
   await actorTransaction(actor,async c=>{const row=await lockConnection(c,actor.tenantId);if(row.active_session_id!==id)throw new TeamError('CONNECTION_CHANGED');await c.query("UPDATE team_browser_sessions SET provider_handle=$3,status='login_required' WHERE tenant_id=$1 AND id=$2 AND status='starting'",[actor.tenantId,id,allocated.handle]);});
  }catch{
   await query("UPDATE team_browser_sessions SET status='allocation_uncertain' WHERE tenant_id=$1 AND id=$2",[actor.tenantId,id]);throw new TeamError('PROVIDER_UNAVAILABLE');
  }return this.status(actor);
 }
 async confirmCompany(actor:TeamActor,sessionId:string,revision:number){
  requireUuid(sessionId);
  await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);
   const session=(await c.query("SELECT * FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 AND expires_at>now() AND status IN('login_required','verified') FOR UPDATE",[actor.tenantId,sessionId])).rows[0];
   if(!session||row.active_session_id!==sessionId)throw new TeamError('NOT_FOUND',404);
   const binding=validateBinding(await this.company.inspect({tenantId:actor.tenantId,sessionId,handle:session.provider_handle}));
   if(row.company_binding&&JSON.stringify(binding)!==JSON.stringify(row.company_binding))throw new TeamError('ACCOUNT_CHANGED');
   await c.query("UPDATE team_browser_sessions SET status='verified' WHERE tenant_id=$1 AND id=$2",[actor.tenantId,sessionId]);
   await c.query("UPDATE team_connections SET company_status='verified',company_binding=$2::jsonb,revision=revision+1,updated_at=now() WHERE tenant_id=$1",[actor.tenantId,JSON.stringify(binding)]);await invalidateRuns(c,actor.tenantId);
  });return this.status(actor);
 }
 async revokeCompany(actor:TeamActor,sessionId:string,revision:number){
  requireUuid(sessionId);
  const handle=await actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);checkRevision(row,revision);
   const session=(await c.query('SELECT * FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,sessionId])).rows[0];
   if(!session||row.active_session_id!==sessionId)throw new TeamError('NOT_FOUND',404);
   await c.query("UPDATE team_browser_sessions SET status='revoked',expires_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,sessionId]);
   await c.query("UPDATE team_connections SET active_session_id=NULL,company_status='not_connected',company_binding=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1",[actor.tenantId]);await invalidateRuns(c,actor.tenantId);return session.provider_handle;
  });
  // Access is revoked even if provider cleanup fails. Keep record to reconcile; never grant a new session on this handle.
  try{await this.company.revoke({tenantId:actor.tenantId,sessionId,handle});}catch{throw new TeamError('PROVIDER_UNAVAILABLE');}return this.status(actor);
 }
 async tokenForRun(c:PoolClient,row:ConnectionRow):Promise<string>{
  if(!row.secret_revision)throw new TeamError('NOT_READY');
  const secret=(await c.query('SELECT envelope FROM team_secrets WHERE tenant_id=$1 AND connection_id=$2 AND revision=$3 AND purpose=$4',[row.tenant_id,row.id,row.secret_revision,'notion'])).rows[0];
  if(!secret)throw new TeamError('NOT_READY');return this.vault.open({tenantId:row.tenant_id,connectionId:row.id,revision:row.secret_revision,purpose:'notion'},secret.envelope as SecretEnvelope);
 }
}
