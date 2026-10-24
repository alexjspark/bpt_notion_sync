import {OfficialNotionClient,NotionReviewRequiredError,collectNotionPages,object,string,array,resourceId} from './live-notion-client.ts';
export interface MemberInfoSchema {databaseId:string;dataSourceId:string;name:string;status:string;admin:string;phone:string;email:string;firstTraining:string}
export interface MemberInfoInput {uid:string;name:string;phone:string|null;email:string|null;createStatus:string;bodyOnCreate?:unknown[]}
const fail=(code:string):never=>{throw new NotionReviewRequiredError(code);};
const same=(a:unknown,b:string)=>typeof a==='string'&&a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
export const textValue=(value:unknown):string=>array(value).map(v=>{const p=object(v);return typeof p.plain_text==='string'?p.plain_text:typeof object(p.text).content==='string'?String(object(p.text).content):'';}).join('');
export const notionText=(content:string)=>[{type:'text',text:{content}}];
export function pageProperty(page:Record<string,unknown>,id:string):Record<string,unknown>{
  const matches=Object.values(object(page.properties)).map(object).filter(p=>p.id===id);
  if(matches.length!==1)return fail('MEMBER_INFO_PROPERTY_CHANGED');return matches[0]!;
}
export async function discoverMemberInfoSchema(client:OfficialNotionClient,databaseId:string,dataSourceId:string):Promise<MemberInfoSchema>{
  const db=await client.read('/databases/'+resourceId(databaseId));
  if(!array(db.data_sources).map(object).some(s=>same(s.id,dataSourceId)))fail('MEMBER_INFO_PARENT_MISMATCH');
  const source=await client.read('/data_sources/'+resourceId(dataSourceId));
  if(!same(source.id,dataSourceId)||!same(object(source.parent).database_id,databaseId))fail('MEMBER_INFO_PARENT_MISMATCH');
  const properties=Object.entries(object(source.properties)).map(([name,p])=>({name,p:object(p)}));
  const pick=(name:string,type:string)=>{const matches=properties.filter(v=>v.name===name&&v.p.name===name&&v.p.type===type);if(matches.length!==1)return fail('MEMBER_INFO_SCHEMA_REQUIRED');return string(matches[0]!.p.id);};
  return{databaseId,dataSourceId,name:pick('\ud68c\uc6d0\uba85','title'),status:pick('\uc0c1\ud0dc','select'),admin:pick('\uc5b4\ub4dc\ubbfc','url'),phone:pick('\uc804\ud654\ubc88\ud638','phone_number'),email:pick('\uc774\uba54\uc77c','email'),firstTraining:pick('\uccab \ud2b8\ub808\uc774\ub2dd','date')};
}
/** Exact UID persistence. Existing-page patches are held: Notion exposes no documented atomic compare-and-set. Never claim that a final re-read closes the race. */
export class MemberInfoStore {
  constructor(readonly client:OfficialNotionClient,readonly schema:MemberInfoSchema){}
  admin(uid:string){if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(uid))fail('MEMBER_INFO_UID_INVALID');return'https://admin.biz-pt.com/manage/members/'+uid;}
  assertPage(page:Record<string,unknown>,uid:string,allowTrash=false){
    if(!same(object(page.parent).data_source_id,this.schema.dataSourceId)||pageProperty(page,this.schema.admin).url!==this.admin(uid))fail('MEMBER_INFO_IDENTITY_MISMATCH');
    if(!allowTrash&&(page.in_trash===true||page.archived===true||page.is_archived===true))fail('MEMBER_INFO_PAGE_TRASHED');
  }
  async readPage(pageId:string,uid:string,allowTrash=false){const page=await this.client.read('/pages/'+resourceId(pageId));this.assertPage(page,uid,allowTrash);return page;}
  async find(uid:string){const rows=await collectNotionPages(cursor=>this.client.read('/data_sources/'+resourceId(this.schema.dataSourceId)+'/query',undefined,{page_size:100,filter:{property:this.schema.admin,url:{equals:this.admin(uid)}},...(cursor?{start_cursor:cursor}:{})}));
    for(const p of rows)this.assertPage(p,uid);if(rows.length>1)fail('MEMBER_INFO_DUPLICATE_UID');return rows[0];}
  async save(input:MemberInfoInput,options:{knownPageId?:string;allowCreate:boolean;beforeCreate?:()=>Promise<void>;created?:(pageId:string)=>Promise<void>;guard:()=>Promise<void>}){
    if(!input.name.trim()||input.name.length>250||[input.phone,input.email].some(v=>v!==null&&(typeof v!=='string'||v.length>250||/[\r\n]/.test(v))))fail('MEMBER_INFO_INPUT_INVALID');
    await options.guard();const match=await this.find(input.uid);let page=options.knownPageId?await this.readPage(options.knownPageId,input.uid):match;let created=false;
    if(match&&page&&!same(match.id,string(page.id)))fail('MEMBER_INFO_IDENTITY_MISMATCH');
    if(!page){if(!options.allowCreate)fail('MEMBER_INFO_CREATE_NOT_ALLOWED');await options.beforeCreate?.();await options.guard();
      const schema=await this.client.read('/data_sources/'+resourceId(this.schema.dataSourceId));
      const status=Object.values(object(schema.properties)).map(object).find(p=>p.id===this.schema.status&&p.type==='select');
      if(!status||!array(object(status.select).options).map(object).some(o=>o.name===input.createStatus))fail('MEMBER_INFO_STATUS_UNVERIFIED');
      page=await this.client.write('POST','/pages',{parent:{type:'data_source_id',data_source_id:this.schema.dataSourceId},
        properties:{[this.schema.name]:{title:notionText(input.name)},[this.schema.status]:{select:{name:input.createStatus}},[this.schema.admin]:{url:this.admin(input.uid)},
          [this.schema.phone]:{phone_number:input.phone},[this.schema.email]:{email:input.email}},...(input.bodyOnCreate?{children:input.bodyOnCreate}:{})});
      await options.created?.(string(page.id));created=true;page=await this.readPage(string(page.id),input.uid);
    }
    // Reading emptiness is only a plan. It cannot authorize a race-safe PATCH without a server precondition.
    page=await this.readPage(string(page.id),input.uid);const protectedBefore=protectedProperties(page,[this.schema.phone,this.schema.email]);
    const patch:Record<string,unknown>={},updatedFields:string[]=[],preservedFields:string[]=[];
    for(const [key,id,type,value]of [['phone',this.schema.phone,'phone_number',input.phone],['email',this.schema.email,'email',input.email]]as const){
      const property=pageProperty(page,id);if(property.type!==type)fail('MEMBER_INFO_PROPERTY_CHANGED');
      if((property[type]===null||property[type]==='')&&value!==null&&value!==''){patch[id]={[type]:value};updatedFields.push(key);}else preservedFields.push(key);
    }
    const deferredFields=[...updatedFields];updatedFields.length=0;
    // Fail closed for every existing-page update, including just-created pages after POST.
    // No lock, last_edited_time check or post-read can atomically protect the Notion UI writer.
    const deferredReason=deferredFields.length?'NOTION_ATOMIC_COMPARE_AND_SET_UNAVAILABLE':null;
    const after=await this.readPage(string(page.id),input.uid);if(JSON.stringify(protectedProperties(after,[this.schema.phone,this.schema.email]))!==JSON.stringify(protectedBefore))fail('MEMBER_INFO_PROTECTED_CHANGED');
    for(const [id,type,value]of [[this.schema.phone,'phone_number',input.phone],[this.schema.email,'email',input.email]]as const)
      if(updatedFields.length&&Object.hasOwn(patch,id)&&pageProperty(after,id)[type]!==value)fail('MEMBER_INFO_READBACK_FAILED');
    return{pageId:string(page.id),created,updatedFields,preservedFields,deferredFields,deferredReason,outcome:deferredFields.length?'held':created?'created':'unchanged',verified:deferredFields.length===0};
  }
}
export function protectedProperties(page:Record<string,unknown>,excluded:string[]){
  return Object.fromEntries(Object.values(object(page.properties)).map(object).filter(p=>!excluded.includes(String(p.id))&&!['formula','rollup','last_edited_time','last_edited_by'].includes(String(p.type))).sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(p=>[String(p.id),p]));
}
