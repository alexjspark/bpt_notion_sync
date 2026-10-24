import http from 'node:http';
import type{Socket}from'node:net';
import{TeamError}from'./team-errors.ts';
/** Same-origin ingress. Fixed internal peers only; no Docker/CDP/URL input. Does not listen on import. */
export function createPilotIngress(origin:string){
 const expected=new URL(origin);if(expected.pathname!=='/'||expected.search||expected.hash||expected.username||expected.password||expected.protocol!=='https:'&&!(expected.protocol==='http:'&&['localhost','127.0.0.1'].includes(expected.hostname)))throw new TeamError('RUNNER_SCOPE_INVALID');
 const sockets=new Set<Socket>();
 const target=(req:http.IncomingMessage)=>{
  if(req.headers.host!==expected.host||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))return null;
  const path=new URL(req.url,origin).pathname;
  if(/%(?:2f|5c|2e)/i.test(req.url))return null;
  if(/^\/team\/browser\/[a-f0-9-]{36}(?:\/|$)/i.test(path))return{host:'trainer-sync-team-gateway',port:4315};
  if(path==='/team'||path.startsWith('/team/')||path==='/api/team'||path.startsWith('/api/team/')||path.startsWith('/_next/')||path==='/favicon.ico')return{host:'trainer-sync-pilot-web',port:3000};
  return null;
 };
 const headers=(req:http.IncomingMessage)=>{const h={...req.headers};for(const k of Object.keys(h))if(k.startsWith('x-forwarded-')||k.startsWith('tailscale-user-')||k==='tailscale-app-capabilities'||['forwarded','proxy-authorization','proxy-connection'].includes(k))delete h[k];return h;};
 const server=http.createServer((req,res)=>{
  const peer=target(req);if(!peer){res.writeHead(403);res.end();return;}
  const upstream=http.request({...peer,path:req.url,method:req.method,headers:headers(req),timeout:20000},r=>{res.writeHead(r.statusCode??502,{...r.headers,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});r.pipe(res);});
  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
 server.headersTimeout=10000;server.requestTimeout=30000;server.maxHeadersCount=64;
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(req,socket,head)=>{
  const peer=target(req);if(!peer||peer.port!==4315||req.headers.origin!==expected.origin||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  const upstream=http.request({...peer,path:req.url,headers:headers(req),timeout:10000});
  upstream.on('upgrade',(r,other,rest)=>{upstream.setTimeout(0);(socket as Socket).setTimeout(15*60*1000,()=>socket.destroy());socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(rest.length)socket.write(rest);if(head.length)other.write(head);socket.pipe(other);other.pipe(socket);socket.on('close',()=>other.destroy());other.on('close',()=>socket.destroy());other.on('error',()=>socket.destroy());});
  upstream.on('response',r=>{socket.end('HTTP/1.1 '+(r.statusCode??502)+' Rejected\r\nConnection: close\r\n\r\n');r.resume();});upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.end();
 });
 return{server,closeConnections(){for(const s of sockets)s.destroy();}};
}
