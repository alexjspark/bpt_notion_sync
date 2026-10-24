import{existsSync}from'node:fs';
import{query,closeDb}from'../../packages/db/src/index.ts';
import{TeamError}from'../../packages/engine/src/team-errors.ts';
import{runtimeHeartbeat,type RuntimeRole}from'../../packages/engine/src/team-worker-dispatch.ts';
export function approvedRuntime(){
 if(process.env.PHASE2_ENABLED!=='true'||process.env.TEAM_RUNTIME_APPROVED!=='true')throw new TeamError('RUNNER_UNAVAILABLE');
}
export async function requireRuntimeSchema(){if(!(await query("SELECT 1 FROM schema_migrations WHERE version='012_team_browser_runtime'")).rowCount)throw new TeamError('NOT_READY');}
export function envKey(name:string):Buffer{const value=process.env[name];if(!value||!/^[a-fA-F0-9]{64}$/.test(value))throw new TeamError('VAULT_UNCONFIGURED');return Buffer.from(value,'hex');}
export async function runLoop(role:RuntimeRole,tick:()=>Promise<unknown>){
 approvedRuntime();await requireRuntimeSchema();let stop=false;const end=()=>{stop=true;};process.once('SIGTERM',end);process.once('SIGINT',end);
 const heartbeat=setInterval(()=>{void runtimeHeartbeat(role,!stop).catch(()=>{stop=true;});},5000);heartbeat.unref();
 try{await runtimeHeartbeat(role,true);while(!stop){await tick();if(!stop)await new Promise(r=>setTimeout(r,500));}}
 finally{clearInterval(heartbeat);await runtimeHeartbeat(role,false);await closeDb();}
}
export async function listenService(role:'gateway'|'egress',service:{server:import('node:http').Server;closeConnections:()=>void},port:number){
 approvedRuntime();if(process.platform!=='linux'||!existsSync('/.dockerenv'))throw new TeamError('RUNNER_SCOPE_INVALID');await requireRuntimeSchema();await new Promise<void>(resolve=>service.server.listen(port,'0.0.0.0',resolve));
 await runtimeHeartbeat(role,true);const heartbeat=setInterval(()=>{void runtimeHeartbeat(role,true).catch(()=>service.closeConnections());},5000);heartbeat.unref();
 const stop=async()=>{clearInterval(heartbeat);service.closeConnections();service.server.close();await runtimeHeartbeat(role,false);await closeDb();};
 process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
}
