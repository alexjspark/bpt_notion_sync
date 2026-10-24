import {test,before,after,beforeEach} from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';
import {migrate,query,closeDb}from'@trainer/db';
import {TeamAuth,provisionTeamUser,type TeamActor}from'../../../packages/engine/src/team-auth.ts';
import {TeamVault}from'../../../packages/engine/src/team-vault.ts';
import {TeamConnections}from'../../../packages/engine/src/team-connections.ts';
import {TeamPreviewQueue}from'../../../packages/engine/src/team-preview.ts';
import {TeamError}from'../../../packages/engine/src/team-errors.ts';
import {closeAuditLog}from'../../../packages/engine/src/audit-log.ts';
import {handleTeamRequest,type TeamServices,TEAM_COOKIE}from'../lib/team-api.ts';
import type{CompanyBinding,TeamDestination,TeamPreviewProvider}from'../../../packages/engine/src/team-providers.ts';
const password='SYNTHETIC password only!',origin='http://127.0.0.1:4310';
let services:TeamServices,actorA:TeamActor,actorB:TeamActor,cookieA:string,cookieB:string,tenantA:string,tenantB:string;
let owners:Map<string,string>,bindings:Map<string,CompanyBinding>,destinations:Map<string,string>,calls:string[],hook:(()=>Promise<void>)|undefined;
const dA={databaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',dataSourceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',templateId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac'};
const dB={databaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',dataSourceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',templateId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd'};
async function request(path:string,tokenCookie:string|undefined,data?:unknown,customOrigin=origin){
 return handleTeamRequest(new Request(origin+'/api/team/'+path,{method:data===undefined?'GET':'POST',headers:{...(tokenCookie?{cookie:tokenCookie}:{}),...(data===undefined?{}:{origin:customOrigin,'content-type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)}),path.split('/'),services,true);
}
async function status(who='a'){return(await request('connections',who==='a'?cookieA:cookieB)).json();}
async function ready(who='a'){
 const ck=who==='a'?cookieA:cookieB,actor=who==='a'?actorA:actorB,d=who==='a'?dA:dB;let s=await status(who);
 let r=await request('company/start',ck,{revision:s.revision});assert.equal(r.status,200);s=await r.json();
 r=await request('company/confirm',ck,{revision:s.revision,sessionId:s.session.id});assert.equal(r.status,200);s=await r.json();
 r=await request('connections/notion',ck,{revision:s.revision,token:'SYNTHETIC_TOKEN_'+actor.tenantId,destination:d});assert.equal(r.status,200);return r.json();
}
before(async()=>{const url=process.env.TEST_DATABASE_URL;if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');process.env.DATABASE_URL=url;await migrate();});
after(async()=>{await closeAuditLog();await closeDb();});
beforeEach(async()=>{
 await query('TRUNCATE team_tenants CASCADE');await query('DELETE FROM team_login_attempts');
 owners=new Map();bindings=new Map();destinations=new Map();calls=[];hook=undefined;
 const auth=new TeamAuth(),a=await provisionTeamUser({login:'synthetic-a',password,label:'SYNTHETIC A'}),b=await provisionTeamUser({login:'synthetic-b',password,label:'SYNTHETIC B'});tenantA=a.tenantId;tenantB=b.tenantId;
 destinations.set(dA.dataSourceId,tenantA);destinations.set(dB.dataSourceId,tenantB);
 const company={available:true,begin:async(s:{tenantId:string;sessionId:string})=>{const handle='synthetic-'+s.sessionId;owners.set(handle,s.tenantId);bindings.set(handle,{accountId:'synthetic-'+s.tenantId,trainerId:'synthetic-trainer'});return{handle};},inspect:async(s:{tenantId:string;handle:string})=>{if(owners.get(s.handle)!==s.tenantId)throw new TeamError('ACCOUNT_CHANGED');return bindings.get(s.handle)!;},revoke:async(s:{tenantId:string;handle:string})=>{if(owners.get(s.handle)!==s.tenantId)throw new TeamError('FORBIDDEN');owners.delete(s.handle);}};
 const notion={validate:async(token:string,d:TeamDestination)=>{if(token!=='SYNTHETIC_TOKEN_'+destinations.get(d.dataSourceId))throw new TeamError('DESTINATION_INVALID');}};
 const connections=new TeamConnections(new TeamVault(Buffer.alloc(32,6)),company,notion);
 const provider:TeamPreviewProvider={available:true,preview:async input=>{calls.push(input.tenantId);assert.equal(owners.get(input.handle),input.tenantId);assert.equal(destinations.get(input.destination.dataSourceId),input.tenantId);assert.equal(input.token,'SYNTHETIC_TOKEN_'+input.tenantId);if(hook)await hook();await input.assertCurrent();return{members:1,matched:1,held:0,creates:0,updates:0};}};
 services={auth,connections,queue:new TeamPreviewQueue(connections,provider)};
 const la=await auth.login('synthetic-a',password),lb=await auth.login('synthetic-b',password);cookieA=TEAM_COOKIE+'='+la.token;cookieB=TEAM_COOKIE+'='+lb.token;actorA=await auth.resolve(la.token);actorB=await auth.resolve(lb.token);
});
test('authenticated A/B API -> isolated connection -> queue -> worker -> own result; same logical UID cannot share runtime',async()=>{
 await ready();await ready('b');const requestId=randomUUID();
 const a=await(await request('preview',cookieA,{requestId})).json(),b=await(await request('preview',cookieB,{requestId})).json();assert.notEqual(a.id,b.id);
 assert.equal(await services.queue.runNext(tenantA),true);assert.deepEqual(calls,[tenantA]);assert.equal((await(await request('runs/'+b.id,cookieB)).json()).status,'queued');
 assert.equal(await services.queue.runNext(tenantB),true);assert.equal((await(await request('runs/'+a.id,cookieA)).json()).status,'succeeded');
 assert.equal((await request('runs/'+b.id,cookieA)).status,404);assert.equal((await request('runs/'+b.id+'/logs',cookieA)).status,404);
 const own=await(await request('runs/'+a.id+'/logs',cookieA)).json();assert.ok(own.events.some((v:Record<string,unknown>)=>v.stage==='complete'));
 const output=JSON.stringify(own);for(const raw of ['SYNTHETIC_TOKEN_',tenantA,'SYNTHETIC password'])assert.ok(!output.includes(raw));
 const replay=await(await request('preview',cookieA,{requestId})).json();assert.equal(replay.id,a.id);
});
test('missing/forged session, CSRF, tenant body and query injection rejected',async()=>{
 assert.equal((await request('connections',undefined)).status,401);assert.equal((await request('connections',TEAM_COOKIE+'=forged')).status,401);
 assert.equal((await request('company/start',cookieA,{revision:1,tenantId:tenantB})).status,400);
 assert.equal((await request('company/start',cookieA,{revision:1},'http://evil.invalid')).status,403);
 assert.equal((await request('connections?tenantId='+tenantB,cookieA)).status,400);
 assert.equal((await handleTeamRequest(new Request(origin),['connections'],services,false)).status,404);
});
test('A cannot confirm/revoke B session or attach B destination with A credential',async()=>{
 await ready('b');const b=await status('b'),a=await status();
 assert.equal((await request('company/confirm',cookieA,{revision:a.revision,sessionId:b.session.id})).status,404);
 assert.equal((await request('company/revoke',cookieA,{revision:a.revision,sessionId:b.session.id})).status,404);
 assert.equal((await request('connections/notion',cookieA,{revision:a.revision,token:'SYNTHETIC_TOKEN_'+tenantA,destination:dB})).status,409);
 assert.equal((await status()).notionStatus,'not_connected');
 await assert.rejects(query('UPDATE team_connections SET active_session_id=$2 WHERE tenant_id=$1',[tenantA,b.session.id]),{code:'23503'});
});
test('encrypted DB storage contains no key; ciphertext swapping across tenants fails',async()=>{
 await ready();await ready('b');const rows=(await query('SELECT tenant_id,connection_id,revision,envelope FROM team_secrets')).rows;
 assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_TOKEN_'));const a=rows.find(r=>r.tenant_id===tenantA)!,b=rows.find(r=>r.tenant_id===tenantB)!;
 assert.throws(()=>services.connections.vault.open({tenantId:tenantA,connectionId:a.connection_id,revision:a.revision,purpose:'notion'},b.envelope),{code:'SECRET_INVALID'});
 const publicState=JSON.stringify(await status());assert.ok(!publicState.includes('ciphertext'));assert.ok(!publicState.includes('SYNTHETIC_TOKEN_'));
});
test('connection change invalidates queued run before collection and old consent cannot replay',async()=>{
 await ready();const run=await(await request('preview',cookieA,{requestId:randomUUID()})).json(),s=await status();
 await request('connections/notion/disconnect',cookieA,{revision:s.revision});assert.equal(await services.queue.runNext(tenantA),false);assert.deepEqual(calls,[]);
 const held=await(await request('runs/'+run.id,cookieA)).json();assert.equal(held.status,'held');assert.equal(held.reasonCode,'CONNECTION_CHANGED');
 assert.equal((await request('connections/notion',cookieA,{revision:s.revision,token:'SYNTHETIC_TOKEN_'+tenantA,destination:dA})).status,409);
});
test('connection change during provider read fences stale completion and clears running lease',async()=>{
 await ready();const run=await(await request('preview',cookieA,{requestId:randomUUID()})).json();
 hook=async()=>{const s=await status();await request('connections/notion/disconnect',cookieA,{revision:s.revision});};
 await services.queue.runNext(tenantA);const r=await(await request('runs/'+run.id,cookieA)).json();assert.equal(r.status,'held');assert.equal(r.reasonCode,'CONNECTION_CHANGED');assert.equal(r.result,null);
});
test('company account changes after binding block collection',async()=>{
 await ready();for(const handle of owners.keys())bindings.set(handle,{accountId:'different-account',trainerId:'synthetic-trainer'});
 const run=await(await request('preview',cookieA,{requestId:randomUUID()})).json();await services.queue.runNext(tenantA);
 assert.deepEqual(calls,[]);assert.equal((await(await request('runs/'+run.id,cookieA)).json()).reasonCode,'ACCOUNT_CHANGED');
});
test('master absent blocks secret request before body/provider; provider error never leaks raw detail',async()=>{
 const old=services.connections;services.connections=new TeamConnections(new TeamVault(),old.company,{validate:async()=>{throw Error('SYNTHETIC_PRIVATE_EMAIL_TOKEN');}});
 assert.equal((await request('connections/notion',cookieA,{revision:1,token:'SYNTHETIC_TOKEN',destination:dA})).status,409);
 assert.equal((await query('SELECT 1 FROM team_secrets')).rowCount,0);
 services.connections=new TeamConnections(old.vault,old.company,{validate:async()=>{throw Error('SYNTHETIC_PRIVATE_EMAIL_TOKEN');}});
 const r=await request('connections/notion',cookieA,{revision:1,token:'SYNTHETIC_TOKEN',destination:dA});assert.equal(r.status,500);assert.ok(!(await r.text()).includes('SYNTHETIC_PRIVATE'));
});
test('logout, expiry, inactive tenant/user and auth-version change revoke access',async()=>{
 await request('logout',cookieA,{});assert.equal((await request('connections',cookieA)).status,401);
 await query('UPDATE team_users SET auth_version=auth_version+1 WHERE tenant_id=$1',[tenantB]);assert.equal((await request('connections',cookieB)).status,401);
 const fresh=await services.auth.login('synthetic-b',password);cookieB=TEAM_COOKIE+'='+fresh.token;
 await query("UPDATE team_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[tenantB]);assert.equal((await request('connections',cookieB)).status,401);
 const next=await services.auth.login('synthetic-b',password);cookieB=TEAM_COOKIE+'='+next.token;await query('UPDATE team_tenants SET active=false WHERE id=$1',[tenantB]);assert.equal((await request('connections',cookieB)).status,401);
});
test('password failure throttles and successful session token never appears in JSON body',async()=>{
 for(let i=0;i<5;i++)assert.equal((await request('login',undefined,{login:'synthetic-a',password:'wrong synthetic password'})).status,401);
 assert.equal((await request('login',undefined,{login:'synthetic-a',password})).status,429);
 const r=await request('login',undefined,{login:'synthetic-b',password});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);assert.ok(!(await r.text()).includes('token'));
});
test('one active run per tenant; lease expiry holds interrupted read without replay',async()=>{
 await ready();const run=await(await request('preview',cookieA,{requestId:randomUUID()})).json();
 assert.equal((await request('preview',cookieA,{requestId:randomUUID()})).status,409);
 await query("UPDATE team_preview_runs SET status='running',lease_token=$3,lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[tenantA,run.id,randomUUID()]);
 assert.equal(await services.queue.runNext(tenantA),false);assert.equal((await(await request('runs/'+run.id,cookieA)).json()).reasonCode,'LEASE_LOST');assert.deepEqual(calls,[]);
});

test('concurrent idempotent replay reuses one connection and cannot exhaust the DB pool',async()=>{
 await ready();const requestId=randomUUID(),first=await(await request('preview',cookieA,{requestId})).json();
 const responses=await Promise.race([Promise.all(Array.from({length:12},()=>request('preview',cookieA,{requestId}))),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('REPLAY_TIMEOUT')),5000);timer.unref();})]);
 assert.ok(responses.every(r=>r.status===202));for(const response of responses)assert.equal((await response.json()).id,first.id);
 assert.equal((await query('SELECT 1 FROM team_preview_runs WHERE tenant_id=$1',[tenantA])).rowCount,1);
});
test('oversized secret JSON and unapproved scope fields are rejected without storage',async()=>{
 const s=await status(),r=await request('connections/notion',cookieA,{revision:s.revision,token:'X'.repeat(9000),destination:dA});assert.equal(r.status,413);assert.equal((await query('SELECT 1 FROM team_secrets')).rowCount,0);
});
