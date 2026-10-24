import{createServer,type IncomingMessage}from'node:http';
import{connect,type Socket}from'node:net';
import{readFile,realpath}from'node:fs/promises';
import{resolve,sep,extname}from'node:path';
import{requireUuid,TeamError}from'./team-errors.ts';
import{browserNames}from'./team-browser-driver.ts';
import{browserAuthority,type BrowserAuthority}from'./team-browser-store.ts';
import{TeamAuth}from'./team-auth.ts';
import{readTeamCookie}from'./team-session-cookie.ts';
export interface GatewayOptions{
 origin:string;
 authorize:(request:IncomingMessage,sessionId:string)=>Promise<BrowserAuthority>;
 loadAsset?:(relativePath:string)=>Promise<Buffer>;
 connectUpstream?:(host:string,port:number)=>Socket;
 now?:()=>number;reauthorizeMs?:number;maxConnectionMs?:number;authTimeoutMs?:number;
}
export function gatewayPath(request:IncomingMessage,origin:string,upgrade=false){
 const url=new URL(origin);if(url.origin!==origin||url.username||url.password||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new TeamError('FORBIDDEN',403);
 if(request.method!=='GET'||request.headers.host!==url.host||request.headers['sec-fetch-site']==='cross-site'||request.headers.origin!==undefined&&request.headers.origin!==origin||upgrade&&request.headers.origin!==origin)throw new TeamError('FORBIDDEN',403);
 const raw=request.url??'',match=/^\/team\/browser\/([a-fA-F0-9-]{36})\/([A-Za-z0-9_./-]*)$/.exec(raw);
 if(!match||raw.includes('//')||raw.includes('/./')||raw.includes('/../'))throw new TeamError('NOT_FOUND',404);
 const sessionId=requireUuid(match[1]),path=match[2]!;
 if(path.split('/').some(s=>s==='.'||s==='..')||path&&!(path==='login.js'||path==='login.css'||path==='websockify'||path.startsWith('novnc/')))throw new TeamError('NOT_FOUND',404);
 if(upgrade){
  const key=request.headers['sec-websocket-key'];
  if(path!=='websockify'||request.headers.upgrade?.toLowerCase()!=='websocket'||!/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(request.headers.connection??'')||request.headers['sec-websocket-version']!=='13'||typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key)||Buffer.from(key,'base64').length!==16)throw new TeamError('FORBIDDEN',403);
 }else if(path==='websockify')throw new TeamError('NOT_FOUND',404);
 return{sessionId,path};
}
const html='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TrainerSync company login</title><link rel="stylesheet" href="./login.css"><header>본인 전용 회사 로그인 화면 · 비밀번호는 회사 사이트에 직접 입력하세요. <span id="status" role="status">연결 중</span></header><main id="screen"></main><script type="module" src="./login.js"></script></html>';
const js="import RFB from './novnc/core/rfb.js';const status=document.getElementById('status');const url=new URL('./websockify',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';const rfb=new RFB(document.getElementById('screen'),url.href);rfb.scaleViewport=true;rfb.resizeSession=false;rfb.addEventListener('connect',()=>status.textContent='연결됨');rfb.addEventListener('disconnect',()=>status.textContent='연결 종료: 설정 화면에서 상태를 확인하세요.');";
const css='body{margin:0;background:#111827;color:#fff;font-family:system-ui}header{padding:14px;font-size:14px}#screen{height:calc(100vh - 58px);min-height:320px}';
export async function loadNoVncAsset(relativePath:string):Promise<Buffer>{
 if(!relativePath.startsWith('novnc/')||relativePath.includes('..')||!/^novnc\/[A-Za-z0-9_./-]+$/.test(relativePath))throw new TeamError('NOT_FOUND',404);
 const root=await realpath('/usr/share/novnc'),file=await realpath(resolve(root,relativePath.slice(6)));
 if(!file.startsWith(root+sep))throw new TeamError('FORBIDDEN',403);const data=await readFile(file);if(data.length>1024*1024)throw new TeamError('NOT_FOUND',404);return data;
}
export function productionGatewayAuthorizer(auth=new TeamAuth()){
 return async(request:IncomingMessage,sessionId:string)=>browserAuthority(await auth.resolve(readTeamCookie(request.headers.cookie)),sessionId);
}
/** Creates handlers only. Caller explicitly owns listening/network configuration; no port opens on import. */
export function createTeamBrowserGateway(options:GatewayOptions){
 const now=options.now??Date.now,checkMs=Math.min(3000,Math.max(20,options.reauthorizeMs??1000)),maxMs=Math.min(900000,Math.max(50,options.maxConnectionMs??900000));
 const tracked=new Set<Socket>(),counts=new Map<string,number>(),loader=options.loadAsset??loadNoVncAsset,dial=options.connectUpstream??((host,port)=>connect(port,host));
 const authority=async(req:IncomingMessage,id:string)=>{let timer:ReturnType<typeof setTimeout>|undefined;const a=await Promise.race([options.authorize(req,id),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TeamError('AUTH_REQUIRED',401)),Math.max(20,Math.min(2000,options.authTimeoutMs??1500)));})]).finally(()=>clearTimeout(timer));if(a.sessionId!==id||a.expiresAt<=now())throw new TeamError('NOT_FOUND',404);requireUuid(a.tenantId);return a;};
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' "+options.origin.replace(/^http/,'ws')+"; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try{
   const p=gatewayPath(req,options.origin);await authority(req,p.sessionId);
   if(!p.path){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;}
   if(p.path==='login.js'||p.path==='login.css'){res.writeHead(200,{'Content-Type':p.path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'}).end(p.path.endsWith('.js')?js:css);return;}
   const mime:Record<string,string>={'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2'};
   const type=mime[extname(p.path)];if(!type)throw new TeamError('NOT_FOUND',404);const data=await loader(p.path);if(data.length>1024*1024)throw new TeamError('NOT_FOUND',404);res.writeHead(200,{'Content-Type':type}).end(data);
  }catch(e){res.writeHead(e instanceof TeamError?e.status:403).end('BROWSER_ACCESS_DENIED');}
 });
 server.on('upgrade',async(req,client,head)=>{
  let upstream:Socket|undefined,timer:ReturnType<typeof setInterval>|undefined,ttl:ReturnType<typeof setTimeout>|undefined,key:string|undefined,closed=false;
  const socket=client as Socket;
  const close=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(ttl);socket.destroy();upstream?.destroy();tracked.delete(socket);if(upstream)tracked.delete(upstream);if(key)counts.set(key,Math.max(0,(counts.get(key)??1)-1));};
  try{
   const p=gatewayPath(req,options.origin,true),a=await authority(req,p.sessionId),initialRevision=a.revision;
   key=JSON.stringify([a.tenantId,a.sessionId,a.userId]);
   if((counts.get(key)??0)>=2||tracked.size>=64)throw new TeamError('FORBIDDEN',403);
   counts.set(key,(counts.get(key)??0)+1);tracked.add(socket);socket.on('error',close);socket.on('close',close);
   const host=browserNames(a).container;upstream=dial(host,6080);tracked.add(upstream);upstream.setTimeout(10000,()=>{if(!upstream?.connecting)return;close();});upstream.on('error',close);upstream.on('close',close);
   upstream.on('connect',()=>{void(async()=>{
    const current=await authority(req,p.sessionId);if(current.revision!==initialRevision||current.tenantId!==a.tenantId||closed)throw new TeamError('CONNECTION_CHANGED');
    const protocol=req.headers['sec-websocket-protocol'];if(protocol!==undefined&&protocol!=='binary'&&protocol!=='base64')throw new TeamError('FORBIDDEN',403);
    upstream!.write('GET / HTTP/1.1\r\nHost: '+host+':6080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+req.headers['sec-websocket-key']+'\r\n'+(protocol?'Sec-WebSocket-Protocol: '+protocol+'\r\n':'')+'\r\n');
    if(head.length)upstream!.write(head);socket.pipe(upstream!);upstream!.pipe(socket);
   })().catch(close);});
   let checking=false;
   timer=setInterval(()=>{if(checking)return;checking=true;void authority(req,p.sessionId).then(c=>{if(c.revision!==initialRevision||c.tenantId!==a.tenantId)close();}).catch(close).finally(()=>{checking=false;});},checkMs);timer.unref();
   ttl=setTimeout(close,Math.max(1,Math.min(maxMs,a.expiresAt-now())));ttl.unref();
  }catch{if(!tracked.has(socket))socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');else close();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 return{server,closeConnections(){for(const socket of tracked)socket.destroy();tracked.clear();counts.clear();}};
}
