import{test,mock}from'node:test';import assert from'node:assert/strict';import http from'node:http';import{connect,type Socket}from'node:net';import{createPilotIngress}from'../src/team-pilot-ingress.ts';
const listen=(s:http.Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address()as any).port)));const close=(s:http.Server)=>new Promise<void>(r=>s.close(()=>r()));
test('pilot ingress has fixed team peers, exact Host/WS Origin and no arbitrary upstream',async()=>{
 const peers=new Set<Socket>(),up=http.createServer((req,res)=>{assert.equal(req.headers['x-forwarded-host'],undefined);assert.equal(req.headers['proxy-authorization'],undefined);assert.equal(req.headers['tailscale-user-login'],undefined);res.end('SYNTHETIC_ASSET');});up.on('upgrade',(_r,s)=>{peers.add(s as Socket);s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nRFB_SYNTHETIC');});const upPort=await listen(up);
 const temp=http.createServer(),port=await listen(temp);await close(temp);const origin='http://127.0.0.1:'+port,ingress=createPilotIngress(origin);await new Promise<void>(r=>ingress.server.listen(port,'127.0.0.1',r));
 const original=http.request;const targets:string[]=[];const stub=mock.method(http,'request',((options:any,cb?:any)=>{assert.ok(['trainer-sync-pilot-web','trainer-sync-team-gateway'].includes(options.host));targets.push(options.host);return original({...options,host:'127.0.0.1',port:upPort},cb);})as typeof http.request);
 const raw=(request:string)=>new Promise<string>((resolve,reject)=>{const socket=connect(port,'127.0.0.1');let text='';const timer=setTimeout(()=>{socket.destroy();reject(Error('TEST_TIMEOUT'));},2000);socket.on('connect',()=>socket.write(request));socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('RFB_SYNTHETIC')||text.includes('403')){clearTimeout(timer);socket.destroy();resolve(text);}});socket.on('error',reject);});
 try{
  assert.equal(await(await fetch(origin+'/team',{headers:{'x-forwarded-host':'evil.invalid','proxy-authorization':'SYNTHETIC','tailscale-user-login':'fixture@example.invalid'}})).text(),'SYNTHETIC_ASSET');
  const path='/team/browser/11111111-1111-4111-8111-111111111111/websockify';
  const request=(o:string)=>'GET '+path+' HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nOrigin: '+o+'\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
  assert.match(await raw(request('https://evil.invalid')),/403/);assert.equal(targets.length,1);assert.match(await raw(request(origin)),/101/);assert.ok(targets.includes('trainer-sync-team-gateway'));
  assert.equal((await fetch(origin+'/api/manual-sync')).status,403);assert.match(await raw('GET /team HTTP/1.1\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n'),/403/);
 }finally{stub.mock.restore();ingress.closeConnections();for(const s of peers)s.destroy();await close(ingress.server);await close(up);}
});
