import {requireUuid} from './team-errors.ts';
export interface CloudflarePilotAccess {teamName:string; audience:string; tunnelId:string; allowedEmails:string[]}
const fail=():never=>{throw Error('PILOT_CLOUDFLARE_INPUT_INVALID');};
export function validateCloudflareAccess(raw:unknown):CloudflarePilotAccess {
 const v=raw as CloudflarePilotAccess;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='allowedEmails,audience,teamName,tunnelId')fail();
 if(typeof v.teamName!=='string'||! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v.teamName)||typeof v.audience!=='string'||! /^[a-f0-9]{64}$/.test(v.audience))fail();
 requireUuid(v.tunnelId);
 if(!Array.isArray(v.allowedEmails)||v.allowedEmails.length!==2||v.allowedEmails.some(x=>typeof x!=='string'||x.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(x))||new Set(v.allowedEmails).size!==2)fail();
 return structuredClone(v);
}
/** Review artifacts only: no account/API/DNS/credential operations. */
export function cloudflareAccessPlan(v:CloudflarePilotAccess,origin:string,ingressPort:number){
 validateCloudflareAccess(v);const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:'||u.port||u.hostname.endsWith('.ts.net')||u.hostname.endsWith('.trycloudflare.com')||!Number.isInteger(ingressPort)||ingressPort<1024||ingressPort>65535)fail();
 const issuer='https://'+v.teamName+'.cloudflareaccess.com';
 const credentialFile='C:/ProgramData/TrainerSync/team-pilot/cloudflared/'+v.tunnelId+'.json';
 const tunnelYaml=['# PREPARATION ONLY; installation, credential and publication approval pending','tunnel: '+v.tunnelId,'credentials-file: '+JSON.stringify(credentialFile),'protocol: http2','no-autoupdate: true','metrics: 127.0.0.1:0','ingress:','  - hostname: '+u.hostname,'    service: http://127.0.0.1:'+ingressPort,'    originRequest:','      httpHostHeader: '+u.host,'      access:','        required: true','        teamName: '+v.teamName,'        audTag:','          - '+v.audience,'  - service: http_status:404',''].join('\n');
 return {kind:'web' as const,provider:'cloudflare-access' as const,origin,upstream:'http://127.0.0.1:'+ingressPort,requiresDeviceApp:false,activationApproved:false,credentialFile,tunnelYaml,
  accessReview:{type:'self_hosted',domain:u.hostname,sessionDuration:'1h',loginMethod:'one-time-pin',allowedEmails:v.allowedEmails,allowAnyEmailDomain:false,bypassPolicies:false,serviceTokenPolicies:false,cookie:{httpOnly:true,sameSite:'lax'},cacheBypass:'entire hostname; no analytics or content-transform injections'},
  ingressEnvironment:{TEAM_ACCESS_PROVIDER:'cloudflare-access',TEAM_WEB_ACCESS_APPROVED:'false',TEAM_CF_TEAM_NAME:v.teamName,TEAM_CF_AUDIENCE:v.audience,TEAM_CF_ALLOWED_EMAILS:JSON.stringify(v.allowedEmails)},
  jwksUrl:issuer+'/cdn-cgi/access/certs',requirements:['Cloudflare account and owned active DNS zone','exact operator and colleague emails','Access application/policy FIRST; no route before negative tests','reviewed Windows connector binary and private tunnel credential','outbound TCP7844 and HTTPS443; no inbound/router rule','real HTTPS/WS and unauthenticated denial verification before provider login']};
}
