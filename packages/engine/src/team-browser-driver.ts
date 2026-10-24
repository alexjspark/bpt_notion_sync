import{TenantBrowserNetwork,tenantNetwork,type TrustedPeer}from'./team-browser-network.ts';
import{requireUuid,TeamError}from'./team-errors.ts';
import type{BrowserScope}from'./team-browser-store.ts';
export const TEAM_BROWSER_PROFILE='/var/lib/trainer-sync/company-profile';
export const browserNames=(scope:BrowserScope)=>({container:'ts-team-browser-'+requireUuid(scope.sessionId).replaceAll('-',''),volume:'ts-team-profile-'+requireUuid(scope.tenantId).replaceAll('-','')});
export type DockerCommand=(args:readonly string[])=>Promise<{exitCode:number;stdout:string}>;
export interface BrowserDriver{ensure(scope:BrowserScope):Promise<{ready:boolean}>;stop(scope:BrowserScope):Promise<void>}
type Meta={tenant:string;session:string;managed:string;image:string;user:string;running:boolean;privileged:boolean;capAdd:unknown[]|null;pidMode:string;health:string;mounts:Array<{Type:string;Name:string;Destination:string}>;ports:Record<string,unknown>|null;networks:Record<string,unknown>;securityOpt?:unknown};
const metadata='{"tenant":{{json (index .Config.Labels "trainer-sync.tenant")}},"session":{{json (index .Config.Labels "trainer-sync.session")}},"managed":{{json (index .Config.Labels "trainer-sync.managed")}},"image":{{json .Image}},"user":{{json .Config.User}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"pidMode":{{json .HostConfig.PidMode}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"missing"{{end}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}},"securityOpt":{{json .HostConfig.SecurityOpt}}}';
export function browserCreateArgs(scope:BrowserScope,imageId:string):string[]{
 if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new TeamError('RUNNER_SCOPE_INVALID');
 const n=browserNames(scope);
 return['create','--pull=never','--name',n.container,'--label','trainer-sync.managed=phase2-browser-v1','--label','trainer-sync.tenant='+scope.tenantId,'--label','trainer-sync.session='+scope.sessionId,'--network',tenantNetwork(scope.tenantId),'--network-alias',n.container,'--mount','type=volume,source='+n.volume+',target='+TEAM_BROWSER_PROFILE,'--user','pwuser','--init','--shm-size','1g','--restart','no','--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=3','--env','TEAM_COMPANY_PROXY=true','--env','TEAM_BROWSER_INTERNAL_HOST='+n.container,'--health-cmd','node -e "fetch(\'http://127.0.0.1:9223/json/version\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"','--health-interval','3s','--health-start-period','20s','--health-retries','10',imageId];
}
/** Privileged runner-only dependency injection. No CLI/process execution is imported into web code. */
export class DockerBrowserDriver implements BrowserDriver{
 constructor(private readonly execute:DockerCommand,private readonly imageId:string,private readonly peers:readonly TrustedPeer[],private readonly pause:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms)),private readonly assertSecurity?:(value:unknown)=>void){
  if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new TeamError('RUNNER_SCOPE_INVALID');
  new TenantBrowserNetwork(execute,peers);
 }
 private async command(args:readonly string[]){const r=await this.execute(args);if(r.exitCode!==0)throw new TeamError('RUNNER_UNAVAILABLE');return r.stdout;}
 private async inspect(scope:BrowserScope,checkSecurity=true):Promise<Meta|null>{
  const n=browserNames(scope),listed=(await this.command(['container','ls','-a','--filter','name=^'+n.container+'$','--format','{{.Names}}'])).trim();
  if(!listed)return null;if(listed!==n.container)throw new TeamError('RUNNER_SCOPE_INVALID');
  let m:Meta;try{m=JSON.parse(await this.command(['inspect','--type','container','--format',metadata,n.container]));}catch{throw new TeamError('RUNNER_UNAVAILABLE');}
  if(m.managed!=='phase2-browser-v1'||m.tenant!==scope.tenantId||m.session!==scope.sessionId||m.image!==this.imageId||m.user!=='pwuser'||m.privileged!==false||(m.capAdd??[]).length>0||m.pidMode==='host'||Object.keys(m.ports??{}).length||!Array.isArray(m.mounts)||m.mounts.length!==1||m.mounts[0]!.Type!=='volume'||m.mounts[0]!.Name!==n.volume||m.mounts[0]!.Destination!==TEAM_BROWSER_PROFILE||!m.networks||Object.keys(m.networks).length!==1||!Object.hasOwn(m.networks,tenantNetwork(scope.tenantId)))throw new TeamError('RUNNER_SCOPE_INVALID');
  if(checkSecurity)this.assertSecurity?.(m.securityOpt);return m;
 }
 private async volume(scope:BrowserScope){
  const n=browserNames(scope),listed=(await this.command(['volume','ls','--filter','name=^'+n.volume+'$','--format','{{.Name}}'])).trim();
  if(listed&&listed!==n.volume)throw new TeamError('RUNNER_SCOPE_INVALID');
  if(!listed){await this.command(['volume','create','--driver','local','--label','trainer-sync.managed=phase2-profile-v1','--label','trainer-sync.tenant='+scope.tenantId,n.volume]);return;}
  const labels=await this.command(['volume','inspect','--format','{{index .Labels "trainer-sync.managed"}}|{{index .Labels "trainer-sync.tenant"}}',n.volume]);
  if(labels.trim()!=='phase2-profile-v1|'+scope.tenantId)throw new TeamError('RUNNER_SCOPE_INVALID');
 }
 async ensure(scope:BrowserScope){
  const n=browserNames(scope);await new TenantBrowserNetwork(this.execute,this.peers).ensure(scope,n.container);let m=await this.inspect(scope);
  if(!m){await this.volume(scope);await this.command(browserCreateArgs(scope,this.imageId));m=await this.inspect(scope);if(!m)throw new TeamError('RUNNER_UNAVAILABLE');}
  if(!m.running)await this.command(['start',n.container]);
  for(let i=0;i<10;i++){m=await this.inspect(scope);if(!m)throw new TeamError('RUNNER_UNAVAILABLE');if(m.running&&m.health==='healthy')return{ready:true};if(m.health==='unhealthy')throw new TeamError('RUNNER_UNAVAILABLE');await this.pause(500);}
  return{ready:false};
 }
 async stop(scope:BrowserScope){
  const n=browserNames(scope),m=await this.inspect(scope,false);if(!m)return;
  if(m.running)await this.command(['stop','--time','10',n.container]);
  const stopped=await this.inspect(scope,false);if(stopped?.running)throw new TeamError('RUNNER_UNAVAILABLE');
  if(stopped)await this.command(['rm',n.container]);if(await this.inspect(scope,false))throw new TeamError('RUNNER_UNAVAILABLE');
  // Persistent tenant profile is retained; no force, -v, bind paths, Docker socket or volume deletion.
 }
}
