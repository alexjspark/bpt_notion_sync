import{createServer}from'node:http';import{connect,type Socket,BlockList,isIP}from'node:net';import{lookup}from'node:dns/promises';
const blocked=new BlockList();
for(const[address,prefix]of[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(address,prefix,'ipv4');
export function publicCompanyAddress(ip:string){return isIP(ip)===4&&!blocked.check(ip,'ipv4');}
export interface EgressOptions{resolve?:(host:string)=>Promise<string[]>;dial?:(ip:string,port:number)=>Socket;maxTunnelMs?:number;maxConnections?:number}
export function createCompanyEgress(options:EgressOptions={}){
 let connections=0;const maxConnections=Math.max(1,Math.min(32,options.maxConnections??32));
 const sockets=new Set<Socket>(),resolve=options.resolve??(async host=>(await lookup(host,{family:4,all:true})).map(r=>r.address)),dial=options.dial??((ip,port)=>connect(port,ip));
 const server=createServer((_,res)=>res.writeHead(405,{'Cache-Control':'no-store'}).end('CONNECT_ONLY'));
 server.on('connect',async(req,client,head)=>{
  const socket=client as Socket;let upstream:Socket|undefined,ttl:ReturnType<typeof setTimeout>|undefined,reserved=false,closed=false;
  const close=()=>{if(closed)return;closed=true;if(reserved){connections--;reserved=false;}clearTimeout(ttl);socket.destroy();upstream?.destroy();sockets.delete(socket);if(upstream)sockets.delete(upstream);};
  try{
   if(req.url!=='admin.biz-pt.com:443'||connections>=maxConnections)throw Error();
   connections++;reserved=true;sockets.add(socket);socket.on('error',close);socket.on('close',close);
   let dnsTimer:ReturnType<typeof setTimeout>|undefined;const addresses=await Promise.race([resolve('admin.biz-pt.com'),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error()),2000);})]).finally(()=>clearTimeout(dnsTimer));if(!addresses.length||addresses.length>16||addresses.some(ip=>!publicCompanyAddress(ip)))throw Error();
   if(closed)return;
   upstream=dial(addresses[0]!,443);sockets.add(socket);sockets.add(upstream);socket.on('error',close);socket.on('close',close);upstream.on('error',close);upstream.on('close',close);
   upstream.setTimeout(30000,close);socket.setTimeout(30000,close);
   upstream.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream!.write(head);socket.pipe(upstream!);upstream!.pipe(socket);});
   ttl=setTimeout(close,Math.min(600000,options.maxTunnelMs??600000));ttl.unref();
  }catch{if(reserved){connections--;reserved=false;}sockets.delete(socket);socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
 server.maxConnections=64;server.headersTimeout=10000;server.requestTimeout=10000;
 return{server,closeConnections(){for(const socket of sockets)socket.destroy();sockets.clear();}};
}
