import{companyUidValue}from'./company-uid.ts';
import type { Member, MemberStatus, ScheduleEvent } from '@trainer/core';
import { LEGACY_NEW_MEMBER_STATUS, normalizeMember, normalizeMemberStatus } from '@trainer/core';
import type { NotionAdapter } from './ports.ts';
import { RetryableError } from './ports.ts';
import { OfficialNotionClient, NotionReviewRequiredError, NotionWriteUncertainError, array, collectNotionPages, object, propertyPathId, resourceId, string } from './live-notion-client.ts';
import { blockContent, blockText, fingerprint, replacementBody, richText, selectBlock, selectorMatches } from './live-notion-template.ts';
import type { NotionBlockTree } from './live-notion-template.ts';
import type { NotionCalendarBinding, NotionIdentityBinding, NotionManagedState, NotionManagedStateStore, NotionMemberBinding, NotionPlanOperation, NotionPartialPreviewInventory, NotionProperty, NotionWritePlan } from './live-notion-types.ts';
export * from './live-notion-client.ts';
export * from './live-notion-types.ts';

interface PlannedMutation extends NotionPlanOperation {
  method: 'POST' | 'PATCH';
  stateKey: string;
  verify?: () => Promise<void>;
  committed?: (result: Record<string, unknown>, state: NotionManagedState) => void;
}
interface InternalPlan { lockKey: string; mutations: PlannedMutation[]; expectedStates:Record<string,string>; previewFingerprint:string; verifyScope?:()=>Promise<void> }
const STATUSES:readonly MemberStatus[]=['신규','통화','진행','졸업','탈퇴','탈퇴 요청','유예','확인필요'];
function fail(code:string):never{throw new NotionReviewRequiredError(code);}
const sameId=(a:unknown,b:unknown):boolean=>typeof a==='string'&&typeof b==='string'&&a.replaceAll('-','').toLowerCase()===b.replaceAll('-','').toLowerCase();
const stateKey=(trainerId:string,memberId:string):string=>`notion:member:${encodeURIComponent(trainerId)}:${encodeURIComponent(memberId)}`;
function property(page:Record<string,unknown>, binding:NotionProperty):Record<string,unknown>{
  const matches=Object.values(object(page.properties)).map(object).filter(item=>item.id===binding.id);
  if(matches.length!==1||matches[0]!.type!==binding.type)return fail('NOTION_PROPERTY_MISSING_OR_CHANGED');
  return matches[0]!;
}
function textValue(page:Record<string,unknown>,binding:NotionProperty<'title'|'rich_text'>):string{
  return array(property(page,binding)[binding.type]).map(item=>{const value=object(item);return value.type==='text'?string(object(value.text).content):string(value.plain_text);}).join('');
}
function selectValue(page:Record<string,unknown>,binding:NotionProperty<'select'|'status'>):string|null{
  const value=property(page,binding)[binding.type];return value===null?null:string(object(value).name);
}
function dateValue(page:Record<string,unknown>,binding:NotionProperty<'date'>):{start:string;end:string|null}|null{
  const value=property(page,binding).date;
  if(value===null)return null;
  const date=object(value);return {start:string(date.start),end:date.end===null||date.end===undefined?null:string(date.end)};
}
function timestamp(value:string):number{
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))||!validDate(value.slice(0,10)))return fail('NOTION_TIMESTAMP_OFFSET_REQUIRED');
  return Date.parse(value);
}
function validDate(value:string):boolean{return /^\d{4}-\d\d-\d\d$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
function rangeValid(start:string,end:string):void{if(timestamp(end)<=timestamp(start))fail('NOTION_DATE_RANGE_INVALID');}
function exactMap<T>(map:Readonly<Record<string,T>>,key:string|null,code:string):T{
  if(key===null||!Object.hasOwn(map,key))return fail(code);return map[key]!;
}
function identityRefs(binding:NotionIdentityBinding):NotionProperty[]{return binding.mode==='properties'?[binding.trainerId,binding.companyMemberId]:[binding.adminUrl];}
function parseAdminId(value:string,binding:Extract<NotionIdentityBinding,{mode:'exclusive-data-source-admin-url'}>):string{
  let url:URL;try{url=new URL(value);}catch{return fail('NOTION_ADMIN_URL_INVALID');}
  if(url.origin!==binding.adminOrigin||url.search||url.hash||url.username||url.password||!url.pathname.startsWith(binding.memberPathPrefix))return fail('NOTION_ADMIN_URL_SCOPE_MISMATCH');
  const id=url.pathname.slice(binding.memberPathPrefix.length);
  if(!id||!/^[A-Za-z0-9_-]+$/.test(id))return fail('NOTION_COMPANY_MEMBER_ID_INVALID');
  return id;
}

/**
 * Official REST adapter. Construction is inert; transport/token and approvals are supplied by the caller.
 * No default live mappings or credentials. Plan methods only read; execution also requires a durable store.
 * Official references: query-a-data-source, retrieve-a-data-source, page-property-values,
 * retrieve-a-page-property, update-a-block, and guides/data-apis/creating-pages-from-templates.
 */
export class OfficialNotionAdapter implements NotionAdapter {
  private readonly client:OfficialNotionClient;
  private readonly memberBinding:NotionMemberBinding;
  private readonly calendarBinding?:NotionCalendarBinding;
  private readonly store?:NotionManagedStateStore;
  private readonly plans=new WeakMap<NotionWritePlan,InternalPlan>();
  private readonly sleep:(milliseconds:number)=>Promise<void>;
  private readonly templateAttempts:number;
  private readonly templatePollMs:number;
  constructor(options:{client:OfficialNotionClient;members:NotionMemberBinding;calendar?:NotionCalendarBinding;stateStore?:NotionManagedStateStore;sleep?:(milliseconds:number)=>Promise<void>;templateAttempts?:number;templatePollMs?:number}){
    this.client=options.client;this.memberBinding=structuredClone({...options.members,template:undefined});
    // Functions are retained only for explicit context lookup; all data config is cloned against mutation.
    if(options.members.template)this.memberBinding={...this.memberBinding,template:{...structuredClone({...options.members.template,context:undefined}),context:options.members.template.context}};
    this.calendarBinding=options.calendar?structuredClone(options.calendar):undefined;this.store=options.stateStore;
    this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.templateAttempts=options.templateAttempts??5;this.templatePollMs=options.templatePollMs??1000;
    if(!Number.isInteger(this.templateAttempts)||this.templateAttempts<1||this.templateAttempts>30||!Number.isFinite(this.templatePollMs)||this.templatePollMs<0||this.templatePollMs>60000)fail('NOTION_TEMPLATE_WAIT_INVALID');
    const identity=this.memberBinding.identity;
    if(!identity||!this.memberBinding.allowedTrainerIds.length)fail('NOTION_IDENTITY_BINDING_REQUIRED');
    if(identity.mode==='exclusive-data-source-admin-url'){
      if(identity.exclusiveOwnershipApproved!==true||this.memberBinding.allowedTrainerIds.length!==1||this.memberBinding.allowedTrainerIds[0]!==identity.trainerId)fail('NOTION_EXCLUSIVE_OWNERSHIP_REQUIRED');
      let origin:URL;try{origin=new URL(identity.adminOrigin);}catch{fail('NOTION_ADMIN_ORIGIN_INVALID');}
      if(origin!.origin!==identity.adminOrigin||origin!.protocol!=='https:'||identity.memberPathPrefix!=='/manage/members/')fail('NOTION_ADMIN_ORIGIN_INVALID');
    }else if(identity.mode!=='properties')fail('NOTION_IDENTITY_BINDING_REQUIRED');
    if(Object.values(this.memberBinding.statuses).some(status=>!STATUSES.includes(normalizeMemberStatus(status))))fail('NOTION_STATUS_MAPPING_INVALID');
    if(Object.values(this.memberBinding.createStatus).includes(LEGACY_NEW_MEMBER_STATUS))fail('NOTION_LEGACY_STATUS_WRITE_FORBIDDEN');
  }
  private assertTrainer(trainerId:string):void{if(!trainerId||!this.memberBinding.allowedTrainerIds.includes(trainerId))fail('NOTION_TRAINER_SCOPE_MISMATCH');}
  private async validateSchema(databaseId:string,dataSourceId:string,bindings:NotionProperty[],options: Array<[NotionProperty<'select'|'status'>,string[]]>=[]):Promise<void>{
    const database=await this.client.read(`/databases/${resourceId(databaseId)}`);
    if(!array(database.data_sources).some(raw=>sameId(object(raw).id,dataSourceId)))fail('NOTION_DATA_SOURCE_PARENT_MISMATCH');
    const source=await this.client.read(`/data_sources/${resourceId(dataSourceId)}`);
    const properties=Object.values(object(source.properties)).map(object);
    const seen=new Set<string>();
    for(const binding of bindings){
      if(!binding?.id||seen.has(binding.id))fail('NOTION_SCHEMA_BINDING_INVALID');seen.add(binding.id);
      if(!properties.some(prop=>prop.id===binding.id&&prop.type===binding.type))fail('NOTION_SCHEMA_BINDING_MISSING');
    }
    for(const [binding,names] of options){
      const schema=properties.find(prop=>prop.id===binding.id)!;
      const choices=array(object(schema[binding.type]).options).map(raw=>string(object(raw).name));
      if(names.some(name=>!choices.includes(name)))fail('NOTION_SELECT_OPTION_UNVERIFIED');
    }
  }
  private async validateMembers():Promise<void>{
    const b=this.memberBinding;
    await this.validateSchema(b.databaseId,b.dataSourceId,[...identityRefs(b.identity),b.name,b.status,...[b.weekday,b.time,b.firstTraining,b.callAt,b.companyUid].filter((ref):ref is NonNullable<typeof ref>=>Boolean(ref))],[[b.status,[...Object.keys(b.statuses).filter(name=>name!==LEGACY_NEW_MEMBER_STATUS),...Object.values(b.createStatus)]]]);
  }
  private async query(sourceId:string,filter?:Record<string,unknown>):Promise<Record<string,unknown>[]> {
    return collectNotionPages(cursor=>this.client.read(`/data_sources/${resourceId(sourceId)}/query`,undefined,{page_size:100,...(filter?{filter}:{}),...(cursor?{start_cursor:cursor}:{})}));
  }
  private trainerFilter(trainerId:string):Record<string,unknown>|undefined{
    const identity=this.memberBinding.identity;
    return identity.mode==='properties'?{property:identity.trainerId.id,rich_text:{equals:trainerId}}:undefined;
  }
  private pageIdentity(page:Record<string,unknown>,trainerId:string):string{
    if(page.archived===true||page.in_trash===true)fail('NOTION_PAGE_ARCHIVED');
    const parent=object(page.parent);
    if(parent.type!=='data_source_id'||!sameId(parent.data_source_id,this.memberBinding.dataSourceId))fail('NOTION_MEMBER_PARENT_MISMATCH');
    const identity=this.memberBinding.identity;
    if(identity.mode==='properties'){
      if(textValue(page,identity.trainerId)!==trainerId)fail('NOTION_TRAINER_SCOPE_MISMATCH');
      const id=textValue(page,identity.companyMemberId);if(!id)fail('NOTION_COMPANY_MEMBER_ID_REQUIRED');return id;
    }
    if(identity.trainerId!==trainerId)fail('NOTION_TRAINER_SCOPE_MISMATCH');
    const adminUrl = property(page,identity.adminUrl).url;
    if (typeof adminUrl !== 'string' || !adminUrl.trim()) return fail('NOTION_ADMIN_URL_REQUIRED');
    return parseAdminId(adminUrl,identity);
  }
  private async memberPages(trainerId:string):Promise<Record<string,unknown>[]> {
    this.assertTrainer(trainerId);await this.validateMembers();
    const pages=await this.query(this.memberBinding.dataSourceId,this.trainerFilter(trainerId));
    const ids=new Set<string>();
    for(const page of pages){const id=this.pageIdentity(page,trainerId);if(ids.has(id))fail('NOTION_DUPLICATE_MEMBER_ID');ids.add(id);}
    return pages;
  }
  private async findMember(trainerId:string,memberId:string):Promise<Record<string,unknown>|undefined>{
    if(!memberId)fail('NOTION_COMPANY_MEMBER_ID_REQUIRED');
    this.assertTrainer(trainerId);await this.validateMembers();
    const identity=this.memberBinding.identity;
    let filter:Record<string,unknown>;
    if(identity.mode==='properties')filter={and:[{property:identity.trainerId.id,rich_text:{equals:trainerId}},{property:identity.companyMemberId.id,rich_text:{equals:memberId}}]};
    else{
      if(!/^[A-Za-z0-9_-]+$/.test(memberId))fail('NOTION_COMPANY_MEMBER_ID_INVALID');
      filter={property:identity.adminUrl.id,url:{equals:`${identity.adminOrigin}${identity.memberPathPrefix}${memberId}`}};
    }
    const pages=await this.query(this.memberBinding.dataSourceId,filter);
    if(pages.length>1)fail('NOTION_DUPLICATE_MEMBER_ID');
    if(pages[0]&&this.pageIdentity(pages[0],trainerId)!==memberId)fail('NOTION_MEMBER_QUERY_SCOPE_MISMATCH');
    return pages[0];
  }
  /** Partial preview only: row-level bad admin URLs never become guessed identities. */
  async listPreviewIdentitiesPartial(input: { trainerId: string; scope: 'all_members' }): Promise<NotionPartialPreviewInventory> {
    this.assertTrainer(input.trainerId);
    const binding = this.memberBinding;
    if (input.scope !== 'all_members' || binding.identity.mode !== 'exclusive-data-source-admin-url') fail('NOTION_PARTIAL_SCOPE_INVALID');
    const rowCodes = new Set(['NOTION_ADMIN_URL_REQUIRED', 'NOTION_ADMIN_URL_INVALID', 'NOTION_ADMIN_URL_SCOPE_MISMATCH', 'NOTION_COMPANY_MEMBER_ID_INVALID']);
    const load = async () => {
      await this.validateMembers();
      const pages = await this.query(binding.dataSourceId);
      const identities: NotionPartialPreviewInventory['identities'] = [], reviewRows: NotionPartialPreviewInventory['reviewRows'] = [];
      for (const page of pages) {
        const pageId = string(page.id); resourceId(pageId);
        const label = textValue(page, binding.name), existingStatus = selectValue(page, binding.status);
        try {
          const companyMemberId = this.pageIdentity(page, input.trainerId);
          identities.push({ trainerId: input.trainerId, companyMemberId, pageId, label, existingStatus });
        } catch (error) {
          if (!(error instanceof NotionReviewRequiredError) || !rowCodes.has(error.code)) throw error;
          reviewRows.push({ pageId, label, reason: error.code === 'NOTION_ADMIN_URL_REQUIRED' ? 'missing_admin_url' : 'invalid_admin_url' });
        }
      }
      identities.sort((a,b) => a.pageId.localeCompare(b.pageId));
      reviewRows.sort((a,b) => a.pageId.localeCompare(b.pageId));
      return { identities, reviewRows };
    };
    const first = await load(), snapshotId = fingerprint(first);
    if (snapshotId !== fingerprint(await load())) fail('NOTION_INVENTORY_CHANGED_RETRY');
    return { ...first, queryCoverage: 'complete', identityCoverage: first.reviewRows.length ? 'partial' : 'complete',
      canProveAbsence: first.reviewRows.length === 0, snapshotId };
  }
  async readMembers(trainerId:string):Promise<Member[]>{
    const b=this.memberBinding;
    return (await this.memberPages(trainerId)).map(page=>{
      const status=normalizeMemberStatus(exactMap(b.statuses,selectValue(page,b.status),'NOTION_STATUS_REVIEW_REQUIRED'));
      let fixedSlot:Member['fixedSlot']=null;
      if(b.weekday||b.time){
        if(!b.weekday||!b.time||!b.weekdays||!b.times)fail('NOTION_SLOT_BINDING_INCOMPLETE');
        const day=selectValue(page,b.weekday),time=selectValue(page,b.time);
        if(day!==null||time!==null){
          const weekday=exactMap(b.weekdays,day,'NOTION_WEEKDAY_REVIEW_REQUIRED'),clock=exactMap(b.times,time,'NOTION_TIME_REVIEW_REQUIRED');
          if(!Number.isInteger(weekday)||weekday<1||weekday>7||!Number.isInteger(clock.hour)||clock.hour<0||clock.hour>23||!Number.isInteger(clock.minute)||clock.minute<0||clock.minute>59)fail('NOTION_SLOT_MAPPING_INVALID');
          fixedSlot={weekday,...clock,durationMinutes:60};
        }
      }
      const first=b.firstTraining?dateValue(page,b.firstTraining):null;
      if(first&&(!validDate(first.start)||first.end!==null))fail('NOTION_FIRST_TRAINING_DATE_INVALID');
      const call=b.callAt?dateValue(page,b.callAt):null;
      if(call){timestamp(call.start);if(call.end!==null)fail('NOTION_CALL_DATE_RANGE_UNSUPPORTED');}
      return {trainerId,companyMemberId:this.pageIdentity(page,trainerId),notionPageId:string(page.id),name:textValue(page,b.name),status,fixedSlot,
        firstTrainingDate:first?.start??null,callAt:call?.start??null,registrationDate:null,assignmentDate:null,assignmentEvidence:'unknown',membershipActivity:'unknown',memo:'',survey:[],manualContent:''};
    });
  }
  /** Identity inventory with raw option names for exact no-op detection; no workflow coercion. */
  async listIdentities(input:{trainerId:string;cursor:string|null;scope:'all_members'}):Promise<{identities:Array<{trainerId:string;companyMemberId:string;pageId:string;existingStatus:string|null}>;nextCursor:null;scope:'all_members';completeCoverage:true;snapshotId:string}>{
    if(input.scope!=='all_members'||input.cursor!==null)fail('NOTION_INVENTORY_SCOPE_INVALID');
    const load=async()=>(await this.memberPages(input.trainerId)).map(page=>({trainerId:input.trainerId,companyMemberId:this.pageIdentity(page,input.trainerId),pageId:string(page.id),existingStatus:selectValue(page,this.memberBinding.status)})).sort((a,b)=>a.companyMemberId.localeCompare(b.companyMemberId));
    const identities=await load(),snapshotId=fingerprint(identities);
    // Notion provides no snapshot token. Two complete matching passes detect membership churn.
    if(snapshotId!==fingerprint(await load()))fail('NOTION_INVENTORY_CHANGED_RETRY');
    return {identities,nextCursor:null,scope:'all_members',completeCoverage:true,snapshotId};
  }
  private register(trainerId:string,memberId:string|undefined,lockKey:string,mutations:PlannedMutation[],warnings:string[]=[],existingPageId?:string,expectedStates:Record<string,string>={},verifyScope?:()=>Promise<void>):NotionWritePlan{
    const plan:NotionWritePlan=Object.freeze({trainerId,...(memberId?{companyMemberId:memberId}:{}),...(existingPageId?{existingPageId}:{}),operations:mutations.map(({kind,target,body})=>({kind,target,body:structuredClone(body)})),warnings:[...warnings]});
    this.plans.set(plan,{lockKey,mutations,expectedStates,previewFingerprint:fingerprint(plan),verifyScope});return plan;
  }
  private async expect(path:string,value:unknown,extract:(value:Record<string,unknown>)=>unknown=(value)=>value):Promise<void>{
    const current=await this.client.read(path);if(fingerprint(extract(current))!==fingerprint(value))fail('NOTION_REMOTE_EDIT_PRESERVED');
  }
  /** Dry run: does not create a page, wait for a template, or write local managed state. */
  async planMemberPage(member:Member):Promise<NotionWritePlan>{
    member=normalizeMember(structuredClone(member));
    const existing=await this.findMember(member.trainerId,member.companyMemberId);
    const key=stateKey(member.trainerId,member.companyMemberId);
    const managed=await this.store?.read(key)??{};
    if(managed.pendingWrite)fail('NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED');
    if(existing){
      if(member.notionPageId&&!sameId(member.notionPageId,existing.id))fail('NOTION_MEMBER_PAGE_ID_MISMATCH');
      if(managed.pageId&&!sameId(managed.pageId,existing.id))fail('NOTION_MANAGED_STATE_PAGE_MISMATCH');
      return this.register(member.trainerId,member.companyMemberId,key,[],[],string(existing.id));
    }
    if(member.notionPageId)fail('NOTION_MEMBER_PAGE_ID_MISMATCH');
    if(managed.pageId)fail('NOTION_MANAGED_MEMBER_MISSING_RECONCILIATION_REQUIRED');
    const b=this.memberBinding,template=b.template;
    if(!template||!template.readiness.length)fail('NOTION_TEMPLATE_MAPPING_UNVERIFIED');
    const status=exactMap(b.createStatus,member.status,'NOTION_CREATE_STATUS_UNVERIFIED');
    const props:Record<string,unknown>={[b.name.id]:{title:richText(member.name)},[b.status.id]:{[b.status.type]:{name:status}}};
    if(b.companyUid)props[b.companyUid.id]=companyUidValue(member.companyMemberId,b.companyUid.type);
    if(b.identity.mode==='properties'){
      props[b.identity.trainerId.id]={rich_text:richText(member.trainerId)};props[b.identity.companyMemberId.id]={rich_text:richText(member.companyMemberId)};
    }else{
      if(!/^[A-Za-z0-9_-]+$/.test(member.companyMemberId))fail('NOTION_COMPANY_MEMBER_ID_INVALID');
      props[b.identity.adminUrl.id]={url:`${b.identity.adminOrigin}${b.identity.memberPathPrefix}${member.companyMemberId}`};
    }
    const templates=await collectNotionPages(async cursor=>{
      const result=await this.client.read(`/data_sources/${resourceId(b.dataSourceId)}/templates`,{page_size:'100',...(cursor?{start_cursor:cursor}:{})});
      return {...result,results:result.templates};
    });
    if(!templates.some(item=>sameId(item.id,template.templateId)))fail('NOTION_TEMPLATE_ID_UNVERIFIED');
    return this.register(member.trainerId,member.companyMemberId,key,[{kind:'create-member',method:'POST',target:'/pages',stateKey:key,
      body:{parent:{type:'data_source_id',data_source_id:b.dataSourceId},properties:props,template:{type:'template_id',template_id:template.templateId,timezone:template.timezone}},
      verify:async()=>{if(await this.findMember(member.trainerId,member.companyMemberId))fail('NOTION_MEMBER_ALREADY_EXISTS_REPLAN');},
      committed:(result,state)=>{state.pageId=string(result.id);},
    }],['TEMPLATE_PENDING_AFTER_CREATE: personalization requires a later readiness check'],undefined,{[key]:fingerprint(managed)});
  }
  async ensureMemberPage(member:Member):Promise<{pageId:string}>{
    const plan=await this.planMemberPage(member);if(plan.existingPageId)return {pageId:plan.existingPageId};
    const results=await this.executePlan(plan);return {pageId:string(results[0]!.id)};
  }
  private async blockTree(pageId:string):Promise<NotionBlockTree[]>{
    let count=0;const visited=new Set<string>();
    const load=async(id:string,depth:number):Promise<NotionBlockTree[]>=>{
      if(depth>20||visited.has(id))return fail('NOTION_BLOCK_TREE_LIMIT');visited.add(id);
      const blocks=await collectNotionPages(cursor=>this.client.read(`/blocks/${resourceId(id)}/children`,{page_size:'100',...(cursor?{start_cursor:cursor}:{})}));
      const tree:NotionBlockTree[]=[];
      for(const block of blocks){if(++count>5000)fail('NOTION_BLOCK_TREE_LIMIT');tree.push({block,children:block.has_children===true?await load(string(block.id),depth+1):[]});}
      return tree;
    };return load(pageId,0);
  }
  private ready(tree:NotionBlockTree[]):boolean{
    const template=this.memberBinding.template;if(!template||!template.readiness.length)return false;
    return template.readiness.every(selector=>selectorMatches(tree,selector));
  }
  async awaitTemplate(trainerId:string,companyMemberId:string):Promise<void>{
    const page=await this.findMember(trainerId,companyMemberId);if(!page)fail('NOTION_MEMBER_PAGE_REQUIRED');
    if(!this.memberBinding.template?.readiness.length)fail('NOTION_TEMPLATE_MAPPING_UNVERIFIED');
    for(let attempt=0;attempt<this.templateAttempts;attempt++){
      if(this.ready(await this.blockTree(string(page.id))))return;
      if(attempt+1<this.templateAttempts)await this.sleep(this.templatePollMs);
    }
    // Notion has no public template failure/job-status endpoint. Never reapply a partial template.
    throw new RetryableError('NOTION_TEMPLATE_PENDING_OR_PARTIAL: review before retrying template creation',this.templatePollMs);
  }
  async isMemberPageReady(member:Member):Promise<boolean>{
    if(!member.notionPageId)return false;
    const page=await this.findMember(member.trainerId,member.companyMemberId);
    if(!page||!sameId(page.id,member.notionPageId))return false;
    return this.ready(await this.blockTree(string(page.id)));
  }
  async planMemberFill(member:Member):Promise<NotionWritePlan>{
    member=normalizeMember(structuredClone(member));
    const page=await this.findMember(member.trainerId,member.companyMemberId);if(!page)fail('NOTION_MEMBER_PAGE_REQUIRED');
    const pageId=string(page.id);if(member.notionPageId&&!sameId(pageId,member.notionPageId))fail('NOTION_MEMBER_PAGE_ID_MISMATCH');
    const tree=await this.blockTree(pageId);if(!this.ready(tree))fail('NOTION_TEMPLATE_PENDING_OR_PARTIAL');
    const template=this.memberBinding.template!,key=stateKey(member.trainerId,member.companyMemberId);
    const state=await this.store?.read(key)??{};if(state.pendingWrite)fail('NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED');
    if(state.pageId&&!sameId(state.pageId,pageId))fail('NOTION_MANAGED_STATE_PAGE_MISMATCH');
    const context=structuredClone(template.context(member)),mutations:PlannedMutation[]=[],warnings:string[]=[];
    const groups=new Map<string,typeof template.replacements[number][]>();
    for(const mapping of template.replacements){const selector=JSON.stringify(mapping.path);groups.set(selector,[...(groups.get(selector)??[]),mapping]);}
    for(const mappings of groups.values()){
      const selected=selectBlock(tree,mappings[0]!);if(!selected)fail('NOTION_TEMPLATE_BLOCK_MISSING');
      const block=selected.block,id=string(block.id),actual=blockText(block),previous=state.personalizedBlocks?.[id];
      if(previous){if(fingerprint(actual)!==previous.currentFingerprint)warnings.push('PERSONALIZED_BLOCK_MANUAL_EDIT_PRESERVED');continue;}
      if(actual!==mappings[0]!.expectedText)fail('NOTION_TEMPLATE_CONTEXT_CHANGED');
      const replaced=replacementBody(block,mappings,context);if(replaced.text===actual)continue;
      const isChild=block.type==='child_page';
      mutations.push({kind:isChild?'rename-child-page':'personalize-block',method:'PATCH',target:`/${isChild?'pages':'blocks'}/${resourceId(id)}`,body:replaced.body,stateKey:key,
        verify:()=>this.expect(`/blocks/${resourceId(id)}`,blockContent(block),blockContent),
        committed:(_result,next)=>{next.pageId=pageId;next.personalizedBlocks={...next.personalizedBlocks,[id]:{originalFingerprint:fingerprint(actual),currentFingerprint:fingerprint(replaced.text)}};},
      });
    }
    if(member.survey.length){
      const selector=template.surveyContainer;if(!selector)fail('NOTION_SURVEY_CONTAINER_UNVERIFIED');
      const container=selectBlock(tree,selector);
      if(!container||!selectorMatches(tree,selector))fail('NOTION_SURVEY_CONTAINER_CHANGED');
      const parentId=string(container.block.id);
      for(let index=0;index<member.survey.length;index++){
        const survey=member.survey[index]!,surveyKey=String(index),text=`${survey.question}\n${survey.answer}`;
        const body={paragraph:{rich_text:richText(text)}},known=state.surveyBlocks?.[surveyKey];
        if(known){
          const block=container.children.find(item=>item.block.id===known.blockId)?.block;
          if(!block||fingerprint(blockContent(block))!==known.fingerprint){warnings.push('SURVEY_MANUAL_EDIT_PRESERVED');continue;}
          if(blockText(block)===text)continue;
          mutations.push({kind:'update-survey',method:'PATCH',target:`/blocks/${resourceId(known.blockId)}`,body,stateKey:key,
            verify:()=>this.expect(`/blocks/${resourceId(known.blockId)}`,blockContent(block),blockContent),
            committed:(result,next)=>{next.pageId=pageId;next.surveyBlocks={...next.surveyBlocks,[surveyKey]:{blockId:known.blockId,fingerprint:fingerprint(blockContent(result))}};},
          });
        }else{
          mutations.push({kind:'append-survey',method:'PATCH',target:`/blocks/${resourceId(parentId)}/children`,body:{children:[{object:'block',type:'paragraph',...body}]},stateKey:key,
            verify:()=>this.expect(`/blocks/${resourceId(parentId)}`,blockContent(container.block),blockContent),
            committed:(result,next)=>{const added=array(result.results);if(added.length!==1)fail('NOTION_APPEND_RESPONSE_INVALID');const block=object(added[0]);next.pageId=pageId;next.surveyBlocks={...next.surveyBlocks,[surveyKey]:{blockId:string(block.id),fingerprint:fingerprint(blockContent(block))}};},
          });
        }
      }
    }
    const verifyScope=async()=>{
      const current=await this.findMember(member.trainerId,member.companyMemberId);
      if(!current||!sameId(current.id,pageId))fail('NOTION_MEMBER_SCOPE_CHANGED_REPLAN');
      const currentTree=await this.blockTree(pageId);if(!this.ready(currentTree))fail('NOTION_TEMPLATE_PENDING_OR_PARTIAL');
      for(const mappings of groups.values()){
        const before=selectBlock(tree,mappings[0]!),after=selectBlock(currentTree,mappings[0]!);
        if(!before||!after||!sameId(before.block.id,after.block.id))fail('NOTION_TEMPLATE_BLOCK_MOVED_REPLAN');
      }
      if(template.surveyContainer){
        const before=selectBlock(tree,template.surveyContainer),after=selectBlock(currentTree,template.surveyContainer);
        if(!before||!after||!sameId(before.block.id,after.block.id))fail('NOTION_SURVEY_CONTAINER_MOVED_REPLAN');
      }
    };
    return this.register(member.trainerId,member.companyMemberId,key,mutations,warnings,pageId,{[key]:fingerprint(state)},verifyScope);
  }
  async fillMemberPage(member:Member):Promise<void>{await this.executePlan(await this.planMemberFill(member));}
  /** Plans are single-use capabilities issued by this instance. Edited/forged preview objects cannot execute. */
  async executePlan(plan:NotionWritePlan):Promise<Record<string,unknown>[]>{
    this.client.assertWriteApproved();
    const internal=this.plans.get(plan);if(!internal)fail('NOTION_PLAN_UNKNOWN_OR_ALREADY_EXECUTED');
    if(fingerprint(plan)!==internal.previewFingerprint)fail('NOTION_PLAN_PREVIEW_CHANGED');
    if(!this.store)fail('NOTION_DURABLE_MANAGED_STATE_REQUIRED');
    this.plans.delete(plan);
    return this.store.withLock(internal.lockKey,async()=>{
      for(const [key,expected] of Object.entries(internal.expectedStates))if(fingerprint(await this.store!.read(key)??{})!==expected)fail('NOTION_MANAGED_STATE_CHANGED_REPLAN');
      await internal.verifyScope?.();
      // Check every target before the first write. Official APIs do not provide conditional/atomic writes.
      for(const mutation of internal.mutations){const state=await this.store!.read(mutation.stateKey);if(state?.pendingWrite)fail('NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED');await mutation.verify?.();}
      const results:Record<string,unknown>[]=[];
      for(const mutation of internal.mutations){
        await internal.verifyScope?.();
        const state=structuredClone(await this.store!.read(mutation.stateKey)??{});
        if(state.pendingWrite)fail('NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED');
        await mutation.verify?.();
        state.pendingWrite={operation:mutation.kind};
        await this.store!.write(mutation.stateKey,state);
        let result:Record<string,unknown>;
        try{result=await this.client.write(mutation.method,mutation.target,mutation.body);}
        catch(error){
          // Definite 4xx/rate-limit failures did not commit; uncertain errors retain the journal.
          if(!(error instanceof NotionWriteUncertainError)){delete state.pendingWrite;await this.store!.write(mutation.stateKey,state);}
          throw error;
        }
        try{mutation.committed?.(result,state);}catch{throw new NotionWriteUncertainError();}
        delete state.pendingWrite;state.revision=(state.revision??0)+1;
        try{await this.store!.write(mutation.stateKey,state);}catch{throw new NotionWriteUncertainError();}
        results.push(result);
      }
      return results;
    });
  }
  private calendar():NotionCalendarBinding{if(!this.calendarBinding)return fail('NOTION_CALENDAR_BINDING_REQUIRED');return this.calendarBinding;}
  private async validateCalendar():Promise<NotionCalendarBinding>{
    const b=this.calendar();
    await this.validateSchema(b.databaseId,b.dataSourceId,[b.name,b.trainerId,b.companyMemberId,b.key,b.memberRelation,b.range,b.sourceRange,b.status,b.sourceStatus,b.kind,b.manualOverride],
      [[b.status,[...Object.keys(b.statuses),...Object.values(b.writeStatuses)]],[b.sourceStatus,Object.values(b.writeStatuses)],[b.kind,[...Object.keys(b.kinds),...Object.values(b.writeKinds)]]]);
    const source=await this.client.read(`/data_sources/${resourceId(b.dataSourceId)}`);
    const relation=Object.values(object(source.properties)).map(object).find(prop=>prop.id===b.memberRelation.id)!;
    const target=object(relation.relation);
    if(!sameId(target.data_source_id,this.memberBinding.dataSourceId))fail('NOTION_CALENDAR_RELATION_SCHEMA_MISMATCH');
    return b;
  }
  private async relationIds(page:Record<string,unknown>,binding:NotionProperty<'relation'>):Promise<string[]>{
    const value=property(page,binding);
    if(value.has_more!==true)return array(value.relation).map(raw=>string(object(raw).id));
    const items=await collectNotionPages(cursor=>this.client.read(`/pages/${resourceId(string(page.id))}/properties/${propertyPathId(binding.id)}`,{page_size:'100',...(cursor?{start_cursor:cursor}:{})}));
    return items.map(item=>string(object(item.relation).id));
  }
  private async calendarPages(trainerId:string):Promise<{binding:NotionCalendarBinding;pages:Record<string,unknown>[];events:ScheduleEvent[]}>{
    this.assertTrainer(trainerId);const b=await this.validateCalendar();
    const pages=await this.query(b.dataSourceId,{property:b.trainerId.id,rich_text:{equals:trainerId}}),events:ScheduleEvent[]=[],keys=new Set<string>();
    for(const page of pages){
      if(textValue(page,b.trainerId)!==trainerId||!sameId(object(page.parent).data_source_id,b.dataSourceId))fail('NOTION_CALENDAR_TENANT_MISMATCH');
      const key=textValue(page,b.key),memberId=textValue(page,b.companyMemberId);if(!key||!memberId||keys.has(key))fail('NOTION_CALENDAR_IDENTITY_INVALID');keys.add(key);
      const range=dateValue(page,b.range),source=dateValue(page,b.sourceRange);if(!range?.end||!source?.end)fail('NOTION_CALENDAR_RANGE_REQUIRED');
      rangeValid(range.start,range.end);rangeValid(source.start,source.end);
      const status=exactMap(b.statuses,selectValue(page,b.status),'NOTION_CALENDAR_STATUS_REVIEW_REQUIRED'),sourceStatus=exactMap(b.statuses,selectValue(page,b.sourceStatus),'NOTION_CALENDAR_SOURCE_STATUS_REVIEW_REQUIRED');
      const member=await this.findMember(trainerId,memberId),relations=await this.relationIds(page,b.memberRelation);
      if(!member||relations.length!==1||!sameId(relations[0],member.id))fail('NOTION_CALENDAR_MEMBER_RELATION_MISMATCH');
      const checkbox=property(page,b.manualOverride).checkbox;if(typeof checkbox!=='boolean')fail('NOTION_CALENDAR_OVERRIDE_INVALID');
      events.push({key,trainerId,companyMemberId:memberId,kind:exactMap(b.kinds,selectValue(page,b.kind),'NOTION_CALENDAR_KIND_REVIEW_REQUIRED'),start:range.start,end:range.end,status,
        sourceStart:source.start,sourceEnd:source.end,sourceStatus,manualOverride:checkbox||timestamp(range.start)!==timestamp(source.start)||timestamp(range.end)!==timestamp(source.end)||status!==sourceStatus,notionPageId:string(page.id)});
    }
    return {binding:b,pages,events};
  }
  async readCalendar(trainerId:string):Promise<ScheduleEvent[]>{return (await this.calendarPages(trainerId)).events;}
  async planCalendar(trainerId:string,events:ScheduleEvent[]):Promise<NotionWritePlan>{
    events=structuredClone(events);
    const {binding:b,pages,events:existing}=await this.calendarPages(trainerId),mutations:PlannedMutation[]=[],warnings:string[]=[],seen=new Set<string>();
    const expectedStates:Record<string,string>={},memberScopes:Array<{memberId:string;pageId:string}>=[];
    for(const event of events){
      if(event.trainerId!==trainerId||!event.key||!event.companyMemberId||seen.has(event.key))fail('NOTION_CALENDAR_TENANT_OR_KEY_MISMATCH');seen.add(event.key);
      rangeValid(event.start,event.end);
      if(event.status!=='active'&&event.status!=='cancelled')fail('NOTION_CALENDAR_STATUS_REVIEW_REQUIRED');
      if(event.kind!=='call'&&event.kind!=='training')fail('NOTION_CALENDAR_KIND_REVIEW_REQUIRED');
      const previous=existing.find(item=>item.key===event.key),page=previous?pages.find(item=>sameId(item.id,previous.notionPageId)):undefined;
      if(previous?.companyMemberId!==undefined&&previous.companyMemberId!==event.companyMemberId)fail('NOTION_CALENDAR_MEMBER_IDENTITY_CHANGED');
      if(event.manualOverride||previous?.manualOverride){warnings.push('CALENDAR_MANUAL_OVERRIDE_PRESERVED');continue;}
      if(previous&&previous.kind!==event.kind){warnings.push('CALENDAR_KIND_EDIT_PRESERVED');continue;}
      const member=await this.findMember(trainerId,event.companyMemberId);if(!member||!this.ready(await this.blockTree(string(member.id))))fail('NOTION_CALENDAR_MEMBER_TEMPLATE_REQUIRED');
      memberScopes.push({memberId:event.companyMemberId,pageId:string(member.id)});
      const props:Record<string,unknown>={[b.name.id]:{title:richText(`${event.kind} ${event.key}`)},[b.trainerId.id]:{rich_text:richText(trainerId)},[b.companyMemberId.id]:{rich_text:richText(event.companyMemberId)},[b.key.id]:{rich_text:richText(event.key)},
        [b.memberRelation.id]:{relation:[{id:string(member.id)}]},[b.range.id]:{date:{start:event.start,end:event.end}},[b.sourceRange.id]:{date:{start:event.start,end:event.end}},
        [b.status.id]:{[b.status.type]:{name:b.writeStatuses[event.status]}},[b.sourceStatus.id]:{[b.sourceStatus.type]:{name:b.writeStatuses[event.status]}},[b.kind.id]:{select:{name:b.writeKinds[event.kind]}},[b.manualOverride.id]:{checkbox:false}};
      const key=`notion:calendar:${encodeURIComponent(trainerId)}:${encodeURIComponent(event.key)}`;
      const managed=await this.store?.read(key)??{};if(managed.pendingWrite)fail('NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED');
      if(managed.pageId&&(!page||!sameId(page.id,managed.pageId)))fail('NOTION_MANAGED_CALENDAR_MISSING_RECONCILIATION_REQUIRED');
      expectedStates[key]=fingerprint(managed);
      if(page){
        if(timestamp(previous!.start)===timestamp(event.start)&&timestamp(previous!.end)===timestamp(event.end)&&previous!.status===event.status&&previous!.kind===event.kind)continue;
        const updateProps=Object.fromEntries([b.range,b.sourceRange,b.status,b.sourceStatus,b.manualOverride].map(ref=>[ref.id,props[ref.id]]));
        mutations.push({kind:'update-calendar',method:'PATCH',target:`/pages/${resourceId(string(page.id))}`,body:{properties:updateProps},stateKey:key,
          verify:()=>this.expect(`/pages/${resourceId(string(page.id))}`,page.properties,current=>{
            if(current.archived===true||current.in_trash===true||!sameId(object(current.parent).data_source_id,b.dataSourceId))fail('NOTION_CALENDAR_SCOPE_CHANGED_REPLAN');return current.properties;
          }),committed:(_result,state)=>{state.pageId=string(page.id);}});
      }else{
        mutations.push({kind:'create-calendar',method:'POST',target:'/pages',body:{parent:{type:'data_source_id',data_source_id:b.dataSourceId},properties:props},stateKey:key,
          verify:async()=>{if((await this.query(b.dataSourceId,{and:[{property:b.trainerId.id,rich_text:{equals:trainerId}},{property:b.key.id,rich_text:{equals:event.key}}]})).length)fail('NOTION_CALENDAR_ALREADY_EXISTS_REPLAN');},committed:(result,state)=>{state.pageId=string(result.id);}});
      }
    }
    const verifyScope=async()=>{
      for(const scope of memberScopes){const current=await this.findMember(trainerId,scope.memberId);if(!current||!sameId(current.id,scope.pageId)||!this.ready(await this.blockTree(scope.pageId)))fail('NOTION_CALENDAR_MEMBER_SCOPE_CHANGED_REPLAN');}
    };
    return this.register(trainerId,undefined,`notion:calendar:${encodeURIComponent(trainerId)}`,mutations,warnings,undefined,expectedStates,verifyScope);
  }
  async writeCalendar(trainerId:string,events:ScheduleEvent[]):Promise<void>{await this.executePlan(await this.planCalendar(trainerId,events));}
}
