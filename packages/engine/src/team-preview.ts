import { isManualSyncErrorCode } from './manual-sync-plan.ts';
import { randomUUID } from 'node:crypto';
import { query,transaction } from '@trainer/db';
import { assertActor,type TeamActor } from './team-auth.ts';
import { TeamError,requireUuid } from './team-errors.ts';
import { actorTransaction,lockConnection,type TeamConnections } from './team-connections.ts';
import { safeSummary,validateBinding,type TeamPreviewProvider } from './team-providers.ts';
import { auditEvent,withAuditContext } from './audit-log.ts';
export class TeamPreviewQueue{
 constructor(private readonly connections:TeamConnections,private readonly provider:TeamPreviewProvider){}
 get providerReady(){return this.provider.available;}
 async enqueue(actor:TeamActor,requestId:string){
  requireUuid(requestId);return actorTransaction(actor,async c=>{
   const row=await lockConnection(c,actor.tenantId);
   const replay=(await c.query('SELECT id FROM team_preview_runs WHERE tenant_id=$1 AND request_id=$2',[actor.tenantId,requestId])).rows[0];if(replay){const existing=(await c.query('SELECT id,status,reason_code,result FROM team_preview_runs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,replay.id])).rows[0];return{id:existing.id,status:existing.status,reasonCode:existing.reason_code,result:existing.result};}
   if(!this.provider.available)throw new TeamError('PROVIDER_UNAVAILABLE');
   const session=(await c.query("SELECT id FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 AND status='verified' AND expires_at>now()",[actor.tenantId,row.active_session_id])).rows[0];
   if(row.company_status!=='verified'||row.notion_status!=='verified'||!row.notion_destination||!row.company_binding||!session)throw new TeamError('NOT_READY');
   if((await c.query("SELECT 1 FROM team_preview_runs WHERE tenant_id=$1 AND status IN('queued','running')",[actor.tenantId])).rowCount)throw new TeamError('CONFLICT');
   const id=randomUUID(),snapshot={destination:row.notion_destination,binding:row.company_binding,sessionId:session.id,secretRevision:row.secret_revision,userId:actor.userId,authVersion:actor.authVersion};
   await c.query("INSERT INTO team_preview_runs(id,tenant_id,request_id,connection_id,revision,snapshot,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,'queued')",[id,actor.tenantId,requestId,row.id,row.revision,JSON.stringify(snapshot)]);
   await withAuditContext({runId:id,runKind:'preview',requestId,accountId:actor.tenantId},async()=>{await auditEvent({stage:'queued',outcome:'succeeded',provider:'local',operation:'queue'});});
   return{id,status:'queued',reasonCode:null,result:null};
  });
 }
 async get(actor:TeamActor,id:string){
  requireUuid(id);return actorTransaction(actor,async c=>{
   const row=(await c.query('SELECT id,status,reason_code,result,created_at,updated_at FROM team_preview_runs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id])).rows[0];if(!row)throw new TeamError('NOT_FOUND',404);
   return{id:row.id,status:row.status,reasonCode:row.reason_code,result:row.result,createdAt:row.created_at,updatedAt:row.updated_at};
  });
 }
 async logs(actor:TeamActor,id:string){
  requireUuid(id);return actorTransaction(actor,async c=>{
   const exists=await c.query('SELECT 1 FROM team_preview_runs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id]);if(!exists.rowCount)throw new TeamError('NOT_FOUND',404);
   return(await c.query('SELECT event FROM sync_audit_events WHERE run_id=$1 ORDER BY occurred_at,id LIMIT 100',[id])).rows.map(r=>r.event);
  });
 }
 /** Worker-internal only: tenant selected by a trusted dispatcher, never a public request parameter. No writes exist in this queue. */
 async runNext(tenantId:string):Promise<boolean>{
  requireUuid(tenantId);if(!this.provider.available)throw new TeamError('PROVIDER_UNAVAILABLE');
  const lease=randomUUID();
  const claimed=await transaction(async c=>{
   const conn=await lockConnection(c,tenantId);
   // Interrupted reads are held, not automatically replayed against a potentially changed account.
   await c.query("UPDATE team_preview_runs SET status='held',reason_code='LEASE_LOST',lease_token=NULL,lease_until=NULL WHERE tenant_id=$1 AND status='running' AND lease_until<now()",[tenantId]);
   const run=(await c.query("SELECT * FROM team_preview_runs WHERE tenant_id=$1 AND status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",[tenantId])).rows[0];if(!run)return null;
   if(run.connection_id!==conn.id||run.revision!==conn.revision){await c.query("UPDATE team_preview_runs SET status='held',reason_code='CONNECTION_CHANGED' WHERE tenant_id=$1 AND id=$2",[tenantId,run.id]);return null;}
   await c.query("UPDATE team_preview_runs SET status='running',lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,run.id,lease]);return run;
  });
  if(!claimed)return false;
  await withAuditContext({runId:claimed.id,runKind:'preview',requestId:claimed.request_id,accountId:tenantId},async()=>{
   const check=()=>transaction(async c=>{
    const conn=await lockConnection(c,tenantId);
    const active=await c.query('SELECT 1 FROM team_tenants t JOIN team_users u ON u.tenant_id=t.id WHERE t.id=$1 AND t.active AND u.active AND u.id=$2 AND u.auth_version=$3',[tenantId,claimed.snapshot.userId,claimed.snapshot.authVersion]);
    const run=(await c.query("SELECT * FROM team_preview_runs WHERE tenant_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_until>now()",[tenantId,claimed.id,lease])).rows[0];
    if(!run)throw new TeamError('LEASE_LOST');
    const s=claimed.snapshot;
    if(!active.rowCount||conn.id!==claimed.connection_id||conn.revision!==claimed.revision||conn.company_status!=='verified'||conn.notion_status!=='verified'||conn.active_session_id!==s.sessionId||conn.secret_revision!==s.secretRevision||JSON.stringify(conn.company_binding)!==JSON.stringify(s.binding)||JSON.stringify(conn.notion_destination)!==JSON.stringify(s.destination))throw new TeamError('CONNECTION_CHANGED');
    const session=(await c.query("SELECT * FROM team_browser_sessions WHERE tenant_id=$1 AND id=$2 AND status='verified' AND expires_at>now()",[tenantId,s.sessionId])).rows[0];if(!session)throw new TeamError('NOT_READY');
    return{conn,session,token:await this.connections.tokenForRun(c,conn)};
   });
   try{
    await auditEvent({stage:'claim',outcome:'succeeded',operation:'execute',provider:'local'});
    const current=await check(),scope={tenantId,sessionId:current.session.id,handle:current.session.provider_handle};
    const binding=validateBinding(await this.connections.company.inspect(scope));
    if(JSON.stringify(binding)!==JSON.stringify(claimed.snapshot.binding))throw new TeamError('ACCOUNT_CHANGED');
    await check();await auditEvent({stage:'collect',outcome:'started',provider:'company',operation:'read'});
    const result=safeSummary(await this.provider.preview({connectionId:current.conn.id,revision:current.conn.revision,...scope,binding,destination:claimed.snapshot.destination,token:current.token,assertCurrent:async()=>{await check();}}));
    await check();
    await transaction(async c=>{
     const conn=await lockConnection(c,tenantId);if(conn.revision!==claimed.revision)throw new TeamError('CONNECTION_CHANGED');
     const saved=await c.query("UPDATE team_preview_runs SET status='succeeded',result=$4::jsonb,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_until>now()",[tenantId,claimed.id,lease,JSON.stringify(result)]);if(!saved.rowCount)throw new TeamError('LEASE_LOST');
    });
    await auditEvent({stage:'complete',outcome:'succeeded',counts:{members:result.members,mapped:result.matched,held:result.held,saved:0},operation:'execute',provider:'local'});
   }catch(error){
    const code=error instanceof TeamError?error.code:error&&typeof error==='object'&&'code'in error&&isManualSyncErrorCode(error.code)?error.code:'PREVIEW_FAILED';
    await query("UPDATE team_preview_runs SET status='held',reason_code=$4,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running' AND lease_token=$3",[tenantId,claimed.id,lease,code]);
    await auditEvent({stage:'complete',outcome:'held',reasonCode:code,errorCode:code,provider:'local',operation:'execute'});
   }
  });return true;
 }
}
