import{createHash}from'node:crypto';
import{OfficialNotionClient,object,collectNotionPages,type NotionTransport}from'./live-notion-client.ts';
import{CountedCompanyPreviewAdapter}from'./live-company-counted-preview.ts';
import{readCompanyDemographics}from'./company-demographics.ts';
import{COMPANY_CURRENT_ACCOUNT_URL,readCompanyCurrentAccountInPage}from'./company-current-account.ts';
import{TeamError,requireUuid}from'./team-errors.ts';
import type{TeamOwnedBrowser}from'./team-owned-browser.ts';
import type{TeamPreviewInput}from'./team-adapter-preview.ts';
export type PilotField='phone'|'email'|'birthDate'|'gender'|'uid';
export interface PilotChange{field:PilotField;id:string;value:Record<string,unknown>}
export interface PilotPlan{uid:string;name:string;pageId:string;dataSourceId:string;databaseId:string;lastEdited:string;changes:PilotChange[];held:{field:PilotField;reason:string}[];baseline:string}
export interface PilotProvider{
 readonly available:boolean;
 prepare(scope:TeamPreviewInput,uid:string):Promise<PilotPlan>;
 execute(scope:TeamPreviewInput,plan:PilotPlan,dispatch:()=>Promise<void>):Promise<{verified:boolean;uncertain:boolean;fields:PilotField[]}>;
}
export class UnconfiguredPilotProvider implements PilotProvider{
 readonly available=false;
 async prepare():Promise<never>{throw new TeamError('PILOT_DISABLED');}
 async execute():Promise<never>{throw new TeamError('PILOT_DISABLED');}
}
const same=(a:unknown,b:string)=>typeof a==='string'&&a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Only expected primitive fields. Unsupported schemas are held; no automatic schema edits. */
export function pilotSchema(properties:Record<string,unknown>){
 const props=Object.entries(properties).map(([name,p])=>({name,...object(p)}));
 const get=(names:string[],types:string[])=>{const hits=props.filter(p=>names.includes(p.name)&&types.includes(String((p as Record<string,unknown>).type)));if(hits.length!==1||typeof(hits[0]as Record<string,unknown>).id!=='string')throw new TeamError('DESTINATION_INVALID');return hits[0]as Record<string,unknown>;};
 const admin=get(['\uc5b4\ub4dc\ubbfc','\uc5b4\ub4dc\ubbfc URL'],['url']);
 const fields={phone:get(['\uc804\ud654\ubc88\ud638'],['phone_number']),email:get(['\uc774\uba54\uc77c'],['email']),birthDate:get(['\uc0dd\ub144\uc6d4\uc77c'],['date']),gender:get(['\uc131\ubcc4'],['select']),uid:get(['UID'],['rich_text','number'])};
 const options=object(fields.gender.select).options;if(!Array.isArray(options))throw new TeamError('DESTINATION_INVALID');
 const gender=(name:string)=>{const hits=options.map(object).filter(p=>p.name===name);if(hits.length!==1||typeof hits[0]!.id!=='string')throw new TeamError('DESTINATION_INVALID');return String(hits[0]!.id);};
 return{admin,fields,male:gender('\ub0a8'),female:gender('\uc5ec')};
}
export const pilotPlanHash=(plan:PilotPlan)=>digest(plan);
export class TeamPilotRuntime implements PilotProvider{
 readonly available=true;
 constructor(private readonly browser:TeamOwnedBrowser,private readonly transport:NotionTransport){}
 private async session<T>(scope:TeamPreviewInput,work:(source:CountedCompanyPreviewAdapter,client:OfficialNotionClient,page:import('./live-company-types.ts').CompanyBrowserPage)=>Promise<T>,write=false,writePlan?:PilotPlan){
  await scope.assertCurrent();const lease=await this.browser.open(scope);
  try{
   const guard=async()=>{await scope.assertCurrent();const account=await readCompanyCurrentAccountInPage(lease.page);if(account.uid!==scope.binding.accountId||account.trainerId!==scope.binding.trainerId)throw new TeamError('ACCOUNT_CHANGED');};
   await guard();const source=new CountedCompanyPreviewAdapter(lease.page,{mode:'counted-ui',scopeApproved:true,evidence:{reference:'team-pilot',verifiedAt:new Date().toISOString()},accountResponse:{endpoint:COMPANY_CURRENT_ACCOUNT_URL,expected:{uid:scope.binding.accountId,trainerId:scope.binding.trainerId},evidence:{reference:'team-pilot-binding',verifiedAt:new Date().toISOString()}}},scope.tenantId,()=>readCompanyCurrentAccountInPage(lease.page));
   let writes=0;
   const client=new OfficialNotionClient({token:scope.token,readPermit:{approved:true},...(write?{writePermit:{approved:true as const}}:{}),maxRateLimitRetries:0,transport:async request=>{await guard();
    if(request.method==='PATCH'||request.method==='POST'&&!request.url.endsWith('/query')){
     if(!write||!writePlan||request.method!=='PATCH'||request.url!=='https://api.notion.com/v1/pages/'+writePlan.pageId||writes!==0||JSON.stringify(request.body)!==JSON.stringify({properties:Object.fromEntries(writePlan.changes.map(c=>[c.id,c.value]))}))throw new TeamError('FORBIDDEN',403);writes++;
    }
    return this.transport(request);}});
   return await work(source,client,lease.page);
  }finally{await lease.release();}
 }
 async prepare(scope:TeamPreviewInput,uid:string):Promise<PilotPlan>{
  if(!/^[0-9]{1,32}$/.test(uid))throw new TeamError('INVALID_INPUT',400);
  return this.session(scope,async(source,client,page)=>{
   const members=await source.listAssignedContactSnapshot(),matches=members.filter(m=>m.uid===uid);
   if(matches.length!==1)throw new TeamError('ACCOUNT_UNVERIFIED');const member=matches[0]!;
   const db=await client.read('/databases/'+scope.destination.databaseId),ds=await client.read('/data_sources/'+scope.destination.dataSourceId);
   if(!Array.isArray(db.data_sources)||!db.data_sources.some(x=>same(object(x).id,scope.destination.dataSourceId))||!same(object(ds.parent).database_id,scope.destination.databaseId))throw new TeamError('DESTINATION_INVALID');
   const schema=pilotSchema(object(ds.properties)),pages=await collectNotionPages(cursor=>client.read('/data_sources/'+scope.destination.dataSourceId+'/query',undefined,{page_size:100,...(cursor?{start_cursor:cursor}:{})}));
   const property=(p:Record<string,unknown>,id:string)=>{const matches=Object.values(object(p.properties)).map(object).filter(p=>p.id===id);if(matches.length!==1)throw new TeamError('DESTINATION_INVALID');return matches[0]!;};
   const admin='https://admin.biz-pt.com/manage/members/'+uid;
   const candidates=pages.filter(p=>property(p,String(schema.admin.id)).url===admin);
   if(candidates.length!==1)throw new TeamError('PILOT_CHANGED');
   const current=candidates[0]!;if(current.archived||current.in_trash||!same(object(current.parent).data_source_id,scope.destination.dataSourceId)||typeof current.last_edited_time!=='string')throw new TeamError('PILOT_CHANGED');
   const explicit=property(current,String(schema.fields.uid.id)),existingUid=explicit.type==='number'?explicit.number:explicit.type==='rich_text'&&Array.isArray(explicit.rich_text)?explicit.rich_text.map(v=>String(object(v).plain_text??object(object(v).text).content)).join(''):undefined;
   if(existingUid!==null&&existingUid!==''&&String(existingUid)!==uid)throw new TeamError('PILOT_CHANGED');
   const duplicates=pages.filter(p=>{const q=property(p,String(schema.fields.uid.id));return q.type==='number'?q.number!==null&&String(q.number)===uid:q.type==='rich_text'&&Array.isArray(q.rich_text)&&q.rich_text.map(v=>String(object(v).plain_text??object(object(v).text).content)).join('')===uid;});
   if(duplicates.some(p=>p.id!==current.id))throw new TeamError('PILOT_CHANGED');
   const demographic=await readCompanyDemographics(page,uid,member.name,()=>source.verifyAccount());
   const values:Record<PilotField,Record<string,unknown>|null>={phone:member.phone?{phone_number:member.phone}:null,email:member.email?{email:member.email}:null,birthDate:demographic.birthDate?{date:{start:demographic.birthDate}}:null,gender:demographic.gender?{select:{id:demographic.gender==='M'?schema.male:schema.female}}:null,uid:schema.fields.uid.type==='rich_text'?{rich_text:[{type:'text',text:{content:uid}}]}:/^(0|[1-9]\d*)$/.test(uid)&&Number.isSafeInteger(Number(uid))?{number:Number(uid)}:null};
   const changes:PilotChange[]=[],held:PilotPlan['held']=[];
   for(const field of Object.keys(values)as PilotField[]){const s=schema.fields[field],p=property(current,String(s.id));if(p.type!==s.type)throw new TeamError('DESTINATION_INVALID');const old=p[String(s.type)],empty=old===null||old===''||Array.isArray(old)&&old.length===0;
    if(!empty)held.push({field,reason:'EXISTING_VALUE'});else if(values[field]===null)held.push({field,reason:'SOURCE_MISSING_OR_UNSUPPORTED'});else changes.push({field,id:String(s.id),value:values[field]!});
   }
   return{uid,name:member.name,pageId:requireUuid(current.id),dataSourceId:scope.destination.dataSourceId,databaseId:scope.destination.databaseId,lastEdited:current.last_edited_time,changes,held,baseline:digest(current.properties)};
  });
 }
 async execute(scope:TeamPreviewInput,plan:PilotPlan,dispatch:()=>Promise<void>){
  // Fresh complete source and destination comparison. This is not an atomic Notion CAS.
  const latest=await this.prepare(scope,plan.uid);
  if(pilotPlanHash(latest)!==pilotPlanHash(plan)||!plan.changes.length)throw new TeamError('PILOT_CHANGED');
  return this.session(scope,async(_source,client)=>{
   const before=await client.read('/pages/'+plan.pageId);
   if(before.last_edited_time!==plan.lastEdited||digest(before.properties)!==plan.baseline||!same(object(before.parent).data_source_id,plan.dataSourceId)||before.in_trash||before.archived)throw new TeamError('PILOT_CHANGED');
   await scope.assertCurrent();await dispatch(); // durable consumption before any PATCH; never replay
   let uncertain=false;
   try{await client.write('PATCH','/pages/'+plan.pageId,{properties:Object.fromEntries(plan.changes.map(c=>[c.id,c.value]))});}catch{uncertain=true;}
   let after:Record<string,unknown>;try{after=await client.read('/pages/'+plan.pageId);}catch{return{verified:false,uncertain:true,fields:[]};}
   const all=Object.values(object(after.properties)).map(object),fields:PilotField[]=[];
   const canonical=(v:unknown)=>JSON.stringify(v);
   for(const c of plan.changes){const p=all.find(p=>p.id===c.id),[type,value]=Object.entries(c.value)[0]!;let actual=p?.[type];
    if(type==='select')actual=actual?{id:object(actual).id}:null;
    if(type==='date')actual=actual&&object(actual).end==null&&object(actual).time_zone==null?{start:object(actual).start}:null;
    if(type==='rich_text')actual=Array.isArray(actual)?actual.map(v=>({type:'text',text:{content:String(object(v).plain_text??object(object(v).text).content)}})):null;
    if(canonical(actual)===canonical(value))fields.push(c.field);
   }
   const excluded=new Set(plan.changes.map(c=>c.id)),protect=(p:Record<string,unknown>)=>Object.values(object(p.properties)).map(object).filter(q=>!excluded.has(String(q.id))&&!['last_edited_time','last_edited_by','formula','rollup'].includes(String(q.type))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
   return{verified:!after.in_trash&&!after.archived&&fields.length===plan.changes.length&&same(object(after.parent).data_source_id,plan.dataSourceId)&&digest(protect(before))===digest(protect(after)),uncertain,fields};
  },true,plan);
 }
}
