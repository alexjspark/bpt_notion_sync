import{runtimeReady}from'./team-worker-dispatch.ts';
import {randomUUID}from'node:crypto';
import type{PoolClient}from'pg';
import{query,transaction}from'@trainer/db';
import{assertActor,type TeamActor}from'./team-auth.ts';
import{TeamError,requireUuid}from'./team-errors.ts';
import{validateBinding,type CompanyBinding,type CompanySessionProvider}from'./team-providers.ts';
export type BrowserScope={tenantId:string;sessionId:string};
export type BrowserAction='allocate'|'probe'|'stop';
export const browserHandle=(scope:BrowserScope)=>'team-browser:'+requireUuid(scope.sessionId);
export function checkBrowserHandle(scope:BrowserScope,handle:string){requireUuid(scope.tenantId);if(handle!==browserHandle(scope))throw new TeamError('FORBIDDEN',403);}
export async function requestBrowserOperation(c:Pick<PoolClient,'query'>,scope:BrowserScope,action:BrowserAction){
 requireUuid(scope.tenantId);requireUuid(scope.sessionId);
 await c.query("INSERT INTO team_browser_operations(id,tenant_id,session_id,action) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,session_id,action) DO UPDATE SET status='queued',attempts=0,available_at=now(),reason_code=NULL,updated_at=now() WHERE team_browser_operations.status='succeeded' AND team_browser_operations.action='probe'",[randomUUID(),scope.tenantId,scope.sessionId,action]);
}
export interface BrowserAuthority{tenantId:string;sessionId:string;connectionId:string;revision:number;expiresAt:number;userId:string;authSessionHash:string}
export async function browserAuthority(actor:TeamActor,sessionId:string):Promise<BrowserAuthority>{
 assertActor(actor);requireUuid(sessionId);
 const r=await query("SELECT c.id,c.revision,b.expires_at FROM team_connections c JOIN team_browser_sessions b ON(b.tenant_id=c.tenant_id AND b.id=c.active_session_id) JOIN team_users u ON(u.tenant_id=b.tenant_id AND u.id=b.owner_user_id) JOIN team_tenants t ON t.id=b.tenant_id JOIN team_sessions a ON a.token_hash=b.auth_session_hash JOIN team_browser_allocations x ON(x.tenant_id=b.tenant_id AND x.session_id=b.id) WHERE c.tenant_id=$1 AND b.id=$2 AND b.owner_user_id=$3 AND b.auth_session_hash=$4 AND b.status IN('login_required','verified') AND b.expires_at>now() AND x.status='ready' AND u.active AND t.active AND u.auth_version=b.owner_auth_version AND a.revoked_at IS NULL AND a.expires_at>now() AND a.user_id=u.id AND a.tenant_id=t.id AND a.auth_version=u.auth_version",[actor.tenantId,sessionId,actor.userId,actor.sessionRef]);
 if(!r.rows[0])throw new TeamError('NOT_FOUND',404);
 const row=r.rows[0];return{tenantId:actor.tenantId,sessionId,connectionId:row.id,revision:row.revision,expiresAt:new Date(row.expires_at).getTime(),userId:actor.userId,authSessionHash:actor.sessionRef};
}
export async function activeBrowser(scope:BrowserScope){
 const r=await query("SELECT b.*,c.id AS connection_id,c.revision,c.expected_company_binding FROM team_browser_sessions b JOIN team_connections c ON(c.tenant_id=b.tenant_id AND c.active_session_id=b.id) JOIN team_users u ON(u.tenant_id=b.tenant_id AND u.id=b.owner_user_id) JOIN team_tenants t ON t.id=b.tenant_id JOIN team_sessions a ON a.token_hash=b.auth_session_hash WHERE b.tenant_id=$1 AND b.id=$2 AND b.expires_at>now() AND b.status IN('starting','queued','login_required','verified') AND t.active AND u.active AND u.auth_version=b.owner_auth_version AND a.revoked_at IS NULL AND a.expires_at>now() AND a.auth_version=u.auth_version AND a.tenant_id=t.id AND a.user_id=u.id",[requireUuid(scope.tenantId),requireUuid(scope.sessionId)]);
 return r.rows[0]??null;
}
/** Web-side provider: database outbox only, never Docker/process/CDP authority. */
export class QueuedCompanySessionProvider implements CompanySessionProvider{
 readonly available=true;
 ready=()=>this.routeConfigured?runtimeReady(['runner','worker','gateway','egress']):Promise.resolve(false);
 constructor(private readonly inspectLive?:(scope:BrowserScope)=>Promise<CompanyBinding>,private readonly waitMs=5000,private readonly routeConfigured=true){}
 async begin(scope:BrowserScope){
  await transaction(async c=>{
   const b=(await c.query("SELECT b.id,c.id AS connection_id FROM team_browser_sessions b JOIN team_connections c ON(c.tenant_id=b.tenant_id AND c.active_session_id=b.id) WHERE b.tenant_id=$1 AND b.id=$2 AND b.status='starting' AND b.expires_at>now()",[requireUuid(scope.tenantId),requireUuid(scope.sessionId)])).rows[0];
   if(!b)throw new TeamError('CONNECTION_CHANGED');
   await c.query("INSERT INTO team_browser_allocations(tenant_id,session_id,connection_id,status) VALUES($1,$2,$3,'queued') ON CONFLICT DO NOTHING",[scope.tenantId,scope.sessionId,b.connection_id]);await requestBrowserOperation(c,scope,'allocate');
  });return{handle:browserHandle(scope),status:'queued' as const};
 }
 async inspect(scope:BrowserScope&{handle:string}):Promise<CompanyBinding>{
  checkBrowserHandle(scope,scope.handle);if(!await activeBrowser(scope))throw new TeamError('ACCOUNT_UNVERIFIED');
  if(this.inspectLive)return validateBinding(await this.inspectLive(scope));
  const started=Date.now();await requestBrowserOperation({query} as Pick<PoolClient,'query'>,scope,'probe');
  do{
   const r=(await query("SELECT account_binding,account_observed_at FROM team_browser_allocations WHERE tenant_id=$1 AND session_id=$2 AND status='ready' AND account_observed_at>to_timestamp($3/1000.0)",[scope.tenantId,scope.sessionId,started])).rows[0];
   if(r?.account_binding&&await activeBrowser(scope))return validateBinding(r.account_binding);
   await new Promise(r=>setTimeout(r,100));
  }while(Date.now()-started<this.waitMs);
  throw new TeamError('ACCOUNT_UNVERIFIED');
 }
 async revoke(scope:BrowserScope&{handle:string}){
  if(scope.handle&&scope.handle!==browserHandle(scope))throw new TeamError('FORBIDDEN',403);
  // tenant+session are the reconciliation key even if allocation never returned a handle.
  await requestBrowserOperation({query} as Pick<PoolClient,'query'>,scope,'stop');
 }
}
export async function stopBrowserInTransaction(c:PoolClient,scope:BrowserScope,reason='BROWSER_EXPIRED'){
 await c.query("UPDATE team_browser_sessions SET status=$3,expires_at=LEAST(expires_at,now()) WHERE tenant_id=$1 AND id=$2",[scope.tenantId,scope.sessionId,reason==='USER_CANCELLED'?'revoked':'expired']);
 await c.query("UPDATE team_connections SET active_session_id=NULL,company_status='not_connected',company_binding=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND active_session_id=$2",[scope.tenantId,scope.sessionId]);
 await c.query("UPDATE team_preview_runs SET status='held',reason_code=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND snapshot->>'sessionId'=$2 AND status IN('queued','running')",[scope.tenantId,scope.sessionId,reason]);
 await c.query("UPDATE team_browser_allocations SET status='stopping',account_binding=NULL,account_observed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND status<>'stopped'",[scope.tenantId,scope.sessionId]);
 await requestBrowserOperation(c,scope,'stop');
}
export async function sweepExpiredBrowsers(tenantId?:string):Promise<number>{
 return transaction(async c=>{
  // Lock connections first, matching web operations; no Docker calls while holding this transaction.
  const rows=(await c.query("SELECT c.tenant_id,b.id FROM team_connections c JOIN team_browser_sessions b ON(b.tenant_id=c.tenant_id AND b.id=c.active_session_id) LEFT JOIN team_sessions a ON a.token_hash=b.auth_session_hash LEFT JOIN team_users u ON u.id=b.owner_user_id LEFT JOIN team_tenants t ON t.id=c.tenant_id WHERE ($1::uuid IS NULL OR c.tenant_id=$1) AND (b.expires_at<=now() OR a.token_hash IS NULL OR a.expires_at<=now() OR a.revoked_at IS NOT NULL OR NOT COALESCE(u.active,false) OR NOT COALESCE(t.active,false) OR u.auth_version<>b.owner_auth_version OR b.status IN('allocation_uncertain','revoked','expired','failed')) ORDER BY c.tenant_id FOR UPDATE OF c SKIP LOCKED LIMIT 32",[tenantId??null])).rows;
  for(const row of rows)await stopBrowserInTransaction(c,{tenantId:row.tenant_id,sessionId:row.id});
  return rows.length;
 });
}
