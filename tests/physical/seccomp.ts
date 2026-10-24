import{createHash}from'node:crypto';import{lstat,readFile,realpath}from'node:fs/promises';import{fileURLToPath}from'node:url';import type{DockerCommand}from'../../packages/engine/src/team-browser-driver.ts';
export const PHYSICAL_SECCOMP_SHA256='cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849';
export const PHYSICAL_SECCOMP_PATH=fileURLToPath(new URL('../../docker/playwright-seccomp.json',import.meta.url));
export function approvedProfileBytes(bytes:Uint8Array){if(createHash('sha256').update(bytes).digest('hex')!==PHYSICAL_SECCOMP_SHA256)throw Error('PHYSICAL_SECCOMP_CHANGED');}
export async function verifiedPhysicalProfile(){const path=PHYSICAL_SECCOMP_PATH,stat=await lstat(path);if(stat.isSymbolicLink()||!stat.isFile()||await realpath(path)!==path)throw Error('PHYSICAL_SECCOMP_PATH_INVALID');approvedProfileBytes(await readFile(path));return path;}
export function approvedPhysicalCreateArgs(input:readonly string[],profile:string){
 if(profile!==PHYSICAL_SECCOMP_PATH)throw Error('PHYSICAL_SECCOMP_PATH_INVALID');
 const name=input[input.indexOf('--name')+1],managed=input.find(v=>v.startsWith('trainer-sync.managed=')),image=input.at(-1);
 if(input[0]!=='create'||!/^ts-team-browser-[a-f0-9]{32}$/.test(name??'')||managed!=='trainer-sync.managed=phase2-browser-v1'||input[input.indexOf('--user')+1]!=='pwuser'||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('PHYSICAL_SECCOMP_SCOPE_INVALID');
 if(input.some(v=>/^(?:--security-opt|--cap-add|--privileged|--entrypoint)(?:=|$)/.test(v)||/^(?:--no-sandbox|seccomp=|unconfined$)/.test(v)))throw Error('PHYSICAL_SECURITY_OVERRIDE_REJECTED');
 return[...input.slice(0,-1),'--security-opt','seccomp='+profile,image!];
}
/** Test runner only. No production driver, operating browser or daemon setting changes. */
export function withApprovedPhysicalSeccomp(execute:DockerCommand,verify:()=>Promise<string>=verifiedPhysicalProfile):DockerCommand{
 return async input=>input[0]==='create'?execute(approvedPhysicalCreateArgs(input,await verify())):execute(input);
}
