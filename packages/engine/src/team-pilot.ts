import{randomUUID}from'node:crypto';
import{query,transaction}from'@trainer/db';
import{actorTransaction,lockConnection,type TeamConnections}from'./team-connections.ts';
import type{TeamActor}from'./team-auth.ts';
import{TeamError,requireUuid}from'./team-errors.ts';
import type{PilotPlan,PilotProvider}from'./team-pilot-provider.ts';
import type{TeamPreviewInput}from'./team-adapter-preview.ts';
import{auditEvent,withAuditContext}from'./audit-log.ts';
export class TeamPilot {
 constructor(private readonly connections:TeamConnections,private readonly provider:PilotProvider,private readonly enabled=false,private readonly writeEnabled=false){}
 get writeReady(){return this.ready&&this.writeEnabled;}
 get ready(){return this.enabled&&this.connections.vault.ready;}
 private seal(tenantId:string,id:string,revision:number,plan:unknown){return this.connections.vault.seal({tenantId,connectionId:id,revision,purpose:'pilot'},JSON.stringify(plan));}
 private open(row:any){return JSON.parse(this.connections.vault.open({tenantId:row.tenant_id,connectionId:row.id,revision:row.revision,purpose:'pilot'},row.envelope));}
 async prepare(actor:TeamActor,input:{previewId:string;uid:string;requestId:string}){
  if(!this.ready)throw new TeamError('PILOT_DISABLED');
  const id=requireUuid(input.requestId);requireUuid(input.previewId);if(!/^[0-9]{1,32}$/.test(input.uid))throw new TeamError('INVALID_INPUT',400);
  await actorTransaction(actor,async c=>{
   const conn=await lockConnection(c,actor.tenantId),existing=await c.query('SELECT user_id,session_ref FROM team_pilot_runs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id]);
   if(existing.rowCount){if(existing.rows[0].user_id!==actor.userId||existing.rows[0].session_ref!==actor.sessionRef)throw new TeamError('NOT_FOUND',404);return;}
   const preview=(await c.query("SELECT * FROM team_preview_runs WHERE tenant_id=$1 AND id=$2 AND status='succeeded' AND updated_at>now()-interval '10 minutes'",[actor.tenantId,input.previewId])).rows[0];
   if(!preview||preview.revision!==conn.revision||preview.connection_id!==conn.id||preview.snapshot.sessionRef!==actor.sessionRef||preview.snapshot.userId!==actor.userId)throw new TeamError('PILOT_CHANGED');
   await c.query("UPDATE team_pilot_runs SET status='held',result=jsonb_build_object('reasonCode','EXPIRED') WHERE tenant_id=$1 AND status='prepared' AND expires_at<=now()",[actor.tenantId]);
   if((await c.query("SELECT 1 FROM team_pilot_runs WHERE tenant_id=$1 AND status IN ('queued','preparing','prepared','approved','executing','dispatching','uncertain')",[actor.tenantId])).rowCount)throw new TeamError('CONFLICT');
   const envelope=this.seal(actor.tenantId,id,conn.revision,{uid:input.uid});
   await c.query("INSERT INTO team_pilot_runs(id,tenant_id,user_id,session_ref,preview_id,connection_id,revision,envelope,snapshot,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'queued',now()+interval '15 minutes')",[id,actor.tenantId,actor.userId,actor.sessionRef,input.previewId,conn.id,conn.revision,JSON.stringify(envelope),JSON.stringify(preview.snapshot)]);
  });return this.get(actor,id);
 }
 async get(actor:TeamActor,id:string){
  requireUuid(id);return actorTransaction(actor,async c=>{
   const row=(await c.query('SELECT * FROM team_pilot_runs WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND session_ref=$4',[actor.tenantId,id,actor.userId,actor.sessionRef])).rows[0];if(!row)throw new TeamError('NOT_FOUND',404);
   const plan=row.status==='prepared'?this.open(row)as PilotPlan:null;
   return{id:row.id,status:row.status,expiresAt:new Date(row.expires_at).toISOString(),result:row.result,consumed:!!row.consumed_at,plan:plan?{uid:plan.uid,name:plan.name,pageId:plan.pageId,databaseId:plan.databaseId,dataSourceId:plan.dataSourceId,fields:plan.changes.map(c=>c.field),held:plan.held}:null};
  });
 }
 async approve(actor:TeamActor,id:string,input:{editingPaused:boolean}){
  if(!this.writeReady)throw new TeamError('PILOT_DISABLED');if(input.editingPaused!==true)throw new TeamError('FORBIDDEN',403);
  requireUuid(id);await actorTransaction(actor,async c=>{
   const conn=await lockConnection(c,actor.tenantId),row=(await c.query("SELECT * FROM team_pilot_runs WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND session_ref=$4 FOR UPDATE",[actor.tenantId,id,actor.userId,actor.sessionRef])).rows[0];
   if(!row)throw new TeamError('NOT_FOUND',404);if(row.status!=='prepared'||row.consumed_at)throw new TeamError('PILOT_CONSUMED');
   if(conn.id!==row.connection_id||conn.revision!==row.revision||new Date(row.expires_at).getTime()<=Date.now())throw new TeamError('PILOT_CHANGED');
   const plan=this.open(row)as PilotPlan;if(!plan.changes.length)throw new TeamError('NOT_READY');
   await c.query("UPDATE team_pilot_runs SET status='approved',updated_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,id]);
  });return this.get(actor,id);
 }
 async cancel(actor:TeamActor,id:string){
  requireUuid(id);await actorTransaction(actor,async c=>{const r=await c.query("UPDATE team_pilot_runs SET status='held',result=jsonb_build_object('reasonCode','USER_CANCELLED'),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND user_id=$3 AND session_ref=$4 AND status IN ('queued','preparing','prepared','approved','executing') AND consumed_at IS NULL",[actor.tenantId,id,actor.userId,actor.sessionRef]);if(!r.rowCount)throw new TeamError('PILOT_CONSUMED');});return this.get(actor,id);
 }
 /** Only the trusted worker calls this method. No web Docker or member mutation port. */
 async tick(){
  if(!this.ready||!this.provider.available)return false;const lease=randomUUID();
  const row=await transaction(async c=>{
   // Interrupted or uncertain writes are never replayed, even after process restart.
   await c.query("UPDATE team_pilot_runs SET status=CASE WHEN consumed_at IS NULL THEN 'held' ELSE 'uncertain' END,result=jsonb_build_object('reasonCode','LEASE_LOST'),lease_token=NULL,lease_until=NULL WHERE status IN ('preparing','executing','dispatching') AND lease_until<now()");
   const r=(await c.query("SELECT * FROM team_pilot_runs WHERE (status='queued' OR (status='approved' AND $1::boolean)) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",[this.writeEnabled])).rows[0];if(!r)return null;
   const mode=r.status==='queued'?'preparing':'executing';await c.query("UPDATE team_pilot_runs SET status=$2,lease_token=$3,lease_until=now()+interval '3 minutes',updated_at=now() WHERE id=$1",[r.id,mode,lease]);return{...r,mode};
  });if(!row)return false;
  const current=async()=>transaction(async c=>{
   const conn=await lockConnection(c,row.tenant_id),s=row.snapshot;
   const run=await c.query("SELECT 1 FROM team_pilot_runs WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND status IN ('preparing','executing','dispatching') AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()",[row.id,row.tenant_id,lease]);
   const auth=await c.query("SELECT b.* FROM team_sessions a JOIN team_users u ON u.id=a.user_id AND u.tenant_id=a.tenant_id JOIN team_tenants t ON t.id=u.tenant_id JOIN team_browser_sessions b ON b.tenant_id=t.id AND b.id=$5 WHERE a.token_hash=$1 AND a.user_id=$2 AND a.tenant_id=$3 AND a.auth_version=u.auth_version AND u.auth_version=$4 AND u.active AND t.active AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND b.owner_user_id=u.id AND b.auth_session_hash=a.token_hash AND b.status='verified' AND b.expires_at>clock_timestamp()",[row.session_ref,row.user_id,row.tenant_id,s.authVersion,s.sessionId]);
   if(!run.rowCount||!auth.rowCount||conn.id!==row.connection_id||conn.revision!==row.revision||conn.company_status!=='verified'||conn.notion_status!=='verified'||conn.secret_revision!==s.secretRevision||conn.active_session_id!==s.sessionId||JSON.stringify(conn.company_binding)!==JSON.stringify(s.binding)||JSON.stringify(conn.notion_destination)!==JSON.stringify(s.destination))throw new TeamError('PILOT_CHANGED');
   return{conn,session:auth.rows[0],token:await this.connections.tokenForRun(c,conn)};
  });
  await withAuditContext({runId:row.id,runKind:'preview',accountId:row.tenant_id},async()=>{
   try{
    const c=await current(),scope:TeamPreviewInput={tenantId:row.tenant_id,connectionId:row.connection_id,revision:row.revision,sessionId:c.session.id,handle:c.session.provider_handle,binding:row.snapshot.binding,destination:row.snapshot.destination,token:c.token,assertCurrent:async()=>{await current();}};
    if(row.mode==='preparing'){
     const plan=await this.provider.prepare(scope,this.open(row).uid);await current();
     const saved=await query("UPDATE team_pilot_runs SET status='prepared',envelope=$4::jsonb,lease_token=NULL,lease_until=NULL,expires_at=LEAST(expires_at,now()+interval '10 minutes'),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND status='preparing'",[row.id,row.tenant_id,lease,JSON.stringify(this.seal(row.tenant_id,row.id,row.revision,plan))]);if(saved.rowCount!==1)throw new TeamError('LEASE_LOST');
     await auditEvent({stage:'plan',outcome:'succeeded',provider:'local',operation:'transform',counts:{members:1,mapped:plan.changes.length,held:plan.held.length}});
    }else{
     let dispatched=false;
     const result=await this.provider.execute(scope,this.open(row),async()=>{
      if(dispatched)throw new TeamError('PILOT_CONSUMED');await current();
      // Connection lock serializes local changes through durable consumption. Notion UI has no CAS.
      await transaction(async c=>{const conn=await lockConnection(c,row.tenant_id);if(conn.revision!==row.revision)throw new TeamError('PILOT_CHANGED');const r=await c.query("UPDATE team_pilot_runs SET status='dispatching',consumed_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND status='executing' AND consumed_at IS NULL AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()",[row.id,row.tenant_id,lease]);if(r.rowCount!==1)throw new TeamError('PILOT_CONSUMED');});dispatched=true;
     });
     if(!dispatched)throw new TeamError('PILOT_CHANGED');
     const saved=await query("UPDATE team_pilot_runs SET status=$4,result=$5::jsonb,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND status='dispatching'",[row.id,row.tenant_id,lease,result.verified&&!result.uncertain?'verified':'uncertain',JSON.stringify(result)]);if(saved.rowCount!==1)throw new TeamError('LEASE_LOST');
     await auditEvent({stage:'readback',outcome:result.verified&&!result.uncertain?'succeeded':'uncertain',provider:'notion',operation:'reconcile',fields:result.fields.map(f=>f==='uid'?'companyUid':f),readbackMatch:result.verified});
    }
   }catch{
    await query("UPDATE team_pilot_runs SET status=CASE WHEN consumed_at IS NULL THEN 'held' ELSE 'uncertain' END,result=jsonb_build_object('reasonCode','PILOT_REVIEW_REQUIRED'),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND lease_token=$3",[row.id,row.tenant_id,lease]);
    await auditEvent({stage:'complete',outcome:'held',provider:'local',operation:'execute',reasonCode:'PILOT_REVIEW_REQUIRED'});
   }
  });return true;
 }
}
