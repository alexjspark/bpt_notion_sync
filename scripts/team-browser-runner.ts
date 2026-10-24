import{pilotSeccomp,pilotSeccompCommand,assertPilotEffectiveSeccomp}from'../apps/team-runner/browser-seccomp.ts';
import{configureWindowsPilotDatabase}from'../apps/team-runner/windows-secrets.ts';
import{approvedDockerCli}from'../apps/team-runner/docker-cli.ts';
import{approvedRuntime,runLoop}from'../apps/team-runner/entrypoints.ts';
import{DockerBrowserDriver}from'../packages/engine/src/team-browser-driver.ts';
import{peerName,type PeerRole}from'../packages/engine/src/team-browser-network.ts';
import{TeamBrowserRunner}from'../packages/engine/src/team-browser-runner.ts';import{sweepExpiredBrowsers}from'../packages/engine/src/team-browser-store.ts';
import{TeamError}from'../packages/engine/src/team-errors.ts';
try{approvedRuntime();
if(process.env.TEAM_PILOT_ENABLED==='true')await configureWindowsPilotDatabase();
if(process.env.TEAM_BROWSER_SECCOMP_APPROVED!=='true')throw new TeamError('RUNNER_SCOPE_INVALID');const security=await pilotSeccomp();
const peers=(['gateway','worker','egress'] as PeerRole[]).map(role=>({role,name:peerName(role),imageId:process.env['TEAM_'+role.toUpperCase()+'_IMAGE_ID']??''}));
const driver=new DockerBrowserDriver(pilotSeccompCommand(approvedDockerCli(process.env.TEAM_DOCKER_RUNNER_APPROVED==='true'),security.path),process.env.TEAM_BROWSER_IMAGE_ID??'',peers,undefined,value=>assertPilotEffectiveSeccomp(value,security.profile));
const runner=new TeamBrowserRunner(driver,{inspect:async()=>{throw new TeamError('FORBIDDEN',403);}},['allocate','stop']);
await runLoop('runner',async()=>{await sweepExpiredBrowsers();await runner.runOnce();});

}catch{console.error(JSON.stringify({code:'TEAM_RUNTIME_STOPPED'}));process.exitCode=1;}
