import{resolve}from'node:path';import{fileURLToPath}from'node:url';import{existsSync}from'node:fs';
import{query,closeDb}from'@trainer/db';import{physicalConfig,PHYSICAL_KEY,type PhysicalConfig}from'./config.ts';
import{seedPhysical,verifyPhysicalMarker,physicalWebServices,physicalPreview,mockNotionValidator}from'./services.ts';
import{createPhysicalWeb,createPhysicalIngress,createPhysicalDenyEgress}from'./servers.ts';import{physicalInspector}from'./browser.ts';
import{createTeamBrowserGateway,productionGatewayAuthorizer}from'../../packages/engine/src/team-browser-gateway.ts';import{TeamAuth}from'../../packages/engine/src/team-auth.ts';
import{TeamVault}from'../../packages/engine/src/team-vault.ts';import{TeamConnections}from'../../packages/engine/src/team-connections.ts';import{QueuedCompanySessionProvider,sweepExpiredBrowsers}from'../../packages/engine/src/team-browser-store.ts';
import{TeamPreviewQueue}from'../../packages/engine/src/team-preview.ts';import{TeamBrowserRunner}from'../../packages/engine/src/team-browser-runner.ts';
import{TeamWorkerDispatcher,runtimeHeartbeat}from'../../packages/engine/src/team-worker-dispatch.ts';import{runLoop,listenService}from'../../apps/team-runner/entrypoints.ts';
import{DockerBrowserDriver}from'../../packages/engine/src/team-browser-driver.ts';import{peerName}from'../../packages/engine/src/team-browser-network.ts';import{approvedDockerCli}from'../../apps/team-runner/docker-cli.ts';
import{physicalJournalStore}from'./journal-file.ts';import{guardedPhysicalDocker}from'./runner-guard.ts';
async function listenLocalRole(config:PhysicalConfig,service:ReturnType<typeof createPhysicalWeb>|ReturnType<typeof createPhysicalIngress>,port:number){
 if(process.platform!=='linux'||!existsSync('/.dockerenv'))throw Error('PHYSICAL_CONTAINER_REQUIRED');
 await new Promise<void>(r=>service.server.listen(port,'0.0.0.0',r));
 const stop=async()=>{service.closeConnections();service.server.close();await closeDb();};process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
}
export async function physicalMain(env:Record<string,string|undefined>){
 const config=physicalConfig(env);if(env!==process.env||process.env.DATABASE_URL!==config.databaseUrl||!process.argv[1]||resolve(process.argv[1])!==fileURLToPath(import.meta.url))throw Error('PHYSICAL_FRESH_PROCESS_REQUIRED');
 if(config.role==='web'||config.role==='seed')await seedPhysical(config);else await verifyPhysicalMarker(config);
 if(config.role==='seed'){await closeDb();return;}
 if(config.role==='web'){await listenLocalRole(config,createPhysicalWeb(config,physicalWebServices(config)),3000);return;}
 if(config.role==='ingress'){await listenLocalRole(config,createPhysicalIngress(),4316);return;}
 if(config.role==='gateway'){await listenService('gateway',createTeamBrowserGateway({origin:config.origin,authorize:productionGatewayAuthorizer(new TeamAuth())}),4315);return;}
 if(config.role==='egress'){await listenService('egress',createPhysicalDenyEgress(),3128);return;}
 if(config.role==='runner'){
  const peers=(['gateway','worker','egress']as const).map(role=>({role,name:peerName(role),imageId:env['PHYSICAL_'+role.toUpperCase()+'_IMAGE_ID']??''}));
  const cli=guardedPhysicalDocker(config.runId,physicalJournalStore(process.cwd(),config.runId),approvedDockerCli(env.TEAM_DOCKER_RUNNER_APPROVED==='true'));
  const driver=new DockerBrowserDriver(cli,env.PHYSICAL_BROWSER_IMAGE_ID??'',peers),runner=new TeamBrowserRunner(driver,{inspect:async()=>{throw Error('PHYSICAL_RUNNER_NO_ACCOUNT_READ');}},['allocate','stop']);
  await runLoop('runner',async()=>{await verifyPhysicalMarker(config);await sweepExpiredBrowsers();await runner.runOnce();});return;
 }
 const inspector=physicalInspector(config),company=new QueuedCompanySessionProvider(scope=>inspector.inspect(scope)),connections=new TeamConnections(new TeamVault(PHYSICAL_KEY,'physical-test-only'),company,mockNotionValidator(config));
 const queue=new TeamPreviewQueue(connections,physicalPreview(config)),probes=new TeamBrowserRunner({ensure:async()=>{throw Error('PHYSICAL_WORKER_NO_DOCKER');},stop:async()=>{throw Error('PHYSICAL_WORKER_NO_DOCKER');}},inspector,['probe']);
 const dispatcher=new TeamWorkerDispatcher(queue,probes);await runtimeHeartbeat('worker',true);await runLoop('worker',async()=>{await verifyPhysicalMarker(config);await dispatcher.tick();});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void physicalMain(process.env).catch(()=>{console.error(JSON.stringify({code:'PHYSICAL_TEST_STOPPED'}));process.exitCode=1;});
}
