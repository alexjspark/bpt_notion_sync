import{auditEvent,withAuditContext}from'./audit-log.ts';
import{randomUUID}from'node:crypto';
import{query,transaction,connectDb}from'@trainer/db';
import{activeBrowser,requestBrowserOperation,type BrowserScope}from'./team-browser-store.ts';
import type{BrowserDriver}from'./team-browser-driver.ts';
import{validateBinding,type CompanyBinding}from'./team-providers.ts';
import{TeamError}from'./team-errors.ts';
export interface BrowserAccountInspector{inspect(scope:BrowserScope):Promise<CompanyBinding>}
export class TeamBrowserRunner{
 constructor(private readonly driver:BrowserDriver,private readonly inspector:BrowserAccountInspector,private readonly actions:readonly ('allocate'|'probe'|'stop')[]=['allocate','probe','stop']){}
 async runOnce():Promise<boolean>{
  const lease=randomUUID();
  const op=await transaction(async c=>{
   await c.query("UPDATE team_browser_operations SET status='uncertain',lease_token=NULL,lease_until=NULL,reason_code='LEASE_LOST',available_at=now(),updated_at=now() WHERE status='running' AND lease_until<now()");
   const row=(await c.query("SELECT * FROM team_browser_operations WHERE status IN('queued','uncertain') AND available_at<=now() AND action=ANY($1::text[]) ORDER BY CASE action WHEN 'stop' THEN 0 WHEN 'allocate' THEN 1 ELSE 2 END,available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[this.actions])).rows[0];
   if(!row)return null;
   if(row.attempts>=4){await c.query("UPDATE team_browser_operations SET status='manual_review',reason_code='RUNNER_UNAVAILABLE',updated_at=now() WHERE id=$1",[row.id]);return{...row,manualReview:true};}
   await c.query("UPDATE team_browser_operations SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1",[row.id,lease]);return row;
  });
  if(!op)return false;if(op.manualReview)return true;const scope={tenantId:op.tenant_id,sessionId:op.session_id},lock=await connectDb();let locked=false;
  const finish=async(status:'succeeded'|'queued'|'uncertain'|'cancelled',reason:string|null=null)=>{const result=await query("UPDATE team_browser_operations SET status=$3::text,reason_code=$4::text,lease_token=NULL,lease_until=NULL,available_at=now()+interval '5 seconds',attempts=CASE WHEN $3::text='queued' AND ($4::text IS NULL OR $4::text='CLEANUP_PENDING') THEN GREATEST(0,attempts-1) ELSE attempts END,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()",[op.id,lease,status,reason]);await withAuditContext({runId:op.id,runKind:'preview',accountId:scope.tenantId,attempt:op.attempts+1},async()=>{await auditEvent({stage:'complete',outcome:status==='succeeded'?'succeeded':status==='uncertain'?'uncertain':'held',provider:'local',operation:'execute',reasonCode:reason??undefined});});return result;};
  try{
   locked=(await lock.query("SELECT pg_try_advisory_lock(hashtext('team-browser-runner'),hashtext($1)) AS ok",[scope.tenantId])).rows[0].ok;
   if(!locked){await finish('queued','CLEANUP_PENDING');return true;}
   // Outbox identity is server-owned; privileged driver is never called from an HTTP handler.
   if(op.action==='stop'){
    await this.driver.stop(scope);
    await query("UPDATE team_browser_allocations SET status='stopped',account_binding=NULL,account_observed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2",[scope.tenantId,scope.sessionId]);await finish('succeeded');return true;
   }
   const active=await activeBrowser(scope);
   if(!active){await requestBrowserOperation({query} as never,scope,'stop');await finish('cancelled','BROWSER_EXPIRED');return true;}
   if(op.action==='allocate'){
    const old=await query("SELECT 1 FROM team_browser_allocations WHERE tenant_id=$1 AND session_id<>$2 AND status<>'stopped'",[scope.tenantId,scope.sessionId]);
    if(old.rowCount){await finish('queued','CLEANUP_PENDING');return true;}
    await query("UPDATE team_browser_allocations SET status='starting',updated_at=now() WHERE tenant_id=$1 AND session_id=$2",[scope.tenantId,scope.sessionId]);
    // ensure always inspects exact owned resources first, including after an uncertain prior command.
    const result=await this.driver.ensure(scope);
    if(!await activeBrowser(scope)){await requestBrowserOperation({query} as never,scope,'stop');await finish('cancelled','BROWSER_EXPIRED');return true;}
    if(!result.ready){await finish('queued');return true;}
    await transaction(async c=>{
     const owned=await c.query("SELECT 1 FROM team_browser_operations WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",[op.id,lease]);if(!owned.rowCount){await requestBrowserOperation(c,scope,'stop');return;}
     const conn=await c.query('SELECT active_session_id FROM team_connections WHERE tenant_id=$1 FOR UPDATE',[scope.tenantId]);
     if(conn.rows[0]?.active_session_id!==scope.sessionId){await requestBrowserOperation(c,scope,'stop');return;}
     const updated=await c.query("UPDATE team_browser_sessions SET status='login_required' WHERE tenant_id=$1 AND id=$2 AND status IN('starting','queued') AND expires_at>now()",[scope.tenantId,scope.sessionId]);
     if(updated.rowCount)await c.query("UPDATE team_browser_allocations SET status='ready',updated_at=now() WHERE tenant_id=$1 AND session_id=$2",[scope.tenantId,scope.sessionId]);else await requestBrowserOperation(c,scope,'stop');
    });await finish('succeeded');return true;
   }
   const allocation=(await query("SELECT 1 FROM team_browser_allocations WHERE tenant_id=$1 AND session_id=$2 AND status='ready'",[scope.tenantId,scope.sessionId])).rowCount;
   if(!allocation)throw new TeamError('NOT_READY');
   const binding=validateBinding(await this.inspector.inspect(scope));
   if(!await activeBrowser(scope)){await finish('cancelled','BROWSER_EXPIRED');return true;}
   if(active.expected_company_binding&&JSON.stringify(active.expected_company_binding)!==JSON.stringify(binding))throw new TeamError('ACCOUNT_CHANGED');
   await query("UPDATE team_browser_allocations SET account_binding=$3::jsonb,account_observed_at=now(),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND status='ready'",[scope.tenantId,scope.sessionId,JSON.stringify(binding)]);await finish('succeeded');
  }catch(e){
   const code=e instanceof TeamError?e.code:'ACCOUNT_UNVERIFIED';
   if(op.action==='probe'){await query("UPDATE team_browser_allocations SET account_binding=NULL,account_observed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2",[scope.tenantId,scope.sessionId]);await finish('succeeded',code);return true;}
   await query("UPDATE team_browser_allocations SET status=CASE WHEN $3='RUNNER_SCOPE_INVALID' THEN 'failed' WHEN $3='ACCOUNT_CHANGED' THEN status ELSE 'uncertain' END,account_binding=NULL,account_observed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2",[scope.tenantId,scope.sessionId,code]);
   await finish('uncertain',code);
  }finally{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('team-browser-runner'),hashtext($1))",[scope.tenantId]);lock.release();}
  return true;
 }
}
