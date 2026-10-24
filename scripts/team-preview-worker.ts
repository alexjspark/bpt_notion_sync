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
try{approvedRuntime();const master=envKey('TEAM_VAULT_MASTER_KEY'),previewKey=envKey('TEAM_PREVIEW_HMAC_KEY');if(master.equals(previewKey))throw new TeamError('SECRET_INVALID');
const transport:NotionTransport=async r=>{const response=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body?JSON.stringify(r.body):undefined,redirect:'error',signal:AbortSignal.timeout(12000)});return{status:response.status,body:await response.json()};};
const browser=new TeamOwnedBrowser(dedicatedCompanyConnector),company=new QueuedCompanySessionProvider(scope=>browser.inspect(scope));
const connections=new TeamConnections(new TeamVault(master),company,new OfficialTeamNotionValidator(transport)),runtime=new TeamReadOnlyRuntime(browser,transport,previewKey);
const queue=new TeamPreviewQueue(connections,runtime),probes=new TeamBrowserRunner({ensure:async()=>{throw new TeamError('FORBIDDEN',403);},stop:async()=>{throw new TeamError('FORBIDDEN',403);}},browser,['probe']);
const dispatcher=new TeamWorkerDispatcher(queue,probes);await runLoop('worker',()=>dispatcher.tick());

}catch{console.error(JSON.stringify({code:'TEAM_RUNTIME_STOPPED'}));process.exitCode=1;}
