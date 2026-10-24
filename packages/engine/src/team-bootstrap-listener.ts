import http from'node:http';import type{Socket}from'node:net';import{Readable}from'node:stream';
import{createOperatorBootstrap}from'./team-operator-bootstrap.ts';
/** Constructor only; the caller must separately authorize/start listening. */
export function createBootstrapListener(input:{port:number;csrf:string;provision:(v:{login:string;password:string;label:string})=>Promise<unknown>;maxAgeMs?:number}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('BOOTSTRAP_SCOPE_INVALID');
 const origin='http://127.0.0.1:'+input.port,host=new URL(origin).host,handler=createOperatorBootstrap({...input,origin});
 const sockets=new Set<Socket>();let active=0,closing=false;let life:ReturnType<typeof setTimeout>|undefined;
 const close=()=>{if(closing)return;closing=true;clearTimeout(life);server.close();for(const s of sockets)s.destroy();};
 const server=http.createServer(async(req,res)=>{
  if(closing||req.headers.host!==host||req.url!=='/'||!['GET','POST'].includes(req.method??'')||active>=2){res.writeHead(403,{'Connection':'close'}).end('BOOTSTRAP_FORBIDDEN');return;}
  active++;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   timer=setTimeout(()=>{req.destroy();res.destroy();},10000);
   const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
   const init:RequestInit&{duplex?:'half'}={method:req.method,headers};if(req.method==='POST'){init.body=Readable.toWeb(req)as ReadableStream<Uint8Array>;init.duplex='half';}
   const response=await handler(new Request(origin+'/',init));
   const terminal=response.headers.get('X-TrainerSync-Bootstrap-Consumed')==='1';if(terminal){closing=true;clearTimeout(life);server.close();res.once('finish',()=>{for(const s of sockets)s.destroy();});}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
  }catch{if(!res.headersSent)res.writeHead(400);res.end('BOOTSTRAP_INVALID');}finally{active--;clearTimeout(timer);}
 });
 server.headersTimeout=10000;server.requestTimeout=10000;server.maxHeadersCount=32;server.maxConnections=4;
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 for(const event of['upgrade','connect']as const)server.on(event,(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
 return{server,origin,close,startLifetime(){if(life)throw Error('BOOTSTRAP_ALREADY_STARTED');life=setTimeout(close,Math.min(600000,input.maxAgeMs??600000));life.unref();}};
}
