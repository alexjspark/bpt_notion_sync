import{execFile,spawn}from'node:child_process';import{promisify}from'node:util';
import{handoffTeamKeys,type SecretTarget}from'../packages/engine/src/team-secret-handoff.ts';
const run=promisify(execFile);let dispatched=false;
const unseal="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$p=Join-Path $env:LOCALAPPDATA 'TrainerSync\\team-pilot\\operator-keys.dpapi';$f=Get-Item -LiteralPath $p;if(($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $f.Length -gt 2048){throw 'INVALID'};$acl=Get-Acl -LiteralPath $p;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);if($acl.Owner -ne [Security.Principal.WindowsIdentity]::GetCurrent().Name -or @($rules|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid}).Count){throw 'INVALID'};$sealed=[IO.File]::ReadAllBytes($p);$clear=[Security.Cryptography.ProtectedData]::Unprotect($sealed,[Text.Encoding]::UTF8.GetBytes('TrainerSync-team-pilot-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);try{if($clear.Length -ne 64){throw 'INVALID'};$stream=[Console]::OpenStandardOutput();$stream.Write($clear,0,$clear.Length);$stream.Flush()}finally{[Array]::Clear($clear,0,$clear.Length)}";
async function main(){
 if(process.platform!=='win32'||process.env.TEAM_SECRET_HANDOFF_APPROVED!=='true')throw Error();
 const role=process.argv[2],image=process.argv[3];if(!['web','worker'].includes(role)||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error();
 const name=role==='web'?'trainer-sync-pilot-web':'trainer-sync-team-worker';
 const r=await run('docker',['inspect','--format','{{json .Id}} {{json .Image}} {{json .Name}} {{json .Config.Labels}} {{json .State.Running}}',name],{timeout:10000,maxBuffer:8192,windowsHide:true});
 const parts=r.stdout.trim().match(/^("[a-f0-9]{64}") ("sha256:[a-f0-9]{64}") ("[^"\r\n]+") (\{.*\}) (true|false)$/);if(!parts)throw Error();
 const target:SecretTarget={id:JSON.parse(parts[1]),imageId:JSON.parse(parts[2]),name:JSON.parse(parts[3]),labels:JSON.parse(parts[4]),running:JSON.parse(parts[5])};
 // Internal binary stdout only. Never print child results, stderr or original exceptions.
 const raw=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',unseal],{encoding:'buffer',timeout:10000,maxBuffer:2048,windowsHide:true});const bundle=raw.stdout;
 try{await handoffTeamKeys(bundle,target,role as 'web'|'worker',image,async(args,input)=>{
  dispatched=true;await new Promise<void>((resolve,reject)=>{const child=spawn('docker',args,{stdio:['pipe','ignore','ignore'],windowsHide:true});const timer=setTimeout(()=>{child.kill();reject(Error());},15000);child.on('error',()=>{clearTimeout(timer);reject(Error());});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error());});child.stdin.on('error',()=>reject(Error()));child.stdin.end(input);});
 });}finally{bundle.fill(0);}
 console.log(JSON.stringify({code:'TEAM_SECRET_HANDOFF_READY',role}));
}
main().catch(()=>{console.error(JSON.stringify({code:dispatched?'TEAM_SECRET_HANDOFF_REVIEW_REQUIRED':'TEAM_SECRET_HANDOFF_BLOCKED'}));process.exitCode=1;});
