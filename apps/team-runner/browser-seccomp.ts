import{createHash}from'node:crypto';import{lstat,readFile,realpath}from'node:fs/promises';import{fileURLToPath}from'node:url';import type{DockerCommand}from'../../packages/engine/src/team-browser-driver.ts';import{TeamError}from'../../packages/engine/src/team-errors.ts';
export const PILOT_SECCOMP_SHA256='cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
export const PILOT_SECCOMP_PATH=fileURLToPath(new URL('../../docker/playwright-seccomp.json',import.meta.url));
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export async function pilotSeccomp(){const stat=await lstat(PILOT_SECCOMP_PATH);if(stat.isSymbolicLink()||!stat.isFile()||await realpath(PILOT_SECCOMP_PATH)!==PILOT_SECCOMP_PATH)throw new TeamError('RUNNER_SCOPE_INVALID');const bytes=await readFile(PILOT_SECCOMP_PATH);if(createHash('sha256').update(bytes).digest('hex')!==PILOT_SECCOMP_SHA256)throw new TeamError('RUNNER_SCOPE_INVALID');return{path:PILOT_SECCOMP_PATH,profile:JSON.parse(bytes.toString('utf8'))};}
export function assertPilotEffectiveSeccomp(actual:unknown,profile:unknown){
 if(!Array.isArray(actual)||actual.length!==1||typeof actual[0]!=='string'||!actual[0].startsWith('seccomp='))throw new TeamError('RUNNER_SCOPE_INVALID');
 try{if(canonical(JSON.parse(actual[0].slice(8)))!==canonical(profile))throw Error();}catch{throw new TeamError('RUNNER_SCOPE_INVALID');}
}
export function pilotSeccompCommand(execute:DockerCommand,profilePath:string):DockerCommand{
 if(profilePath!==PILOT_SECCOMP_PATH)throw new TeamError('RUNNER_SCOPE_INVALID');
 return async args=>{
  if(args[0]!=='create')return execute(args);
  if(!/^ts-team-browser-[a-f0-9]{32}$/.test(args[args.indexOf('--name')+1]??'')||args[args.indexOf('--user')+1]!=='pwuser'||!args.includes('trainer-sync.managed=phase2-browser-v1')||!/^sha256:[a-f0-9]{64}$/.test(args.at(-1)??'')||args.some(v=>/^(--security-opt|--cap-add|--privileged|--entrypoint|--no-sandbox)(=|$)/.test(v)||v==='unconfined'))throw new TeamError('RUNNER_SCOPE_INVALID');
  return execute([...args.slice(0,-1),'--security-opt','seccomp='+profilePath,args.at(-1)!]);
 };
}
