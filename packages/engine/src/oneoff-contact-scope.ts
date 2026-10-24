import{NotionReviewRequiredError,object}from'./live-notion-client.ts';
import type{NotionTransport}from'./live-notion-client.ts';
import type{MemberInfoSchema}from'./member-info-store.ts';
import{parseNotionDestination,parseContactApproval}from'./runtime-scopes.ts';
import type{NotionDestinationScope,ApprovedContactTarget}from'./runtime-scopes.ts';
export const CONTACT_SAVE_CONSENT='2026-10-24-two-members-four-fields-v1';
export const contactMemberName=(v:string)=>v.trim().replace(/\s*\ud68c\uc6d0\ub2d8$/u,'').trim();
export interface ContactSaveTarget{uid:string;pageId:string;name:string;fields:('phone'|'email')[]}
export interface ContactValues{uid:string;name:string;phone:string|null;email:string|null}
export const contactFail=(code:string):never=>{throw new NotionReviewRequiredError(code);};
export function validateContactTargets(value:unknown,approvedTargets:readonly ApprovedContactTarget[]):ContactSaveTarget[]{
 const approved=parseContactApproval({consentKey:CONTACT_SAVE_CONSENT,targets:approvedTargets}).targets;
 if(!Array.isArray(value)||value.length!==2)contactFail('CONTACT_SAVE_TARGET_SCOPE_INVALID');
 const targets=value as ContactSaveTarget[];
 if(targets.some(t=>!t||typeof t.uid!=='string'||typeof t.pageId!=='string'||typeof t.name!=='string')
   ||new Set(targets.map(t=>t.uid)).size!==2||new Set(targets.map(t=>t.pageId)).size!==2)contactFail('CONTACT_SAVE_TARGET_SCOPE_INVALID');
 for(const t of targets)if(!approved.some(a=>a.uid===t.uid&&a.pageId===t.pageId&&contactMemberName(a.name)===contactMemberName(t.name))
   ||JSON.stringify(t.fields)!==JSON.stringify(['phone','email']))contactFail('CONTACT_SAVE_TARGET_SCOPE_INVALID');
 return targets;
}
export function assertSourceContacts(values:ContactValues){if(!values.phone||!values.email||/[*\u2022\u25cf\u00b7]/.test(values.phone+values.email)||!/^[+\d()\s-]{8,30}$/.test(values.phone)||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email))contactFail('CONTACT_SAVE_SOURCE_INVALID');}
export function createContactSaveTransport(options:{destination:NotionDestinationScope;approvedTargets:readonly ApprovedContactTarget[];schema:()=>MemberInfoSchema|undefined;targets:ContactSaveTarget[];intended:Map<string,ContactValues>;delegate:NotionTransport;consumeWrite:(pageId:string,fields:string[])=>Promise<void>}):NotionTransport{
 const destination=parseNotionDestination(options.destination),targets=structuredClone(validateContactTargets(options.targets,options.approvedTargets)),sent=new Set<string>();
 return async request=>{
  const u=new URL(request.url),path=u.pathname.replace(/^\/v1/,'');if(u.origin!=='https://api.notion.com'||u.search||u.hash)return contactFail('CONTACT_SAVE_TRANSPORT_REJECTED');
  const source='/data_sources/'+destination.dataSourceId;
  if(request.method==='GET'&&(['/databases/'+destination.databaseId,source,...targets.map(t=>'/pages/'+t.pageId)].includes(path)))return options.delegate(request);
  if(request.method==='POST'&&path===source+'/query')return options.delegate(request);
  const s=options.schema(),target=targets.find(t=>path==='/pages/'+t.pageId);
  if(request.method!=='PATCH'||!s||s.databaseId!==destination.databaseId||s.dataSourceId!==destination.dataSourceId||!target||sent.has(target.pageId))return contactFail('CONTACT_SAVE_TRANSPORT_REJECTED');
  const b=object(request.body),p=object(b.properties),value=options.intended.get(target.uid),fields:string[]=[];
  if(Object.keys(b).length!==1||!Object.hasOwn(b,'properties')||!Object.keys(p).length||!value)return contactFail('CONTACT_SAVE_TRANSPORT_REJECTED');
  for(const[id,raw]of Object.entries(p)){const v=object(raw);if(Object.keys(v).length!==1)return contactFail('CONTACT_SAVE_TRANSPORT_REJECTED');
   if(id===s.phone&&target.fields.includes('phone')&&v.phone_number===value.phone)fields.push('phone');
   else if(id===s.email&&target.fields.includes('email')&&v.email===value.email)fields.push('email');else return contactFail('CONTACT_SAVE_TRANSPORT_REJECTED');
  }
  sent.add(target.pageId);await options.consumeWrite(target.pageId,fields);return options.delegate(request);
 };
}
