import {createPublicKey,verify,type KeyObject,type JsonWebKey} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
export type IngressAccessGuard=(request:IncomingMessage)=>Promise<{expiresAt:number}>;
interface GuardConfig {teamName:string;audience:string;allowedEmails:string[]}
const denied=():never=>{throw Error('WEB_ACCESS_DENIED');};
function config(v:GuardConfig){
 if(! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v.teamName)||! /^[a-f0-9]{64}$/.test(v.audience)||!Array.isArray(v.allowedEmails)||v.allowedEmails.length!==2||new Set(v.allowedEmails).size!==2||v.allowedEmails.some(e=>typeof e!=='string'||e!==e.toLowerCase()||e.length>254||! /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)))denied();
 return structuredClone(v);
}
function decode(s:string){if(!s||! /^[A-Za-z0-9_-]+$/.test(s))denied();const b=Buffer.from(s,'base64url');if(b.toString('base64url')!==s)denied();const v=JSON.parse(b.toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))denied();return v;}
/** Fixed HTTPS public key endpoint only. Import creates no network request/listener. */
export function createCloudflareAccessGuard(input:GuardConfig,options:{fetch?:typeof fetch;now?:()=>number}={}):IngressAccessGuard {
 const v=config(input),issuer='https://'+v.teamName+'.cloudflareaccess.com',now=options.now??Date.now,load=options.fetch??fetch;
 let keys=new Map<string,KeyObject>(),validUntil=0,nextRefresh=0,pending:Promise<void>|undefined;
 async function refresh(){
  if(pending)return pending;if(now()<nextRefresh)denied();nextRefresh=now()+30000;
  pending=(async()=>{
   const r=await load(issuer+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(3000),headers:{accept:'application/json'}});
   if(!r.ok||!r.body)return denied();const reader=r.body.getReader();let size=0;const chunks:Uint8Array[]=[];
   try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>65536)denied();chunks.push(x.value);}}finally{await reader.cancel().catch(()=>{});}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(body.keys)||body.keys.length<1||body.keys.length>16)denied();const next=new Map<string,KeyObject>();
   for(const k of body.keys){if(k.kty!=='RSA'||typeof k.kid!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(k.kid)||k.alg!==undefined&&k.alg!=='RS256'||k.use!==undefined&&k.use!=='sig'||typeof k.n!=='string'||typeof k.e!=='string'||k.d!==undefined||next.has(k.kid))denied();const key=createPublicKey({key:k as JsonWebKey,format:'jwk'});if((key.asymmetricKeyDetails?.modulusLength??0)<2048)denied();next.set(k.kid,key);}
   keys=next;validUntil=now()+300000;
  })().finally(()=>{pending=undefined;});return pending;
 }
 return async req=>{
  try{
   const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||token.length>8192)return denied();const parts=token.split('.');if(parts.length!==3)denied();const h=decode(parts[0]!),p=decode(parts[1]!);
   if(h.alg!=='RS256'||typeof h.kid!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(h.kid)||h.crit!==undefined||! /^[A-Za-z0-9_-]+$/.test(parts[2]!))denied();
   if(now()>=validUntil||!keys.has(h.kid))await refresh();const key=keys.get(h.kid);if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2]!,'base64url')))denied();
   const seconds=Math.floor(now()/1000);
   if(p.iss!==issuer||!Array.isArray(p.aud)||!p.aud.includes(v.audience)||!Number.isSafeInteger(p.exp)||!Number.isSafeInteger(p.iat)||p.exp<=seconds||p.iat>seconds+30||p.exp<=p.iat||p.exp-p.iat>3600||p.nbf!==undefined&&(!Number.isSafeInteger(p.nbf)||p.nbf>seconds)||typeof p.sub!=='string'||!p.sub||typeof p.email!=='string'||!v.allowedEmails.includes(p.email.toLowerCase()))denied();
   return{expiresAt:p.exp*1000};
  }catch{return denied();}
 };
}
export function cloudflareGuardFromEnvironment(env:NodeJS.ProcessEnv):IngressAccessGuard {
 if(env.TEAM_ACCESS_PROVIDER!=='cloudflare-access'||env.TEAM_WEB_ACCESS_APPROVED!=='true')denied();
 try{return createCloudflareAccessGuard({teamName:env.TEAM_CF_TEAM_NAME??'',audience:env.TEAM_CF_AUDIENCE??'',allowedEmails:JSON.parse(env.TEAM_CF_ALLOWED_EMAILS??'null')});}catch{return denied();}
}
