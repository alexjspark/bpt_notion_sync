import{query}from'@trainer/db';import{TeamError}from'./team-errors.ts';
import{sweepExpiredBrowsers}from'./team-browser-store.ts';
import type{TeamPreviewQueue}from'./team-preview.ts';import type{TeamBrowserRunner}from'./team-browser-runner.ts';
export type RuntimeRole='runner'|'worker'|'gateway'|'egress';
export async function runtimeHeartbeat(role:RuntimeRole,ready:boolean){
 await query('INSERT INTO team_runtime_health(role,ready,heartbeat_at) VALUES($1,$2,now()) ON CONFLICT(role) DO UPDATE SET ready=EXCLUDED.ready,heartbeat_at=now()',[role,ready]);
}
export async function runtimeReady(roles:readonly RuntimeRole[]):Promise<boolean>{
 if(!roles.length)return false;const r=await query("SELECT role FROM team_runtime_health WHERE role=ANY($1::text[]) AND ready AND heartbeat_at>now()-interval '15 seconds'",[roles]);return r.rowCount===new Set(roles).size;
}
export class DispatchedPreviewProvider{
 readonly available=true;ready=()=>runtimeReady(['worker']);
 async preview():Promise<never>{throw new TeamError('PROVIDER_UNAVAILABLE');}
}
/** No client tenant parameter. Runs only DB-discovered queue ownership, using a separate phase-2 read-only queue. */
export class TeamWorkerDispatcher{
 constructor(private readonly queue:TeamPreviewQueue,private readonly probes:TeamBrowserRunner){}
 async tick():Promise<{expired:number;probes:number;previews:number}>{
  const expired=await sweepExpiredBrowsers();let probes=0,previews=0;
  for(let i=0;i<8;i++){if(!await this.probes.runOnce())break;probes++;}
  await runtimeHeartbeat('worker',this.queue.providerReady);
  if(this.queue.providerReady){
   const rows=(await query("SELECT tenant_id FROM team_preview_runs WHERE status='queued' GROUP BY tenant_id ORDER BY min(created_at) LIMIT 4")).rows;
   const results=await Promise.allSettled(rows.map(row=>this.queue.runNext(row.tenant_id)));
   previews=results.filter(r=>r.status==='fulfilled'&&r.value).length;
  }return{expired,probes,previews};
 }
}
