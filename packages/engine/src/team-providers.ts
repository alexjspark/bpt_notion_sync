import { TeamError,requireUuid } from './team-errors.ts';
import { OfficialNotionClient,type NotionTransport,object } from './live-notion-client.ts';
export interface TeamDestination{databaseId:string;dataSourceId:string;templateId:string}
export interface CompanyBinding{accountId:string;trainerId:string}
export interface CompanySessionProvider{
 readonly available:boolean;
 begin(scope:{tenantId:string;sessionId:string}):Promise<{handle:string}>;
 inspect(scope:{tenantId:string;sessionId:string;handle:string}):Promise<CompanyBinding>;
 revoke(scope:{tenantId:string;sessionId:string;handle:string}):Promise<void>;
}
export class UnconfiguredCompanyProvider implements CompanySessionProvider{
 readonly available=false;
 async begin():Promise<never>{throw new TeamError('PROVIDER_UNAVAILABLE');}
 async inspect():Promise<never>{throw new TeamError('PROVIDER_UNAVAILABLE');}
 async revoke():Promise<never>{throw new TeamError('PROVIDER_UNAVAILABLE');}
}
export function validateBinding(v:CompanyBinding):CompanyBinding{
 if(!v||!['accountId','trainerId'].every(k=>typeof v[k as keyof CompanyBinding]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v[k as keyof CompanyBinding])))throw new TeamError('ACCOUNT_UNVERIFIED');
 return{accountId:v.accountId,trainerId:v.trainerId};
}
export function destination(v:unknown):TeamDestination{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new TeamError('INVALID_INPUT',400);
 const d=v as Record<string,unknown>;if(Object.keys(d).some(k=>!['databaseId','dataSourceId','templateId'].includes(k)))throw new TeamError('INVALID_INPUT',400);
 return{databaseId:requireUuid(d.databaseId),dataSourceId:requireUuid(d.dataSourceId),templateId:requireUuid(d.templateId)};
}
export interface TeamNotionValidator{validate(token:string,destination:TeamDestination):Promise<void>}
const same=(a:unknown,b:string)=>typeof a==='string'&&a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
/** Read-only official contracts; caller explicitly supplies transport and credentials. No automatic connection. */
export class OfficialTeamNotionValidator implements TeamNotionValidator{
 constructor(private readonly transport:NotionTransport){}
 async validate(token:string,d:TeamDestination):Promise<void>{
  const client=new OfficialNotionClient({token,transport:this.transport,readPermit:{approved:true},maxRateLimitRetries:0});
  const db=await client.read('/databases/'+d.databaseId);
  if(db.in_trash||db.archived||!Array.isArray(db.data_sources)||!db.data_sources.some((s:unknown)=>same(object(s).id,d.dataSourceId)))throw new TeamError('DESTINATION_INVALID');
  const ds=await client.read('/data_sources/'+d.dataSourceId);
  const parent=object(ds.parent),props=object(ds.properties);
  if(ds.in_trash||ds.archived||!same(parent.database_id,d.databaseId)||!Object.values(props).some(p=>object(p).type==='title'))throw new TeamError('DESTINATION_INVALID');
  let cursor:string|undefined;const seen=new Set<string>();
  for(let n=0;n<20;n++){
   const r=await client.read('/data_sources/'+d.dataSourceId+'/templates',{page_size:'100',...(cursor?{start_cursor:cursor}:{})});
   if(!Array.isArray(r.templates))throw new TeamError('DESTINATION_INVALID');
   if(r.templates.some((t:unknown)=>same(object(t).id,d.templateId)))return;
   if(!r.has_more)break;
   if(typeof r.next_cursor!=='string'||seen.has(r.next_cursor))throw new TeamError('DESTINATION_INVALID');
   cursor=r.next_cursor;seen.add(cursor);
  }
  throw new TeamError('DESTINATION_INVALID');
 }
}
export interface TeamPreviewSummary{members:number;matched:number;held:number;creates:number;updates:number}
export function safeSummary(v:TeamPreviewSummary):TeamPreviewSummary{
 const out:Record<string,number>={};for(const k of ['members','matched','held','creates','updates'] as const){
  if(!Number.isSafeInteger(v[k])||v[k]<0||v[k]>100000)throw new TeamError('PREVIEW_FAILED');out[k]=v[k];
 }return out as unknown as TeamPreviewSummary;
}
export interface TeamPreviewProvider{
 readonly available:boolean;
 /** Must be read-only; each call gets its own tenant/revision credentials, never a shared default. */
 preview(input:{tenantId:string;connectionId:string;revision:number;sessionId:string;handle:string;binding:CompanyBinding;destination:TeamDestination;token:string;assertCurrent:()=>Promise<void>}):Promise<TeamPreviewSummary>;
}
export class UnconfiguredPreviewProvider implements TeamPreviewProvider{
 readonly available=false;
 async preview():Promise<never>{throw new TeamError('PROVIDER_UNAVAILABLE');}
}
/** Bounded per-scope cache; no tenant-free key or fallback. Eviction destroys adapter references. */
export class TeamRuntimeCache<T>{
 private readonly items=new Map<string,T>();
 constructor(private readonly limit=32){}
 get(scope:{tenantId:string;connectionId:string;revision:number},make:()=>T):T{
  const t=requireUuid(scope.tenantId),c=requireUuid(scope.connectionId);if(!Number.isSafeInteger(scope.revision)||scope.revision<1)throw new TeamError('INVALID_INPUT',400);
  const key=JSON.stringify([t,c,scope.revision]);let v=this.items.get(key);
  if(v===undefined){for(const k of this.items.keys())if(k.startsWith(JSON.stringify([t,c]).slice(0,-1)+','))this.items.delete(k);v=make();this.items.set(key,v);if(this.items.size>this.limit)this.items.delete(this.items.keys().next().value!);}
  return v;
 }
 invalidate(tenantId:string){for(const key of this.items.keys())if(JSON.parse(key)[0]===tenantId)this.items.delete(key);}
}
