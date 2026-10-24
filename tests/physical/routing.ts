import{PHYSICAL_ORIGIN,PHYSICAL_PEERS}from'./config.ts';
export interface PhysicalRequest{method?:string;url?:string;headers:Record<string,string|string[]|undefined>}
export function physicalRoute(req:PhysicalRequest,upgrade=false){
 if(req.headers.host!=='localhost:4316'||req.headers.origin!==undefined&&req.headers.origin!==PHYSICAL_ORIGIN||req.headers['sec-fetch-site']==='cross-site')throw Error('PHYSICAL_ORIGIN_DENIED');
 const path=req.url??'';if(!path.startsWith('/')||path.startsWith('//')||/[\\\r\n\0]/.test(path)||/%(?:2f|5c|2e)/i.test(path)||path.includes('/../'))throw Error('PHYSICAL_ROUTE_DENIED');
 const browser=/^\/team\/browser\/[a-f0-9-]{36}\/(?:[A-Za-z0-9_./-]*)$/.test(path);
 if(upgrade){if(req.method!=='GET'||req.headers.origin!==PHYSICAL_ORIGIN||!/^\/team\/browser\/[a-f0-9-]{36}\/websockify$/.test(path))throw Error('PHYSICAL_UPGRADE_DENIED');return{host:PHYSICAL_PEERS.gateway,port:4315,path};}
 if(!['GET','POST'].includes(req.method??'')||req.method==='POST'&&req.headers.origin!==PHYSICAL_ORIGIN)throw Error('PHYSICAL_METHOD_DENIED');
 if(browser)return{host:PHYSICAL_PEERS.gateway,port:4315,path};
 if(path==='/'||path==='/team'||path==='/physical.js'||/^\/api\/team\/[A-Za-z0-9_/-]+$/.test(path))return{host:'trainer-sync-team-test-web',port:3000,path};
 throw Error('PHYSICAL_ROUTE_DENIED');
}
export function denyPhysicalEgress(){return{status:403,code:'PHYSICAL_EGRESS_DISABLED'}as const;}
