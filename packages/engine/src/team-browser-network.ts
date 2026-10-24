import{requireUuid,TeamError}from'./team-errors.ts';
import type{BrowserScope}from'./team-browser-store.ts';
import type{DockerCommand}from'./team-browser-driver.ts';
export type PeerRole='gateway'|'worker'|'egress';
export type TrustedPeer={role:PeerRole;name:string;imageId:string};
export const tenantNetwork=(tenantId:string)=>'ts-team-net-'+requireUuid(tenantId).replaceAll('-','');
export const peerName=(role:PeerRole)=>'trainer-sync-team-'+role;
export class TenantBrowserNetwork{
 constructor(private readonly execute:DockerCommand,readonly peers:readonly TrustedPeer[]){
  if(peers.length!==3||new Set(peers.map(p=>p.role)).size!==3||peers.some(p=>!['gateway','worker','egress'].includes(p.role)||p.name!==peerName(p.role)||!/^sha256:[a-f0-9]{64}$/.test(p.imageId)))throw new TeamError('RUNNER_SCOPE_INVALID');
 }
 private async command(args:readonly string[]){const r=await this.execute(args);if(r.exitCode!==0)throw new TeamError('RUNNER_UNAVAILABLE');return r.stdout;}
 async ensure(scope:BrowserScope,container:string){
  if(container!=='ts-team-browser-'+requireUuid(scope.sessionId).replaceAll('-',''))throw new TeamError('RUNNER_SCOPE_INVALID');
  const network=tenantNetwork(scope.tenantId),names=(await this.command(['network','ls','--filter','name=^'+network+'$','--format','{{.Name}}'])).trim();
  if(names&&names!==network)throw new TeamError('RUNNER_SCOPE_INVALID');
  if(!names)await this.command(['network','create','--driver','bridge','--internal','--label','trainer-sync.managed=phase2-network-v1','--label','trainer-sync.tenant='+scope.tenantId,network]);
  const raw=await this.command(['network','inspect','--format','{"internal":{{json .Internal}},"managed":{{json (index .Labels "trainer-sync.managed")}},"tenant":{{json (index .Labels "trainer-sync.tenant")}},"containers":{{json .Containers}}}',network]);
  // Docker maps use string IDs, so use native JSON Containers rather than map comma templating.
  let m:{internal:boolean;managed:string;tenant:string;containers:Record<string,{Name:string}>};
  try{m=JSON.parse(raw);}catch{throw new TeamError('RUNNER_UNAVAILABLE');}
  const members=Object.values(m.containers??{}).map(v=>v.Name);
  const allowed=[container,...this.peers.map(p=>p.name)];
  if(!m.internal||m.managed!=='phase2-network-v1'||m.tenant!==scope.tenantId||!m.containers||members.some(n=>!allowed.includes(n)))throw new TeamError('RUNNER_SCOPE_INVALID');
  for(const p of this.peers){
   const text=await this.command(['inspect','--type','container','--format','{"managed":{{json (index .Config.Labels "trainer-sync.managed")}},"image":{{json .Image}},"user":{{json .Config.User}},"privileged":{{json .HostConfig.Privileged}},"ports":{{json .HostConfig.PortBindings}},"networkMode":{{json .HostConfig.NetworkMode}},"capAdd":{{json .HostConfig.CapAdd}},"mounts":{{json .Mounts}}}',p.name]);
   let meta:{managed:string;image:string;user:string;privileged:boolean;ports:Record<string,unknown>|null;networkMode:string;capAdd:unknown[]|null;mounts:Array<{Type:string;Source?:string;Destination:string}>};try{meta=JSON.parse(text);}catch{throw new TeamError('RUNNER_UNAVAILABLE');}
   if(meta.managed!=='phase2-'+p.role+'-v1'||meta.image!==p.imageId||!meta.user||/^(?:root|0)(?::|$)/.test(meta.user)||meta.privileged!==false||Object.keys(meta.ports??{}).length>0||typeof meta.networkMode!=='string'||meta.networkMode==='host'||meta.networkMode.startsWith('container:')||(meta.capAdd??[]).length>0||!Array.isArray(meta.mounts)||meta.mounts.some(m=>!(['worker','gateway','egress'].includes(p.role)&&m.Type==='tmpfs'&&m.Destination==='/run/team-secrets'&&!m.Source)))throw new TeamError('RUNNER_SCOPE_INVALID');
   if(!members.includes(p.name))await this.command(['network','connect',...(p.role==='egress'?['--alias','ts-team-egress']:[]),network,p.name]);
  }
 }
}
