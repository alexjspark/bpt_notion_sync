import{spawnSync}from'node:child_process';
/** Checks only the Chrome process launched by this test process; never returns command lines. */
export function assertPhysicalClientArguments(lines:readonly unknown[]){
 if(!lines.length||lines.some(v=>typeof v!=='string'||!v.trim()))throw Error('PHYSICAL_CLIENT_ARGUMENTS_UNAVAILABLE');
 const forbidden=/(^|[\s"])--(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox)(?:[=\s"]|$)/i;
 if(lines.some(v=>forbidden.test(v as string)))throw Error('PHYSICAL_CLIENT_SANDBOX_DISABLED');return{checkedProcesses:lines.length,sandboxDisabled:false};
}
export function verifyRunningPhysicalClientSandbox(){
 if(process.platform!=='win32')throw Error('PHYSICAL_WINDOWS_CLIENT_GUARD_REQUIRED');
 const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$rows=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ParentProcessId -eq "+process.pid+" });ConvertTo-Json -InputObject @($rows | ForEach-Object { $_.CommandLine }) -Compress";
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','ignore']});
 if(r.status!==0)throw Error('PHYSICAL_CLIENT_ARGUMENTS_UNAVAILABLE');let lines;try{lines=JSON.parse(r.stdout);}catch{throw Error('PHYSICAL_CLIENT_ARGUMENTS_UNAVAILABLE');}
 if(!Array.isArray(lines))throw Error('PHYSICAL_CLIENT_ARGUMENTS_UNAVAILABLE');return assertPhysicalClientArguments(lines);
}
