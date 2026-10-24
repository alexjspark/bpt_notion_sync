import{parseNotionDestination}from'./runtime-scopes.ts';import type{NotionDestinationScope}from'./runtime-scopes.ts';
import{NotionReviewRequiredError,object}from'./live-notion-client.ts';import type{NotionTransport}from'./live-notion-client.ts';
import{discoverMemberInfoSchema,pageProperty}from'./member-info-store.ts';import type{MemberInfoSchema}from'./member-info-store.ts';import type{OfficialNotionClient}from'./live-notion-client.ts';
import type{DemographicField,CompanyDemographics}from'./company-demographics.ts';
export const PROFILE_SAVE_CONSENT='2026-10-24-dob-gender-v1';
export const profileFail=(code:string):never=>{throw new NotionReviewRequiredError(code);};
export interface ProfileSchema extends MemberInfoSchema{birthDate:string;gender:string;maleOption:string;femaleOption:string}
export interface ProfileTarget{uid:string;pageId:string;name:string;fields:DemographicField[]}
export async function discoverProfileSchema(client:OfficialNotionClient,databaseId:string,dataSourceId:string):Promise<ProfileSchema>{
 const base=await discoverMemberInfoSchema(client,databaseId,dataSourceId);if(base.dataSourceId!==dataSourceId||base.databaseId!==databaseId)profileFail('PROFILE_SOURCE_MISMATCH');
 const source=await client.read('/data_sources/'+dataSourceId),all=Object.entries(object(source.properties)).map(([name,p])=>({name,p:object(p)}));
 const birth=all.filter(v=>v.name==='\uc0dd\ub144\uc6d4\uc77c'&&v.p.type==='date'),gender=all.filter(v=>v.name==='\uc131\ubcc4'&&v.p.type==='select');
 if(birth.length!==1||gender.length!==1)profileFail('PROFILE_SCHEMA_UNSUPPORTED');
 const options=object(gender[0]!.p.select).options;if(!Array.isArray(options))profileFail('PROFILE_GENDER_OPTIONS_UNVERIFIED');
 const pick=(name:string)=>{const a=(options as unknown[]).map(object).filter(o=>o.name===name);if(a.length!==1||typeof a[0]!.id!=='string')return profileFail('PROFILE_GENDER_OPTIONS_UNVERIFIED');return String(a[0]!.id);};
 return{...base,birthDate:String(birth[0]!.p.id),gender:String(gender[0]!.p.id),maleOption:pick('\ub0a8'),femaleOption:pick('\uc5ec')};
}
export function validateProfileTargets(value:unknown):ProfileTarget[]{
 if(!Array.isArray(value)||value.length>100)return profileFail('PROFILE_TARGET_SCOPE_INVALID');const targets=value as ProfileTarget[];
 if(new Set(targets.map(t=>t.uid)).size!==targets.length||new Set(targets.map(t=>t.pageId)).size!==targets.length)return profileFail('PROFILE_TARGET_SCOPE_INVALID');
 for(const t of targets)if(!/^\d+$/.test(t.uid)||!/^[a-f0-9-]{36}$/.test(t.pageId)||!t.name?.trim()||!Array.isArray(t.fields)||!t.fields.length||new Set(t.fields).size!==t.fields.length||t.fields.some(f=>!['birthDate','gender'].includes(f)))return profileFail('PROFILE_TARGET_SCOPE_INVALID');
 return targets;
}
export function profileValue(source:CompanyDemographics,field:DemographicField,s:ProfileSchema):unknown{
 return field==='birthDate'?source.birthDate===null?undefined:{date:{start:source.birthDate}}:source.gender===null?undefined:{select:{id:source.gender==='M'?s.maleOption:s.femaleOption}};
}
export function profileFieldEmpty(page:Record<string,unknown>,field:DemographicField,s:ProfileSchema){const p=pageProperty(page,s[field]),type=field==='birthDate'?'date':'select';if(p.type!==type)profileFail('PROFILE_PROPERTY_TYPE_CHANGED');return p[type]===null;}
export function createProfileSaveTransport(options:{destination:NotionDestinationScope;targets:ProfileTarget[];schema:()=>ProfileSchema|undefined;intended:Map<string,CompanyDemographics>;delegate:NotionTransport;consumeWrite:(pageId:string,fields:DemographicField[])=>Promise<void>}):NotionTransport{
 const destination=parseNotionDestination(options.destination),targets=structuredClone(validateProfileTargets(options.targets)),sent=new Set<string>();
 return async request=>{
  const u=new URL(request.url),path=u.pathname.replace(/^\/v1/,'');if(u.origin!=='https://api.notion.com')return profileFail('PROFILE_TRANSPORT_REJECTED');
  const ds='/data_sources/'+destination.dataSourceId;
  if(request.method==='GET'&&(['/databases/'+destination.databaseId,ds,...targets.map(t=>'/pages/'+t.pageId)].includes(path)))return options.delegate(request);
  if(request.method==='POST'&&path===ds+'/query')return options.delegate(request);
  const s=options.schema(),target=targets.find(t=>path==='/pages/'+t.pageId);if(request.method!=='PATCH'||u.search||u.hash||!s||(s.dataSourceId!==destination.dataSourceId||s.databaseId!==destination.databaseId)||!target||sent.has(target.pageId))return profileFail('PROFILE_TRANSPORT_REJECTED');
  const b=object(request.body),p=object(b.properties),source=options.intended.get(target.uid),fields:DemographicField[]=[];
  if(Object.keys(b).length!==1||!Object.hasOwn(b,'properties')||!Object.keys(p).length||!source)return profileFail('PROFILE_TRANSPORT_REJECTED');
  for(const[id,value]of Object.entries(p)){const field=target.fields.find(f=>s[f]===id);if(!field||JSON.stringify(value)!==JSON.stringify(profileValue(source,field,s)))return profileFail('PROFILE_TRANSPORT_REJECTED');fields.push(field);}
  sent.add(target.pageId);await options.consumeWrite(target.pageId,fields);return options.delegate(request);
 };
}
