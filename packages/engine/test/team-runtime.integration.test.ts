import{test,before,beforeEach,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{migrate,query,closeDb}from'@trainer/db';import{closeAuditLog}from'../src/audit-log.ts';
import{TeamAuth,provisionTeamUser,type TeamActor}from'../src/team-auth.ts';import{TeamVault}from'../src/team-vault.ts';import{TeamConnections}from'../src/team-connections.ts';
import{QueuedCompanySessionProvider,activeBrowser,browserAuthority,sweepExpiredBrowsers,requestBrowserOperation,type BrowserScope}from'../src/team-browser-store.ts';
import{TeamBrowserRunner}from'../src/team-browser-runner.ts';import{TeamPreviewQueue}from'../src/team-preview.ts';import{TeamWorkerDispatcher,runtimeHeartbeat}from'../src/team-worker-dispatch.ts';
import{TeamOwnedBrowser}from'../src/team-owned-browser.ts';import{TeamError}from'../src/team-errors.ts';import type{CompanyBinding}from'../src/team-providers.ts';
const password='SYNTHETIC_RUNTIME_PASSWORD';let auth:TeamAuth,a:TeamActor,b:TeamActor,tokenA:string,connections:TeamConnections,runner:TeamBrowserRunner,probes:TeamBrowserRunner,queue:TeamPreviewQueue;
let ensures:BrowserScope[],stops:BrowserScope[],calls:string[],ensureHook:(()=>Promise<void>)|undefined,previewHook:(()=>Promise<void>)|undefined,failStop:boolean,identityChanged:boolean;
const dest=(x:string)=>({databaseId:x+'1111111-1111-4111-8111-111111111111',dataSourceId:x+'2222222-2222-4222-8222-222222222222',templateId:x+'3333333-3333-4333-8333-333333333333'});
const inspect=async(s:BrowserScope):Promise<CompanyBinding>=>({accountId:identityChanged?'different-account':'synthetic-'+s.tenantId,trainerId:'synthetic-trainer'});
async function start(actor=a){const s=await connections.status(actor);return connections.beginCompany(actor,s.revision);}
async function ready(actor=a){const s=await start(actor);await runner.runOnce();const current=await connections.status(actor);await connections.confirmCompany(actor,s.session!.id,current.revision);const latest=await connections.status(actor);await connections.connectNotion(actor,{revision:latest.revision,token:'SYNTHETIC_TOKEN_'+actor.tenantId,destination:dest(actor===a?'a':'b')});return connections.status(actor);}
before(async()=>{const u=process.env.TEST_DATABASE_URL;if(!u||!new URL(u).pathname.endsWith('_test'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');process.env.DATABASE_URL=u;await migrate();});
after(async()=>{await closeAuditLog();await closeDb();});
beforeEach(async()=>{
 await query('TRUNCATE team_tenants CASCADE');await query('DELETE FROM team_login_attempts');await query('DELETE FROM team_runtime_health');
 for(const r of['runner','worker','gateway','egress']as const)await runtimeHeartbeat(r,true);
 auth=new TeamAuth();await provisionTeamUser({login:'runtime-a',password,label:'SYNTHETIC A'});await provisionTeamUser({login:'runtime-b',password,label:'SYNTHETIC B'});
 const sa=await auth.login('runtime-a',password),sb=await auth.login('runtime-b',password);tokenA=sa.token;a=await auth.resolve(sa.token);b=await auth.resolve(sb.token);
 ensures=[];stops=[];calls=[];ensureHook=previewHook=undefined;failStop=false;identityChanged=false;
 const company=new QueuedCompanySessionProvider(inspect,1000);connections=new TeamConnections(new TeamVault(Buffer.alloc(32,4)),company,{validate:async()=>{}});
 const driver={ensure:async(s:BrowserScope)=>{ensures.push(s);if(ensureHook)await ensureHook();return{ready:true};},stop:async(s:BrowserScope)=>{stops.push(s);if(failStop){failStop=false;throw new TeamError('RUNNER_UNAVAILABLE');}}};
 runner=new TeamBrowserRunner(driver,{inspect},['allocate','stop']);probes=new TeamBrowserRunner({ensure:async()=>{throw Error('NO_DOCKER_IN_WORKER');},stop:async()=>{throw Error('NO_DOCKER_IN_WORKER');}},{inspect},['probe']);
 queue=new TeamPreviewQueue(connections,{available:true,preview:async input=>{calls.push(input.tenantId);assert.equal(input.token,'SYNTHETIC_TOKEN_'+input.tenantId);if(previewHook)await previewHook();await input.assertCurrent();return{members:1,matched:1,held:0,creates:0,updates:0};}});
});
test('web allocation is outbox only; runner and owned gateway authority bind exact A/B session',async()=>{
 const sa=await start(a),sb=await start(b);assert.equal(ensures.length,0);assert.equal(sa.session!.status,'queued');
 await runner.runOnce();await runner.runOnce();assert.equal(ensures.length,2);
 const aa=await browserAuthority(a,sa.session!.id);assert.equal(aa.tenantId,a.tenantId);await assert.rejects(browserAuthority(b,sa.session!.id),{code:'NOT_FOUND'});
 await assert.rejects(requestBrowserOperation({query}as never,{tenantId:a.tenantId,sessionId:sb.session!.id},'stop'),{code:'23503'});
});
test('allocation cancelled during driver call is not resurrected and late resource is cleaned',async()=>{
 const s=await start();ensureHook=async()=>{const current=await connections.status(a);await connections.revokeCompany(a,s.session!.id,current.revision);};
 await runner.runOnce();assert.equal(await activeBrowser({tenantId:a.tenantId,sessionId:s.session!.id}),null);assert.equal((await connections.status(a)).session,null);
 await runner.runOnce();assert.equal(stops.length,1);assert.equal(stops[0]!.sessionId,s.session!.id);
 assert.equal((await query('SELECT status FROM team_browser_allocations WHERE tenant_id=$1',[a.tenantId])).rows[0].status,'stopped');
});
test('expiry detaches pointer, holds queue, schedules cleanup and allows own relogin',async()=>{
 const s=await ready();const run=await queue.enqueue(a,randomUUID());
 await query("UPDATE team_browser_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[a.tenantId]);assert.equal(await sweepExpiredBrowsers(),1);
 assert.equal((await connections.status(a)).session,null);assert.equal((await queue.get(a,run.id)).status,'held');await assert.rejects(browserAuthority(a,s.session!.id),{code:'NOT_FOUND'});
 await runner.runOnce();const next=await start();assert.notEqual(next.session!.id,s.session!.id);assert.equal((await queue.get(a,run.id)).status,'held');
});
test('failed cleanup is reconciled on the same target; retry bounded and profile not reallocated',async()=>{
 const s=await start();await runner.runOnce();const status=await connections.status(a);await connections.revokeCompany(a,s.session!.id,status.revision);failStop=true;await runner.runOnce();
 assert.equal((await query("SELECT status FROM team_browser_operations WHERE action='stop'")).rows[0].status,'uncertain');
 await query("UPDATE team_browser_operations SET available_at=now() WHERE action='stop'");await runner.runOnce();assert.equal(stops.length,2);assert.deepEqual(stops[0],stops[1]);assert.equal(ensures.length,1);
 assert.equal((await query("SELECT status FROM team_browser_operations WHERE action='stop'")).rows[0].status,'succeeded');
});
test('relogin cannot silently replace established company identity; old approval remains unusable',async()=>{
 const s=await ready();await connections.revokeCompany(a,s.session!.id,s.revision);await runner.runOnce();const next=await start();await runner.runOnce();identityChanged=true;
 const current=await connections.status(a);await assert.rejects(connections.confirmCompany(a,next.session!.id,current.revision),{code:'ACCOUNT_CHANGED'});assert.equal((await connections.status(a)).companyStatus,'login_required');
});
test('worker dispatcher discovers only queued owners; A/B credentials and cancellation stay isolated',async()=>{
 await ready(a);await ready(b);const ra=await queue.enqueue(a,randomUUID()),rb=await queue.enqueue(b,randomUUID());
 await assert.rejects(queue.cancel(a,rb.id),{code:'NOT_FOUND'});const dispatcher=new TeamWorkerDispatcher(queue,probes),r=await dispatcher.tick();assert.equal(r.previews,2);
 assert.deepEqual(new Set(calls),new Set([a.tenantId,b.tenantId]));assert.equal((await queue.get(a,ra.id)).status,'succeeded');assert.equal((await queue.get(b,rb.id)).status,'succeeded');
 const next=await queue.enqueue(a,randomUUID());previewHook=async()=>{await queue.cancel(a,next.id);};await queue.runNext(a.tenantId);assert.equal((await queue.get(a,next.id)).reasonCode,'USER_CANCELLED');assert.equal((await queue.get(a,next.id)).result,null);
});
test('logout cancels actor and queued/running authority, including same branded actor object',async()=>{
 await ready();const run=await queue.enqueue(a,randomUUID());previewHook=async()=>auth.logout(tokenA);await queue.runNext(a.tenantId);
 await assert.rejects(connections.status(a),{code:'AUTH_REQUIRED'});const row=(await query('SELECT status,result FROM team_preview_runs WHERE tenant_id=$1 AND id=$2',[a.tenantId,run.id])).rows[0];assert.equal(row.status,'held');assert.equal(row.result,null);
 assert.equal((await query('SELECT active_session_id FROM team_connections WHERE tenant_id=$1',[a.tenantId])).rows[0].active_session_id,null);
});
test('unconfigured heartbeat blocks allocate; owned page factory derives endpoint and refuses other tenant',async()=>{
 await query("UPDATE team_runtime_health SET ready=false WHERE role='runner'");await assert.rejects(start(),{code:'PROVIDER_UNAVAILABLE'});assert.equal(ensures.length,0);await runtimeHeartbeat('runner',true);
 const s=await start();await runner.runOnce();let endpoint='';const browser=new TeamOwnedBrowser(async value=>{endpoint=value;return{page:{}as never,release:async()=>{}};});
 const lease=await browser.open({tenantId:a.tenantId,sessionId:s.session!.id});await lease.release();assert.equal(endpoint,'http://ts-team-browser-'+s.session!.id.replaceAll('-','')+':9222');
 await assert.rejects(browser.open({tenantId:b.tenantId,sessionId:s.session!.id}),{code:'NOT_READY'});
});
test('web confirm probe is executed by unprivileged worker consumer, not inline Docker',async()=>{
 const s=await start();await runner.runOnce();const webConnections=new TeamConnections(connections.vault,new QueuedCompanySessionProvider(undefined,1500),{validate:async()=>{}}),current=await webConnections.status(a);
 const confirmation=webConnections.confirmCompany(a,s.session!.id,current.revision);
 for(let i=0;i<100;i++){if((await query("SELECT 1 FROM team_browser_operations WHERE action='probe'")).rowCount)break;await new Promise(r=>setTimeout(r,10));}
 await probes.runOnce();const result=await confirmation;assert.equal(result.companyStatus,'verified');assert.equal(ensures.length,1);
});

test('cleanup retry budget ends in manual review without a fifth stop attempt',async()=>{
 const s=await start();await runner.runOnce();const current=await connections.status(a);await connections.revokeCompany(a,s.session!.id,current.revision);
 for(let i=0;i<4;i++){failStop=true;await query("UPDATE team_browser_operations SET available_at=now() WHERE action='stop'");await runner.runOnce();}
 await query("UPDATE team_browser_operations SET available_at=now() WHERE action='stop'");await runner.runOnce();assert.equal(stops.length,4);assert.equal((await query("SELECT status FROM team_browser_operations WHERE action='stop'")).rows[0].status,'manual_review');
});
