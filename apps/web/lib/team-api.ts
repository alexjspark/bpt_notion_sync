import {TeamPilot} from '../../../packages/engine/src/team-pilot.ts';
import {UnconfiguredPilotProvider} from '../../../packages/engine/src/team-pilot-provider.ts';
import {teamKeyPair} from '../../../packages/engine/src/team-key-loader.ts';
import {TeamInvites} from '../../../packages/engine/src/team-invites.ts';
import{DispatchedPreviewProvider}from'../../../packages/engine/src/team-worker-dispatch.ts';
import {QueuedCompanySessionProvider}from'../../../packages/engine/src/team-browser-store.ts';
import{readTeamCookie,TEAM_COOKIE}from'../../../packages/engine/src/team-session-cookie.ts';
import { TeamAuth } from '../../../packages/engine/src/team-auth.ts';
import { TeamConnections } from '../../../packages/engine/src/team-connections.ts';
import { TeamPreviewQueue } from '../../../packages/engine/src/team-preview.ts';
import { TeamVault } from '../../../packages/engine/src/team-vault.ts';
import { TeamError } from '../../../packages/engine/src/team-errors.ts';
import { UnconfiguredCompanyProvider,UnconfiguredPreviewProvider,OfficialTeamNotionValidator } from '../../../packages/engine/src/team-providers.ts';
export{TEAM_COOKIE};
export function phase2Enabled(){return process.env.PHASE2_ENABLED==='true';}
export { phase2Boundary } from './team-boundary.ts';
function cookie(req:Request){return readTeamCookie(req.headers.get('cookie'));}
export interface TeamServices{auth:TeamAuth;connections:TeamConnections;queue:TeamPreviewQueue;pilot?:TeamPilot}
let services:TeamServices|undefined;
export function productionTeamServices():TeamServices{
 if(!services){
  const {master}=teamKeyPair();
  const vault=new TeamVault(master),company=process.env.TEAM_BROWSER_RUNTIME_ENABLED==='true'?new QueuedCompanySessionProvider(undefined,5000,process.env.TEAM_BROWSER_ROUTE_CONFIGURED==='true'):new UnconfiguredCompanyProvider();
  const notion=new OfficialTeamNotionValidator(async r=>{
   // This transport is not called unless a user explicitly submits a connection while an operator-configured vault is ready.
   const response=await fetch(r.url,{method:r.method,headers:r.headers as Record<string,string>,body:r.body?JSON.stringify(r.body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
   return{status:response.status,body:await response.json()};
  },process.env.TEAM_PILOT_ENABLED==='true');
  const connections=new TeamConnections(vault,company,notion);
  services={auth:new TeamAuth(),connections,pilot:new TeamPilot(connections,new UnconfiguredPilotProvider(),process.env.TEAM_PILOT_ENABLED==='true',process.env.TEAM_PILOT_WRITE_APPROVED==='true'),queue:new TeamPreviewQueue(connections,process.env.TEAM_PREVIEW_RUNTIME_ENABLED==='true'?new DispatchedPreviewProvider():new UnconfiguredPreviewProvider())};
 }return services;
}
const json=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))throw new TeamError('INVALID_INPUT',400);}
async function body(req:Request):Promise<Record<string,unknown>>{
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new TeamError('INVALID_INPUT',400);
 if(Number(req.headers.get('content-length')??0)>8192)throw new TeamError('INVALID_INPUT',413);
 const reader=req.body?.getReader();if(!reader)throw new TeamError('INVALID_INPUT',400);const chunks:Uint8Array[]=[];let size=0;for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192){await reader.cancel();throw new TeamError('INVALID_INPUT',413);}chunks.push(r.value);}const text=Buffer.concat(chunks).toString('utf8');
 try{const v=JSON.parse(text);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw new TeamError('INVALID_INPUT',400);}
}
export async function handleTeamRequest(req:Request,path:string[],deps?:TeamServices,enabled=phase2Enabled()):Promise<Response>{
 if(!enabled)return json({code:'DISABLED'},404);
 try{
  const url=new URL(req.url),origin=process.env.TEAM_PUBLIC_ORIGIN??'http://127.0.0.1:4310';
  // User-supplied tenant, host, credential URL, revision query parameters never determine authority.
  if(url.search)throw new TeamError('INVALID_INPUT',400);
  if(!['GET','POST'].includes(req.method))throw new TeamError('INVALID_INPUT',405);
  if(req.method==='POST'&&req.headers.get('origin')!==origin)throw new TeamError('FORBIDDEN',403);
  const secure=new URL(origin).protocol==='https:';
  if(!secure&&!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw new TeamError('FORBIDDEN',403);
  const s=deps??productionTeamServices(),route=path.join('/'),token=cookie(req);
  if(route==='invite/accept'&&req.method==='POST'){const b=await body(req);exact(b,['token','email','password']);return json(await new TeamInvites().accept(b as never));}
  if(route==='login'&&req.method==='POST'){
   const b=await body(req);exact(b,['login','password']);const result=await s.auth.login(b.login,b.password);
   return json({authenticated:true,expiresAt:result.expiresAt},200,{'Set-Cookie':TEAM_COOKIE+'='+result.token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800'+(secure?'; Secure':'')});
  }
  if(route==='logout'&&req.method==='POST'){await s.auth.logout(token);return json({authenticated:false},200,{'Set-Cookie':TEAM_COOKIE+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+(secure?'; Secure':'')});}
  const actor=await s.auth.resolve(token);
  if(route==='invites'&&req.method==='POST'){const b=await body(req);exact(b,['email','login','label']);return json(await new TeamInvites().issue(actor,b as never));}
  if(path.length===3&&path[0]==='invites'&&path[2]==='revoke'&&req.method==='POST'){const b=await body(req);exact(b,[]);return json(await new TeamInvites().revoke(actor,path[1]));}
  if(route==='connections'&&req.method==='GET')return json({...await s.connections.status(actor),previewProviderReady:await s.queue.isReady(),pilotReady:s.pilot?.ready??false,pilotWriteReady:s.pilot?.writeReady??false,canInvite:await new TeamInvites().canIssue(actor)});
  if(route==='connections/notion'&&req.method==='POST'){
   if(!s.connections.vault.ready)throw new TeamError('VAULT_UNCONFIGURED');
   const b=await body(req);exact(b,['revision','token','destination']);return json(await s.connections.connectNotion(actor,b as never));
  }
  if(route==='connections/notion/disconnect'&&req.method==='POST'){const b=await body(req);exact(b,['revision']);return json(await s.connections.disconnectNotion(actor,b.revision as number));}
  if(route==='company/start'&&req.method==='POST'){const b=await body(req);exact(b,['revision']);return json(await s.connections.beginCompany(actor,b.revision as number));}
  if((route==='company/confirm'||route==='company/revoke')&&req.method==='POST'){
   const b=await body(req);exact(b,['revision','sessionId']);
   return json(await (route.endsWith('confirm')?s.connections.confirmCompany(actor,b.sessionId as string,b.revision as number):s.connections.revokeCompany(actor,b.sessionId as string,b.revision as number)));
  }
  if(path[0]==='pilot'){
   if(!s.pilot)throw new TeamError('PILOT_DISABLED');
   if(route==='pilot/prepare'&&req.method==='POST'){const b=await body(req);exact(b,['previewId','uid','requestId']);return json(await s.pilot.prepare(actor,b as never),202);}
   if(path.length===2&&req.method==='GET')return json(await s.pilot.get(actor,path[1]));
   if(path.length===3&&path[2]==='approve'&&req.method==='POST'){const b=await body(req);exact(b,['editingPaused']);return json(await s.pilot.approve(actor,path[1],b as never),202);}
   if(path.length===3&&path[2]==='cancel'&&req.method==='POST'){const b=await body(req);exact(b,[]);return json(await s.pilot.cancel(actor,path[1]));}
  }
  if(route==='preview'&&req.method==='POST'){const b=await body(req);exact(b,['requestId']);return json(await s.queue.enqueue(actor,b.requestId as string),202);}
  if(path.length===2&&path[0]==='runs'&&req.method==='GET')return json(await s.queue.get(actor,path[1]));
  if(path.length===3&&path[0]==='runs'&&path[2]==='cancel'&&req.method==='POST'){const b=await body(req);exact(b,[]);return json(await s.queue.cancel(actor,path[1]));}
  if(path.length===3&&path[0]==='runs'&&path[2]==='logs'&&req.method==='GET')return json({events:await s.queue.logs(actor,path[1])});
  throw new TeamError('NOT_FOUND',404);
 }catch(e){const error=e instanceof TeamError?e:new TeamError('PREVIEW_FAILED',500);return json({code:error.code},error.status);}
}
