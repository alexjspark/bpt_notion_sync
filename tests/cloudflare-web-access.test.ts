import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import http from 'node:http';
import {connect,type Socket} from 'node:net';
import {createCloudflareAccessGuard,cloudflareGuardFromEnvironment} from '../packages/engine/src/cloudflare-access-guard.ts';
import {cloudflareAccessPlan,validateCloudflareAccess} from '../packages/engine/src/pilot-cloudflare-access.ts';
import {validatePilotDeployment,compilePilotDeployment,pilotAccessPlan} from '../packages/engine/src/pilot-deployment.ts';
import {createPilotIngress} from '../packages/engine/src/team-pilot-ingress.ts';
// Ephemeral test signing material only; never persisted, printed or used with a provider.
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const cfg={teamName:'synthetic-team',audience:'a'.repeat(64),allowedEmails:['operator@example.invalid','colleague@example.invalid']},issuer='https://synthetic-team.cloudflareaccess.com',id='11111111-1111-4111-8111-111111111111';
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'};
const token=(p:Record<string,unknown>={},h:Record<string,unknown>={})=>{const sec=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture',...h})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:issuer,aud:[cfg.audience],iat:sec-1,nbf:sec-1,exp:sec+100,sub:'synthetic-user',email:cfg.allowedEmails[1],...p})).toString('base64url'),data=head+'.'+body;return data+'.'+sign('RSA-SHA256',Buffer.from(data),pair.privateKey).toString('base64url');};
const req=(jwt?:string)=>({headers:jwt?{'cf-access-jwt-assertion':jwt}:{}} as http.IncomingMessage);
const keyFetch=(async(url:any,opts:any)=>{assert.equal(url,issuer+'/cdn-cgi/access/certs');assert.equal(opts.redirect,'error');return Response.json({keys:[jwk]});}) as typeof fetch;

test('Cloudflare web plan requires exactly named users and emits per-host Access validation and catch-all denial',()=>{
 const c={...cfg,tunnelId:id},v=validateCloudflareAccess(c);for(const bad of[{...c,allowedEmails:[]},{...c,allowedEmails:[...c.allowedEmails,'other@example.invalid']},{...c,teamName:'evil.invalid/path'},{...c,audience:'any'},{...c,unknown:true}])assert.throws(()=>validateCloudflareAccess(bad));
 const plan=cloudflareAccessPlan(v,'https://pilot.example.com',4314);assert.equal(plan.requiresDeviceApp,false);assert.equal(plan.activationApproved,false);assert.equal(plan.ingressEnvironment.TEAM_WEB_ACCESS_APPROVED,'false');assert.ok(plan.tunnelYaml.includes('protocol: http2'));assert.match(plan.tunnelYaml,/originRequest:\n      httpHostHeader: pilot.example.com\n      access:\n        required: true/);assert.ok(plan.tunnelYaml.endsWith('  - service: http_status:404\n'));assert.ok(!plan.tunnelYaml.includes('noTLSVerify'));assert.throws(()=>cloudflareAccessPlan(v,'https://fixture.trycloudflare.com',4314));
 const head='b'.repeat(40),image='sha256:'+'c'.repeat(64),input={version:1,deploymentId:id,sourceRevision:head,origin:plan.origin,access:{mode:'web',provider:'cloudflare-access',approvalReference:'SYNTHETIC_REVIEW',cloudflare:c},images:{runtime:image,browser:image,postgres:image},ports:{ingress:4314,database:15434,bootstrap:4318}},d=validatePilotDeployment(input,head),manifest=compilePilotDeployment(d);assert.equal((manifest.services.ingress.environment as Record<string,string>).TEAM_WEB_ACCESS_APPROVED,'${TEAM_WEB_ACCESS_APPROVED:-false}');assert.equal(manifest.services.worker.environment.TEAM_PILOT_WRITE_APPROVED,'false');assert.equal(pilotAccessPlan(d).provider,'cloudflare-access');assert.throws(()=>validatePilotDeployment({...input,access:{...input.access,cloudflare:undefined}},head));
});
test('operational ingress access settings are default-deny; importing a guard performs no IO',()=>{
 for(const env of[{}, {TEAM_ACCESS_PROVIDER:'cloudflare-access'}, {TEAM_ACCESS_PROVIDER:'approved-https-proxy',TEAM_WEB_ACCESS_APPROVED:'true'}])assert.throws(()=>cloudflareGuardFromEnvironment(env));
 let count=0;createCloudflareAccessGuard(cfg,{fetch:(async()=>{count++;throw Error();})as typeof fetch});assert.equal(count,0);
});
test('signed Access JWT validates fixed issuer/AUD/email and never trusts email or cookie alone',async()=>{
 const guard=createCloudflareAccessGuard(cfg,{fetch:keyFetch});assert.ok((await guard(req(token()))).expiresAt>Date.now());
 for(const claims of[{iss:'https://other.cloudflareaccess.com'},{aud:['wrong']},{email:'unknown@example.invalid'},{exp:1},{iat:Math.floor(Date.now()/1000)+40},{nbf:Math.floor(Date.now()/1000)+40},{exp:Math.floor(Date.now()/1000)+7200},{sub:''}])await assert.rejects(guard(req(token(claims))),/WEB_ACCESS_DENIED/);
 await assert.rejects(guard({headers:{'cf-access-authenticated-user-email':cfg.allowedEmails[1],cookie:'CF_Authorization=SYNTHETIC'}} as unknown as http.IncomingMessage),/WEB_ACCESS_DENIED/);
 for(const h of[{alg:'none'},{alg:'HS256'},{kid:'unknown'},{crit:['jku']}])await assert.rejects(guard(req(token({},h))),/WEB_ACCESS_DENIED/);
 const valid=token(),parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({email:cfg.allowedEmails[0]})).toString('base64url');await assert.rejects(guard(req(parts.join('.'))),/WEB_ACCESS_DENIED/);
});
test('JWKS errors, redirect, oversized key set and stale cache fail closed with bounded refresh',async()=>{
 for(const loader of[(async()=>{throw Error('SYNTHETIC_PROVIDER_ERROR');}),(async()=>new Response('x',{status:302})),(async()=>Response.json({keys:Array(17).fill(jwk)})),(async()=>new Response('x'.repeat(65537)))]){let calls=0;const guard=createCloudflareAccessGuard(cfg,{fetch:(async(...args:any[])=>{calls++;return loader(...args as []);})as typeof fetch});await assert.rejects(guard(req(token())),/^Error: WEB_ACCESS_DENIED$/);await assert.rejects(guard(req(token())),/WEB_ACCESS_DENIED/);assert.equal(calls,1);}
 let clock=Date.now(),calls=0;const guard=createCloudflareAccessGuard(cfg,{now:()=>clock,fetch:(async(...args:any[])=>{calls++;if(calls>1)throw Error();return keyFetch(...args as Parameters<typeof fetch>);})as typeof fetch});await guard(req(token()));clock+=300001;await assert.rejects(guard(req(token())),/WEB_ACCESS_DENIED/);assert.equal(calls,2);
});
test('rotation loads a new public key after cooldown without following token-provided URLs',async()=>{
 let clock=Date.now(),calls=0;const guard=createCloudflareAccessGuard(cfg,{now:()=>clock,fetch:(async(url:any)=>{assert.equal(url,issuer+'/cdn-cgi/access/certs');calls++;return Response.json({keys:[{...jwk,kid:calls===1?'fixture':'rotated'}]});})as typeof fetch});await guard(req(token()));clock+=30001;await guard(req(token({}, {kid:'rotated',jku:'http://127.0.0.1/private'})));assert.equal(calls,2);
});
const listen=(s:http.Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address()as any).port)));
const close=(s:http.Server)=>new Promise<void>(r=>s.close(()=>r()));
test('native ingress gates HTTP/WS before peer connection, strips provider identity and closes active or pending WS at Access expiry',async()=>{
 const peers=new Set<Socket>();let upstreamCalls=0,closed=false,delay=false,delayedClosed=false;
 const up=http.createServer((r,s)=>{assert.equal(r.headers['cf-access-jwt-assertion'],undefined);assert.equal(r.headers['cf-access-authenticated-user-email'],undefined);assert.equal(r.headers.cookie,'trainer_session=SYNTHETIC');s.end('SAFE_ASSET');});
 up.on('upgrade',(r,s)=>{peers.add(s as Socket);if(delay){s.once('close',()=>{delayedClosed=true;});s.once('end',()=>s.destroy());s.resume();return;}assert.equal(r.headers['cf-access-jwt-assertion'],undefined);assert.equal(r.headers.cookie,'trainer_session=SYNTHETIC');s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nRFB_SYNTHETIC');});const upPort=await listen(up),guard=createCloudflareAccessGuard(cfg,{fetch:keyFetch});
 const ingress=createPilotIngress('https://pilot.example.com',async r=>{const auth=await guard(r);return{expiresAt:Math.min(auth.expiresAt,Date.now()+180)};}),port=await listen(ingress.server),original=http.request;
 const stub=mock.method(http,'request',((o:any,cb?:any)=>{upstreamCalls++;assert.ok(['trainer-sync-team-gateway','trainer-sync-pilot-web'].includes(o.host));return original({...o,host:'127.0.0.1',port:upPort},cb);})as typeof http.request);
 const raw=(path:string,headers:string,waitClose=false)=>new Promise<string>((resolve,reject)=>{const s=connect(port,'127.0.0.1');let text='';const timer=setTimeout(()=>{s.destroy();reject(Error('TEST_TIMEOUT'));},2000);s.on('connect',()=>s.write('GET '+path+' HTTP/1.1\r\nHost: pilot.example.com\r\n'+headers+'\r\n'));s.on('data',b=>{text+=b.toString();if(!waitClose&&(text.includes('SAFE_ASSET')||text.includes('403'))){clearTimeout(timer);s.destroy();resolve(text);}});s.on('close',()=>{clearTimeout(timer);closed=true;resolve(text);});s.on('error',reject);});
 const ws='/team/browser/'+id+'/websockify',upgrade='Origin: https://pilot.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
 try{
  assert.match(await raw('/team','cf-access-authenticated-user-email: colleague@example.invalid\r\nConnection: close\r\n'),/403/);assert.match(await raw(ws,upgrade),/403/);assert.equal(upstreamCalls,0);
  const headers='Cf-Access-Jwt-Assertion: '+token()+'\r\nCookie: CF_Authorization=SYNTHETIC;trainer_session=SYNTHETIC\r\n';assert.match(await raw('/team',headers+'Connection: close\r\n'),/SAFE_ASSET/);assert.equal(upstreamCalls,1);
  assert.match(await raw(ws,headers+upgrade.replace('https://pilot.example.com','https://evil.invalid')),/403/);assert.equal(upstreamCalls,1);closed=false;assert.match(await raw(ws,headers+upgrade,true),/101/);assert.equal(closed,true);assert.equal(upstreamCalls,2);delay=true;assert.ok(!(await raw(ws,headers+upgrade,true)).includes('101'));await new Promise(r=>setTimeout(r,40));assert.equal(delayedClosed,true);assert.equal(upstreamCalls,3);
 }finally{stub.mock.restore();ingress.closeConnections();for(const s of peers)s.destroy();await close(ingress.server);await close(up);}
});
