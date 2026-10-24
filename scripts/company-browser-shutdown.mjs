/** Preserve failure status; let Chromium release its profile before tearing down its display. */
export function createBrowserShutdown({closeServer,sockets,children,graceMs=1000,getBrowser=()=>undefined,browserGraceMs=6000,onDiagnostic=()=>{}}){
 let stopping=false;
 return{isStopping:()=>stopping,stop(code=0){
  if(stopping)return;stopping=true;process.exitCode=code;closeServer();for(const socket of sockets)socket.destroy();
  const browser=getBrowser();let finished=false,timer;
  const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);for(const child of[...children].reverse())if(child!==browser)child.kill('SIGTERM');setTimeout(()=>process.exit(code),graceMs).unref();};
  if(!browser||browser.exitCode!==null||browser.signalCode!==null){finish();return;}
  browser.once('exit',finish);timer=setTimeout(()=>{onDiagnostic('BROWSER_SHUTDOWN_FORCED');browser.kill('SIGKILL');finish();},Math.max(1,Math.min(6000,browserGraceMs)));
  try{if(!browser.kill('SIGTERM'))finish();}catch{finish();}
 }};
}
