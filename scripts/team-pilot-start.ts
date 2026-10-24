import{spawn}from'node:child_process';import{teamKeyPair}from'../packages/engine/src/team-key-loader.ts';import{waitForPilotKeys}from'../packages/engine/src/team-key-start.ts';import{approvedRuntime,requireRuntimeSchema}from'../apps/team-runner/entrypoints.ts';
try{approvedRuntime();if(process.env.TEAM_PILOT_ENABLED!=='true'||process.platform!=='linux')throw Error();
 const role=process.argv[2];if(!['web','worker'].includes(role))throw Error();await waitForPilotKeys(()=>teamKeyPair(),ms=>new Promise(r=>setTimeout(r,ms)));await requireRuntimeSchema();
 // This entrypoint never migrates/seeds a database or creates a key. Operator injection must finish first.
 const args=role==='web'?['node_modules/next/dist/bin/next','start','apps/web','--hostname','0.0.0.0','--port','3000']:['--import','tsx','scripts/team-preview-worker.ts'];
 const child=spawn(process.execPath,args,{stdio:'inherit'});for(const sig of ['SIGTERM','SIGINT']as const)process.once(sig,()=>child.kill(sig));child.on('exit',code=>{process.exitCode=code??1;});child.on('error',()=>{process.exitCode=1;});
}catch{console.error(JSON.stringify({code:'TEAM_PILOT_START_BLOCKED'}));process.exitCode=1;}
