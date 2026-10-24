import{TeamPilot}from'../packages/engine/src/team-pilot.ts';
import{TeamPilotRuntime}from'../packages/engine/src/team-pilot-provider.ts';
import{teamKeyPair}from'../packages/engine/src/team-key-loader.ts';
import{approvedRuntime,envKey,runLoop}from'../apps/team-runner/entrypoints.ts';
import{dedicatedCompanyConnector}from'../apps/team-runner/playwright-connector.ts';
import{TeamOwnedBrowser}from'../packages/engine/src/team-owned-browser.ts';
import{TeamReadOnlyRuntime}from'../packages/engine/src/team-readonly-runtime.ts';
import{TeamVault}from'../packages/engine/src/team-vault.ts';import{TeamConnections}from'../packages/engine/src/team-connections.ts';
import{QueuedCompanySessionProvider}from'../packages/engine/src/team-browser-store.ts';
import{OfficialTeamNotionValidator}from'../packages/engine/src/team-providers.ts';
import{TeamPreviewQueue}from'../packages/engine/src/team-preview.ts';import{TeamBrowserRunner}from'../packages/engine/src/team-browser-runner.ts';
import{TeamWorkerDispatcher}from'../packages/engine/src/team-worker-dispatch.ts';import{TeamError}from'../packages/engine/src/team-errors.ts';
import type{NotionTransport}from'../packages/engine/src/live-notion-client.ts';
try{approvedRuntime();const {master,preview:previewKey}=teamKeyPair();if(!master||!previewKey)throw new TeamError('VAULT_UNCONFIGURED');
const transport:NotionTransport=async r=>{const response=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body?JSON.stringify(r.body):undefined,redirect:'error',signal:AbortSignal.timeout(12000)});return{status:response.status,body:await response.json()};};
const browser=new TeamOwnedBrowser(dedicatedCompanyConnector),company=new QueuedCompanySessionProvider(scope=>browser.inspect(scope));
const connections=new TeamConnections(new TeamVault(master),company,new OfficialTeamNotionValidator(transport,process.env.TEAM_PILOT_ENABLED==='true')),runtime=new TeamReadOnlyRuntime(browser,transport,previewKey);
const queue=new TeamPreviewQueue(connections,runtime),probes=new TeamBrowserRunner({ensure:async()=>{throw new TeamError('FORBIDDEN',403);},stop:async()=>{throw new TeamError('FORBIDDEN',403);}},browser,['probe']);
const dispatcher=new TeamWorkerDispatcher(queue,probes),pilot=new TeamPilot(connections,new TeamPilotRuntime(browser,transport),process.env.TEAM_PILOT_ENABLED==='true',process.env.TEAM_PILOT_WRITE_APPROVED==='true');await runLoop('worker',async()=>{await dispatcher.tick();await pilot.tick();});

}catch{console.error(JSON.stringify({code:'TEAM_RUNTIME_STOPPED'}));process.exitCode=1;}
