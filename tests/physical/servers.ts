import{createServer,request as httpRequest,type IncomingMessage}from'node:http';import type{Socket}from'node:net';
import{physicalRoute,denyPhysicalEgress}from'./routing.ts';import{PHYSICAL_ORIGIN,fixtureFor,type PhysicalConfig}from'./config.ts';
import{handleTeamRequest,type TeamServices}from'../../apps/web/lib/team-api.ts';
function headers(req:IncomingMessage){return Object.fromEntries(Object.entries(req.headers).flatMap(([k,v])=>typeof v==='string'?[[k,v]]:[]));}
const safeHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
export function createPhysicalIngress(){
 const sockets=new Set<Socket>();
 const server=createServer((req,res)=>{
  try{
   const target=physicalRoute({method:req.method,url:req.url,headers:req.headers});
   if(Number(req.headers['content-length']??0)>8192){res.writeHead(413,safeHeaders).end();return;}
   const upstream=httpRequest({host:target.host,port:target.port,method:req.method,path:target.path,headers:headers(req)},r=>{res.writeHead(r.statusCode??502,{...r.headers,...safeHeaders});r.pipe(res);});
   let bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>8192){upstream.destroy();res.destroy();req.destroy();}});upstream.setTimeout(8000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,safeHeaders);res.end();});req.pipe(upstream);
  }catch{res.writeHead(403,safeHeaders).end('PHYSICAL_ROUTE_DENIED');}
 });
 server.on('upgrade',(req,client,head)=>{
  try{
   const target=physicalRoute({method:req.method,url:req.url,headers:req.headers},true),socket=client as Socket;
   const upstream=httpRequest({host:target.host,port:target.port,path:target.path,method:'GET',headers:headers(req)});
   upstream.on('upgrade',(r,remote,remoteHead)=>{
    upstream.setTimeout(0);remote.setTimeout(0);socket.setTimeout(0);
    sockets.add(socket);sockets.add(remote as Socket);socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).filter(([,v])=>typeof v==='string').map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
    if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);socket.pipe(remote);remote.pipe(socket);
    const close=()=>{socket.destroy();remote.destroy();sockets.delete(socket);sockets.delete(remote as Socket);};socket.on('error',close);remote.on('error',close);socket.on('close',close);remote.on('close',close);
   });
   upstream.on('response',r=>{socket.end('HTTP/1.1 '+(r.statusCode??403)+' Forbidden\r\nConnection: close\r\n\r\n');r.resume();});upstream.setTimeout(8000,()=>upstream.destroy());upstream.on('error',()=>socket.destroy());upstream.end();
  }catch{client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
 server.maxConnections=64;server.headersTimeout=8000;server.requestTimeout=8000;return{server,closeConnections(){for(const s of sockets)s.destroy();sockets.clear();}};
}
export function createPhysicalDenyEgress(){
 const server=createServer((_,res)=>res.writeHead(405,safeHeaders).end('PHYSICAL_EGRESS_DISABLED'));
 server.on('connect',(_,socket)=>{const deny=denyPhysicalEgress();socket.end('HTTP/1.1 '+deny.status+' Forbidden\r\nConnection: close\r\n\r\n');});server.maxConnections=32;server.headersTimeout=5000;server.requestTimeout=5000;return{server,closeConnections(){server.closeAllConnections();}};
}
export async function physicalWebResponse(request:Request,config:PhysicalConfig,services:TeamServices){
 const url=new URL(request.url);if(url.origin!==PHYSICAL_ORIGIN)return new Response('PHYSICAL_ORIGIN_DENIED',{status:403});
 if(url.pathname.startsWith('/api/team/'))return handleTeamRequest(request,url.pathname.slice('/api/team/'.length).split('/'),services,true);
 if(request.method!=='GET')return new Response('PHYSICAL_ROUTE_DENIED',{status:404});
 if(url.pathname==='/_physical/health')return Response.json({mode:'physical-test',runId:config.runId});
 if(url.pathname==='/physical.js')return new Response(physicalScript(config),{headers:{...safeHeaders,'Content-Type':'text/javascript'}});
 if(url.pathname!=='/'&&url.pathname!=='/team')return new Response('PHYSICAL_ROUTE_DENIED',{status:404});
 return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><title>TEST TrainerSync physical isolation</title><h1>TEST · 가상 A/B 물리 격리 검사</h1><p>실제 회사·Notion 연결과 회원 쓰기는 없습니다. 운영 UI와 별도인 시험 화면입니다.</p><form id="login"><label>시험 로그인 <select id="which"><option>A</option><option>B</option></select></label><button>로그인</button></form><button id="start">브라우저 준비</button><button id="confirm">가상 계정 확인</button><button id="notion">가상 Notion 연결</button><button id="preview">읽기 미리보기</button><button id="revoke">세션 취소</button><button id="logout">로그아웃</button><pre id="status"></pre><div id="screen"></div><script src="/physical.js"></script></html>',{headers:{...safeHeaders,'Content-Type':'text/html; charset=utf-8'}});
}
function physicalScript(config:PhysicalConfig){
 const fixtures={A:fixtureFor(config.runId,'A'),B:fixtureFor(config.runId,'B')};
 return 'const fixtures='+JSON.stringify(fixtures)+';let state=null;const status=document.getElementById("status");async function api(path,data){const r=await fetch("/api/team/"+path,{method:data===undefined?"GET":"POST",headers:data===undefined?{}:{"Content-Type":"application/json"},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error(v.code);return v;}async function refresh(){state=await api("connections");status.textContent=JSON.stringify(state,null,2);const screen=document.getElementById("screen");screen.replaceChildren();if(state.session?.browserUrl){const a=document.createElement("a");a.href=state.session.browserUrl;a.target="_blank";a.rel="noopener noreferrer";a.textContent="본인 TEST 화면 열기";screen.append(a);}}async function perform(fn){try{await fn();}catch(e){status.textContent=e.message;}}document.getElementById("login").onsubmit=e=>{e.preventDefault();const f=fixtures[document.getElementById("which").value];perform(async()=>{await api("login",{login:f.login,password:f.password});await refresh();});};document.getElementById("start").onclick=()=>perform(async()=>{await refresh();await api("company/start",{revision:state.revision});await refresh();});document.getElementById("confirm").onclick=()=>perform(async()=>{await refresh();await api("company/confirm",{revision:state.revision,sessionId:state.session.id});await refresh();});document.getElementById("notion").onclick=()=>perform(async()=>{const f=fixtures[document.getElementById("which").value];await refresh();await api("connections/notion",{revision:state.revision,token:f.token,destination:f.destination});await refresh();});document.getElementById("preview").onclick=()=>perform(async()=>{const run=await api("preview",{requestId:crypto.randomUUID()});status.textContent=JSON.stringify(run);for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,500));const r=await api("runs/"+run.id);status.textContent=JSON.stringify(r,null,2);if(!["queued","running"].includes(r.status))break;}});document.getElementById("revoke").onclick=()=>perform(async()=>{await refresh();await api("company/revoke",{revision:state.revision,sessionId:state.session.id});await refresh();});document.getElementById("logout").onclick=()=>perform(async()=>{await api("logout",{});state=null;status.textContent="LOGGED_OUT";document.getElementById("screen").replaceChildren();});';
}
export function createPhysicalWeb(config:PhysicalConfig,services:TeamServices){
 const server=createServer(async(req,res)=>{
  try{
   if(req.headers.host!=='localhost:4316'&&!(req.url==='/_physical/health'&&req.headers.host==='127.0.0.1:3000')){res.writeHead(403,safeHeaders).end();return;}
   let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;if(size>8192){res.writeHead(413,safeHeaders).end();return;}parts.push(part);}
   const request=new Request(PHYSICAL_ORIGIN+(req.url??'/'),{method:req.method,headers:headers(req),...(['GET','HEAD'].includes(req.method??'GET')?{}:{body:Buffer.concat(parts)})});
   const response=await physicalWebResponse(request,config,services);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,safeHeaders).end('PHYSICAL_REQUEST_FAILED');}
 });server.maxConnections=64;server.headersTimeout=8000;server.requestTimeout=8000;return{server,closeConnections(){server.closeAllConnections();}};
}
