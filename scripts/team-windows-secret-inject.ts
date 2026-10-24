import{execFile,spawn}from'node:child_process';import{promisify}from'node:util';import{deliverPilotSecrets,validatePilotSecretTarget,type PilotSecretRole}from'../packages/engine/src/pilot-secret-delivery.ts';import{unsealPilotStore}from'../apps/team-runner/windows-secrets.ts';import type{SecretTarget}from'../packages/engine/src/team-secret-handoff.ts';
const run=promisify(execFile);let dispatched=false;
async function main(){
 if(process.platform!=='win32'||process.env.TEAM_SECRET_HANDOFF_APPROVED!=='true'||process.env.TEAM_PILOT_DATABASE_APPROVED!=='true')throw Error();
 const role=process.argv[2]as PilotSecretRole,image=process.argv[3],deploymentId=process.argv[4];if(!['web','worker','gateway','egress','db'].includes(role)||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error();
 const name=role==='web'?'trainer-sync-pilot-web':role==='db'?'trainer-sync-pilot-db':'trainer-sync-team-'+role;
 const r=await run('docker',['inspect','--format','{{json .Id}} {{json .Image}} {{json .Name}} {{json .Config.Labels}} {{json .State.Running}}',name],{timeout:10000,maxBuffer:8192,windowsHide:true});
 const p=r.stdout.trim().match(/^("[a-f0-9]{64}") ("sha256:[a-f0-9]{64}") ("[^"\r\n]+") (\{.*\}) (true|false)$/);if(!p)throw Error();const target:SecretTarget={id:JSON.parse(p[1]),imageId:JSON.parse(p[2]),name:JSON.parse(p[3]),labels:JSON.parse(p[4]),running:JSON.parse(p[5])};validatePilotSecretTarget(target,role,image,deploymentId);
 const password=await unsealPilotStore('database');let keys:Buffer|undefined;
 try{if(['web','worker'].includes(role))keys=await unsealPilotStore('keys');await deliverPilotSecrets(target,role,image,password,keys,async(args,payload)=>{dispatched=true;await new Promise<void>((resolve,reject)=>{const child=spawn('docker',args,{stdio:['pipe','ignore','ignore'],windowsHide:true});const timer=setTimeout(()=>{child.kill();reject(Error());},15000);child.on('error',()=>{clearTimeout(timer);reject(Error());});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error());});child.stdin.on('error',()=>reject(Error()));child.stdin.end(payload);});},deploymentId);}finally{password.fill(0);keys?.fill(0);}
 console.log(JSON.stringify({code:'PILOT_SECRET_HANDOFF_READY',role}));
}
main().catch(()=>{console.error(JSON.stringify({code:dispatched?'PILOT_SECRET_HANDOFF_REVIEW_REQUIRED':'PILOT_SECRET_HANDOFF_BLOCKED'}));process.exitCode=1;});
