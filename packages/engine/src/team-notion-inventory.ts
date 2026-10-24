import{OfficialNotionClient,object,collectNotionPages,type NotionTransport}from'./live-notion-client.ts';
import type{TeamDestination}from'./team-providers.ts';import type{NotionPartialPreviewInventory}from'./live-notion-types.ts';
import{verifyWithdrawalStatusMapping,type VerifiedWithdrawalStatusMapping}from'./withdrawal-plan.ts';import{planCompanyUidFill}from'./company-uid.ts';
import{TeamError}from'./team-errors.ts';import{ManualSyncError}from'./manual-sync-plan.ts';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
export class TeamNotionInventory{
 private readonly client:OfficialNotionClient;
 constructor(private readonly tenantId:string,token:string,private readonly destination:TeamDestination,transport:NotionTransport,private readonly guard:()=>Promise<void>){
  this.client=new OfficialNotionClient({token,readPermit:{approved:true},maxRateLimitRetries:0,transport:async r=>{
   const prefix='https://api.notion.com/v1/',allowed=new Set([prefix+'databases/'+destination.databaseId,prefix+'data_sources/'+destination.dataSourceId,prefix+'data_sources/'+destination.dataSourceId+'/query']);
   if(!allowed.has(r.url)||!['GET','POST'].includes(r.method)||r.method==='POST'&&!r.url.endsWith('/query'))throw new TeamError('DESTINATION_INVALID');await guard();return transport(r);
  }});
 }
 private async schema(){
  await this.guard();const db=await this.client.read('/databases/'+this.destination.databaseId),ds=await this.client.read('/data_sources/'+this.destination.dataSourceId);
  if(!Array.isArray(db.data_sources)||!db.data_sources.some(v=>same(object(v).id,this.destination.dataSourceId))||!same(object(ds.parent).database_id,this.destination.databaseId))throw new TeamError('DESTINATION_INVALID');
  const props=Object.entries(object(ds.properties)).map(([key,v])=>({key,...object(v)} as Record<string,unknown>));
  const pick=(names:string[],types:string[])=>{const matches=props.filter(p=>names.includes(String(p.name??p.key))&&types.includes(String(p.type)));if(matches.length!==1||typeof matches[0]!.id!=='string')throw new TeamError('DESTINATION_INVALID');return matches[0]!;};
  const admin=pick(['어드민','어드민 URL'],['url']),status=pick(['상태'],['select','status']),uid=props.filter(p=>p.name==='UID'||p.key==='UID');
  if(uid.length>1)throw new TeamError('DESTINATION_INVALID');return{admin,status,uid:uid[0]};
 }
 async withdrawalMapping():Promise<VerifiedWithdrawalStatusMapping|undefined>{
  const s=await this.schema(),raw=object(s.status[String(s.status.type)]),options=Array.isArray(raw.options)?raw.options.map(v=>object(v)):[],found=options.filter(o=>o.name==='탈퇴요청');
  if(found.length!==1)return undefined;
  return verifyWithdrawalStatusMapping({optionName:'탈퇴요청',dataSourceId:this.destination.dataSourceId,propertyId:String(s.status.id),actualOptions:options.map(o=>({id:String(o.id),name:String(o.name)}))});
 }
 async listPreviewIdentitiesPartial(input:{trainerId:string;scope:'all_members'}):Promise<NotionPartialPreviewInventory>{
  if(input.trainerId!==this.tenantId||input.scope!=='all_members')throw new ManualSyncError('TENANT_MISMATCH');
  const s=await this.schema(),pages=await collectNotionPages(cursor=>this.client.read('/data_sources/'+this.destination.dataSourceId+'/query',undefined,{page_size:100,...(cursor?{start_cursor:cursor}:{})}));
  const identities:NotionPartialPreviewInventory['identities']=[],reviewRows:NotionPartialPreviewInventory['reviewRows']=[];
  for(const page of pages){
   await this.guard();if(page.archived||page.in_trash||!same(object(page.parent).data_source_id,this.destination.dataSourceId)||typeof page.id!=='string')throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
   const properties=Object.values(object(page.properties)).map(object);
   const prop=(schema:Record<string,unknown>)=>{const hits=properties.filter(p=>p.id===schema.id&&p.type===schema.type);if(hits.length!==1)throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');return hits[0]!;};
   const url=prop(s.admin).url;
   if(url===null||url===''){reviewRows.push({pageId:page.id,label:'',reason:'missing_admin_url'});continue;}
   let uid:string;
   try{const u=new URL(String(url));uid=u.pathname.slice('/manage/members/'.length);if(u.origin!=='https://admin.biz-pt.com'||!u.pathname.startsWith('/manage/members/')||u.username||u.password||u.search||u.hash||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(uid))throw Error();}catch{reviewRows.push({pageId:page.id,label:'',reason:'invalid_admin_url'});continue;}
   if(s.uid&&planCompanyUidFill(uid,prop(s.uid)).decision==='held')throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
   const selected=prop(s.status)[String(s.status.type)],existingStatus=selected===null?null:object(selected).name;
   if(existingStatus!==null&&typeof existingStatus!=='string')throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
   identities.push({trainerId:this.tenantId,companyMemberId:uid,pageId:page.id,label:'',existingStatus});
  }
  await this.guard();return{identities,reviewRows,queryCoverage:'complete',identityCoverage:reviewRows.length?'partial':'complete',canProveAbsence:reviewRows.length===0,snapshotId:'team-inventory:'+this.destination.dataSourceId};
 }
 async listIdentities(input:{trainerId:string;cursor:string|null;scope:'all_members'}){
  if(input.cursor!==null)throw new ManualSyncError('NOTION_PAGINATION_INVALID');const p=await this.listPreviewIdentitiesPartial(input);if(p.reviewRows.length)throw new ManualSyncError('NOTION_COVERAGE_UNVERIFIED');
  return{identities:p.identities,nextCursor:null,scope:'all_members' as const,completeCoverage:true,snapshotId:p.snapshotId};
 }
}
