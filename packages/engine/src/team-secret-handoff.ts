import{TeamError}from'./team-errors.ts';
export interface SecretTarget{id:string;imageId:string;name:string;labels:Record<string,string>;running:boolean}
export function validateSecretTarget(t:SecretTarget,role:'web'|'worker',expectedImage:string){
 if(!/^[a-f0-9]{64}$/.test(t.id)||!/^sha256:[a-f0-9]{64}$/.test(expectedImage)||t.imageId!==expectedImage||t.name!==(role==='web'?'/trainer-sync-pilot-web':'/trainer-sync-team-worker')||t.labels['trainer-sync.managed']!==(role==='web'?'pilot-web-v1':'phase2-worker-v1')||t.labels['trainer-sync.pilot']!=='one-colleague-v1'||!t.running)throw new TeamError('RUNNER_SCOPE_INVALID');
 return t.id;
}
/** Fixed owned container tmpfs only. Payload is stdin, never argv/environment. */
export const SECRET_INSTALL_SOURCE="const fs=require('fs');let chunks=[];process.stdin.on('data',c=>{chunks.push(c);if(chunks.reduce((n,c)=>n+c.length,0)>64)process.exit(1);});process.stdin.on('end',()=>{let bytes=Buffer.concat(chunks);chunks.forEach(c=>c.fill(0));const dir='/run/team-secrets',created=[];try{if(process.getuid()!==0||bytes.length!==64||bytes.subarray(0,32).equals(bytes.subarray(32)))throw Error();const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||Number(fs.statfsSync(dir).type)!==0x01021994||fs.readdirSync(dir).length)throw Error();for(const [name,value]of [['master.hex',bytes.subarray(0,32)],['preview.hex',bytes.subarray(32)]]){const p=dir+'/'+name,fd=fs.openSync(p,'wx',0o400);created.push(p);try{fs.writeFileSync(fd,value.toString('hex'));fs.fchownSync(fd,1000,1000);}finally{fs.closeSync(fd);}}fs.chownSync(dir,1000,1000);fs.chmodSync(dir,0o700);process.stdout.write('TEAM_SECRET_HANDOFF_READY');}catch{for(const p of created)try{fs.unlinkSync(p);}catch{}process.exitCode=1;}finally{bytes.fill(0);}});";
export async function handoffTeamKeys(bundle:Buffer,target:SecretTarget,role:'web'|'worker',expectedImage:string,run:(args:string[],input:Buffer)=>Promise<void>){
 const id=validateSecretTarget(target,role,expectedImage);if(bundle.length!==64||bundle.subarray(0,32).equals(bundle.subarray(32)))throw new TeamError('SECRET_INVALID');
 const copy=Buffer.from(bundle);try{await run(['exec','-i','--user','0',id,'node','-e',SECRET_INSTALL_SOURCE],copy);}catch{throw new TeamError('VAULT_UNCONFIGURED');}finally{copy.fill(0);}
}
