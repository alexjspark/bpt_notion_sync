import{test}from'node:test';import assert from'node:assert/strict';import{createServer,type Server}from'node:http';import{connect,type Socket}from'node:net';
import{createTeamBrowserGateway,gatewayPath}from'../src/team-browser-gateway.ts';import{TeamError}from'../src/team-errors.ts';
import{createCompanyEgress,publicCompanyAddress}from'../src/team-company-egress.ts';import{readTeamCookie}from'../src/team-session-cookie.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',S='33333333-3333-4333-8333-333333333333';
const listen=(s:Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address()as{port:number}).port)));
const close=(s:Server)=>new Promise<void>(r=>s.close(()=>r()));
function raw(port:number,request:string){return new Promise<{socket:Socket;response:string}>(resolve=>{const socket=connect(port,'127.0.0.1');let response='';socket.on('connect',()=>socket.write(request));socket.on('data',b=>{response+=b.toString();if(response.includes('\r\n\r\n'))resolve({socket,response});});socket.on('error',()=>{});socket.on('close',()=>resolve({socket,response}));});}
const upgraded=(host:string,path:string,cookie='A',origin?:string)=>'GET '+path+' HTTP/1.1\r\nHost: '+host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nCookie: '+cookie+'\r\n'+(origin?'Origin: '+origin+'\r\n':'')+'\r\n';
test('gateway HTTP ownership, host/origin, asset path and arbitrary target denial; no upstream credential forwarding',async()=>{
 let origin='',allowed=true,revision=1,dials=0,forwarded='';const sockets=new Set<Socket>();
 const upstream=createServer();upstream.on('upgrade',(r,s)=>{sockets.add(s as Socket);forwarded=JSON.stringify(r.headers);s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});const up=await listen(upstream);
 const gateway=createTeamBrowserGateway({origin:'http://127.0.0.1:1',authorize:async()=>{throw Error();}});
 // Fresh factory after selected port is known; dynamic requests use fixed configured host/origin.
 await close(gateway.server).catch(()=>{});
 const server=createServer();const port=await listen(server);await close(server);origin='http://127.0.0.1:'+port;
 const g=createTeamBrowserGateway({origin,reauthorizeMs:20,maxConnectionMs:500,authorize:async(req,id)=>{if(!allowed||req.headers.cookie!=='A'||id!==S)throw new TeamError('AUTH_REQUIRED',401);return{tenantId:A,sessionId:S,connectionId:B,revision,expiresAt:Date.now()+10000,userId:A,authSessionHash:'synthetic'};},loadAsset:async()=>Buffer.from('SYNTHETIC_ASSET'),connectUpstream:(host,p)=>{assert.equal(host,'ts-team-browser-'+S.replaceAll('-',''));assert.equal(p,6080);dials++;return connect(up,'127.0.0.1');}});
 await new Promise<void>(r=>g.server.listen(port,'127.0.0.1',r));
 try{
  const path='/team/browser/'+S+'/';assert.equal((await fetch(origin+path,{headers:{cookie:'A'}})).status,200);assert.equal((await fetch(origin+path,{headers:{cookie:'B'}})).status,401);
  assert.equal((await fetch(origin+path+'novnc/core/rfb.js',{headers:{cookie:'A'}})).status,200);
  for(const suffix of['?target=http://169.254.169.254','http://evil.invalid','novnc/%2e%2e/private','../../api'])assert.notEqual((await fetch(origin+path+suffix,{headers:{cookie:'A'}})).status,200);
  assert.equal((await fetch(origin+path,{headers:{cookie:'A',origin:'http://evil.invalid'}})).status,403);
  const bad=await raw(port,upgraded('127.0.0.1:'+port,path+'websockify','A'));assert.match(bad.response,/403/);bad.socket.destroy();assert.equal(dials,0);
  const good=await raw(port,upgraded('127.0.0.1:'+port,path+'websockify','A',origin));assert.match(good.response,/101/);assert.equal(dials,1);assert.ok(!forwarded.includes('cookie'));
  allowed=false;await new Promise<void>(r=>{good.socket.once('close',r);setTimeout(r,1000);});assert.equal(good.socket.destroyed,true);
 }finally{g.closeConnections();for(const s of sockets)s.destroy();await close(g.server);await close(upstream);}
});
test('gateway closes on revision change/TTL and authorization timeout is bounded',async()=>{
 let revision=1,origin='';const temp=createServer(),port=await listen(temp);await close(temp);origin='http://127.0.0.1:'+port;
 const peers=new Set<Socket>(),up=createServer();up.on('upgrade',(_,s)=>{peers.add(s as Socket);s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});const upPort=await listen(up);
 const g=createTeamBrowserGateway({origin,reauthorizeMs:20,maxConnectionMs:100,authorize:async()=>({tenantId:A,sessionId:S,connectionId:B,revision,expiresAt:Date.now()+10000,userId:A,authSessionHash:'synthetic'}),connectUpstream:()=>connect(upPort,'127.0.0.1')});await new Promise<void>(r=>g.server.listen(port,'127.0.0.1',r));
 try{
  const p='/team/browser/'+S+'/websockify',one=await raw(port,upgraded('127.0.0.1:'+port,p,'A',origin));revision++;await new Promise(r=>setTimeout(r,70));assert.ok(one.socket.destroyed);
  const two=await raw(port,upgraded('127.0.0.1:'+port,p,'A',origin));await new Promise(r=>setTimeout(r,150));assert.ok(two.socket.destroyed);
 }finally{g.closeConnections();for(const p of peers)p.destroy();await close(g.server);await close(up);}
 const reservation=createServer(),tport=await listen(reservation);await close(reservation);
 const stalled=createTeamBrowserGateway({origin:'http://127.0.0.1:'+tport,authTimeoutMs:20,authorize:async()=>new Promise(()=>{})});
 // Test timeout with a selected fixed host, without exposing a host interface outside loopback.
 await new Promise<void>(r=>stalled.server.listen(tport,'127.0.0.1',r));try{const r=await fetch('http://127.0.0.1:'+tport+'/team/browser/'+S+'/');assert.equal(r.status,401);}finally{await close(stalled.server);}
});
test('company egress denies arbitrary hosts/ports/private DNS and connects only fixed public IP:443',async()=>{
 for(const ip of['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','::1','999.1.1.1'])assert.equal(publicCompanyAddress(ip),false);assert.equal(publicCompanyAddress('93.184.216.34'),true);
 let resolved=0,dialed=0,privateDns=true;const remote=createServer();remote.on('connect',()=>{});const remotePort=await listen(remote);
 const proxy=createCompanyEgress({resolve:async()=>{resolved++;return[privateDns?'127.0.0.1':'93.184.216.34'];},dial:(ip,p)=>{assert.equal(ip,'93.184.216.34');assert.equal(p,443);dialed++;return connect(remotePort,'127.0.0.1');},maxTunnelMs:100});const port=await listen(proxy.server);
 try{
  for(const target of['169.254.169.254:80','evil.invalid:443','admin.biz-pt.com:444','user@admin.biz-pt.com:443']){const r=await raw(port,'CONNECT '+target+' HTTP/1.1\r\nHost: '+target+'\r\n\r\n');assert.match(r.response,/403/);r.socket.destroy();}
  assert.equal(resolved,0);const bad=await raw(port,'CONNECT admin.biz-pt.com:443 HTTP/1.1\r\nHost: admin.biz-pt.com\r\n\r\n');assert.match(bad.response,/403/);bad.socket.destroy();assert.equal(dialed,0);
  privateDns=false;const good=await raw(port,'CONNECT admin.biz-pt.com:443 HTTP/1.1\r\nHost: admin.biz-pt.com\r\n\r\n');assert.match(good.response,/200/);assert.equal(dialed,1);good.socket.destroy();
 }finally{proxy.closeConnections();await close(proxy.server);await close(remote);}
});
test('duplicate service cookies are rejected and unsafe URL/Host never selects a tenant target',()=>{
 const value='A'.repeat(43);assert.equal(readTeamCookie('trainer_team_session='+value),value);assert.equal(readTeamCookie('trainer_team_session='+value+'; trainer_team_session='+value),undefined);
 assert.throws(()=>gatewayPath({method:'GET',url:'/team/browser/'+S+'/?target=http://evil',headers:{host:'localhost'}}as never,'http://localhost'),{code:'NOT_FOUND'});
});

test('egress reserves connection slots before DNS so concurrent requests cannot exceed the cap',async()=>{
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;});const proxy=createCompanyEgress({maxConnections:2,resolve:async()=>{calls++;await gate;return['127.0.0.1'];},dial:()=>{throw Error('PRIVATE_DNS_MUST_NOT_DIAL');}}),port=await listen(proxy.server),req='CONNECT admin.biz-pt.com:443 HTTP/1.1\\r\\nHost: admin.biz-pt.com\\r\\n\\r\\n'.replaceAll('\\r','\r').replaceAll('\\n','\n');
 try{const one=raw(port,req),two=raw(port,req);for(let i=0;i<30&&calls<2;i++)await new Promise(r=>setTimeout(r,5));const third=await raw(port,req);assert.match(third.response,/403/);assert.equal(calls,2);third.socket.destroy();release();for(const result of await Promise.all([one,two])){assert.match(result.response,/403/);result.socket.destroy();}}
 finally{release();proxy.closeConnections();await close(proxy.server);}
});
