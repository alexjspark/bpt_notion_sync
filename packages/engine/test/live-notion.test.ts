import test from 'node:test';
import assert from 'node:assert/strict';
import type { Member, ScheduleEvent } from '@trainer/core';
import { OfficialNotionAdapter, OfficialNotionClient, NotionWriteUncertainError } from '../src/live-notion.ts';
import type { NotionCalendarBinding, NotionManagedState, NotionManagedStateStore, NotionMemberBinding, NotionProperty, NotionRequest } from '../src/live-notion.ts';
import { blockContent, fingerprint, richText } from '../src/live-notion-template.ts';

const ref=<T extends string>(id:string,type:T):NotionProperty<T>=>({id,type});
const member:Member={trainerId:'trainer-synthetic',companyMemberId:'company-synthetic',name:'Synthetic Member',status:'신규',notionPageId:null,registrationDate:null,assignmentDate:null,assignmentEvidence:'unknown',membershipActivity:'unknown',memo:'',fixedSlot:null,firstTrainingDate:null,callAt:null,survey:[],manualContent:''};
const members:NotionMemberBinding={databaseId:'member-db',dataSourceId:'member-source',allowedTrainerIds:[member.trainerId],identity:{mode:'properties',trainerId:ref('trainer','rich_text'),companyMemberId:ref('company','rich_text')},name:ref('title','title'),status:ref('status','select'),statuses:{New:'신규',Active:'진행'},createStatus:{신규:'New'},
  template:{templateId:'synthetic-template',timezone:'Asia/Seoul',readiness:[{path:[0],type:'heading_1',expectedText:'Template ready'},{path:[3],type:'toggle',expectedText:'Raw survey'}],replacements:[{path:[1],type:'paragraph',expectedText:'Welcome @@@@',ownership:'template',token:'@@@@',occurrence:1,contextKey:'memberName'},{path:[2],type:'child_page',expectedText:'000 growth history',ownership:'template',token:'000',occurrence:1,contextKey:'memberName'}],surveyContainer:{path:[3],type:'toggle',expectedText:'Raw survey'},context:value=>({memberName:value.name})}};
const calendar:NotionCalendarBinding={databaseId:'calendar-db',dataSourceId:'calendar-source',name:ref('title','title'),trainerId:ref('trainer','rich_text'),companyMemberId:ref('company','rich_text'),key:ref('key','rich_text'),memberRelation:ref('relation','relation'),range:ref('range','date'),sourceRange:ref('source-range','date'),status:ref('status','select'),sourceStatus:ref('source-status','select'),statuses:{Active:'active',Cancelled:'cancelled'},writeStatuses:{active:'Active',cancelled:'Cancelled'},kind:ref('kind','select'),kinds:{Call:'call',Training:'training'},writeKinds:{call:'Call',training:'Training'},manualOverride:ref('override','checkbox')};
function value(binding:NotionProperty,payload:unknown):Record<string,unknown>{return {id:binding.id,type:binding.type,[binding.type]:payload};}
function page(id='member-page',company=member.companyMemberId,status='New'):Record<string,unknown>{
  return {object:'page',id,parent:{type:'data_source_id',data_source_id:members.dataSourceId},properties:{Trainer:value(ref('trainer','rich_text'),richText(member.trainerId)),Company:value(ref('company','rich_text'),richText(company)),Name:value(members.name,richText(member.name)),Status:value(members.status,{name:status})}};
}
function block(id:string,type:string,text:string,hasChildren=false):Record<string,unknown>{return {object:'block',id,type,has_children:hasChildren,[type]:type==='child_page'?{title:text}:{rich_text:richText(text)}};}
function eventPage(overrides:Partial<ScheduleEvent>={}):Record<string,unknown>{
  const event={key:'event-synthetic',trainerId:member.trainerId,companyMemberId:member.companyMemberId,kind:'training',start:'2026-10-25T10:00:00+09:00',end:'2026-10-25T11:00:00+09:00',sourceStart:'2026-10-25T10:00:00+09:00',sourceEnd:'2026-10-25T11:00:00+09:00',status:'active',sourceStatus:'active',manualOverride:false,...overrides} as ScheduleEvent;
  const props:Record<string,unknown>={};
  for(const [binding,payload] of [[calendar.name,richText('User-maintained title')],[calendar.trainerId,richText(event.trainerId)],[calendar.companyMemberId,richText(event.companyMemberId)],[calendar.key,richText(event.key)],[calendar.memberRelation,[{id:'member-page'}]],[calendar.range,{start:event.start,end:event.end}],[calendar.sourceRange,{start:event.sourceStart,end:event.sourceEnd}],[calendar.status,{name:event.status==='active'?'Active':'Cancelled'}],[calendar.sourceStatus,{name:event.sourceStatus==='active'?'Active':'Cancelled'}],[calendar.kind,{name:'Training'}],[calendar.manualOverride,event.manualOverride]] as Array<[NotionProperty,unknown]>)props[binding.id]=value(binding,payload);
  return {object:'page',id:'calendar-page',parent:{type:'data_source_id',data_source_id:calendar.dataSourceId},properties:props};
}
function stateStore(){
  const values=new Map<string,NotionManagedState>();
  const store:NotionManagedStateStore={withLock:async(_key,work)=>work(),read:async key=>values.has(key)?structuredClone(values.get(key)):undefined,write:async(key,state)=>{values.set(key,structuredClone(state));}};
  return {store,values};
}
function harness(binding=members,writeApproved=false){
  const requests:NotionRequest[]=[],writes:NotionRequest[]=[];
  let memberRows=[page()],calendarRows=[eventPage()];
  let queryHook:((source:string,body:Record<string,unknown>)=>Record<string,unknown>)|undefined;
  let propertyHook:((url:URL)=>Record<string,unknown>)|undefined;
  let writeFailure=false;
  const children:Record<string,Record<string,unknown>[]>= {'member-page':[block('ready','heading_1','Template ready'),block('welcome','paragraph','Welcome @@@@'),block('history','child_page','000 growth history'),block('survey','toggle','Raw survey',true)],survey:[block('manual','paragraph','A manual note with $$$ and @@')]};
  const schemas:Record<string,unknown>={};
  const refs=[binding.name,binding.status,...(binding.companyUid?[binding.companyUid]:[]),...(binding.identity.mode==='properties'?[binding.identity.trainerId,binding.identity.companyMemberId]:[binding.identity.adminUrl])];
  schemas[binding.dataSourceId]={properties:Object.fromEntries(refs.map(item=>[item.id,{id:item.id,type:item.type,...(item.type==='select'?{select:{options:[{name:'New'},{name:'Active'}]}}:{})}]))};
  const calendarRefs=[calendar.name,calendar.trainerId,calendar.companyMemberId,calendar.key,calendar.memberRelation,calendar.range,calendar.sourceRange,calendar.status,calendar.sourceStatus,calendar.kind,calendar.manualOverride];
  schemas[calendar.dataSourceId]={properties:Object.fromEntries(calendarRefs.map(item=>[item.id,{id:item.id,type:item.type,...(item.type==='select'?{select:{options:(item.id==='kind'?['Call','Training']:['Active','Cancelled']).map(name=>({name}))}}:{}),...(item.type==='relation'?{relation:{data_source_id:members.dataSourceId}}:{})}]))};
  const transport=async(request:NotionRequest)=>{
    requests.push(request);const url=new URL(request.url),path=url.pathname.replace('/v1','');
    if(request.method==='PATCH'||(request.method==='POST'&&path==='/pages')){
      writes.push(request);if(writeFailure)return {status:504,body:{code:'gateway_timeout'}};
      if(path==='/pages')return {status:200,body:{object:'page',id:'created-page'}};
      const id=path.split('/')[2]!;const body=request.body as Record<string,unknown>;
      if(path.endsWith('/children')){const added=(body.children as Record<string,unknown>[]).map((item,index)=>({...item,id:`added-${writes.length}-${index}`}));children[id]!.push(...added);return {status:200,body:{results:added}};}
      if(path.startsWith('/blocks/')){
        const old=Object.values(children).flat().find(item=>item.id===id)!;Object.assign(old,body);return {status:200,body:structuredClone(old)};
      }
      return {status:200,body:{object:'page',id}};
    }
    if(path.startsWith('/databases/'))return {status:200,body:{data_sources:[{id:path.includes('calendar')?calendar.dataSourceId:binding.dataSourceId}]}};
    if(path.endsWith('/templates'))return {status:200,body:{templates:[{id:'synthetic-template'}],has_more:false,next_cursor:null}};
    if(path.startsWith('/data_sources/')&&path.endsWith('/query')){
      const source=path.split('/')[2]!,body=request.body as Record<string,unknown>;
      if(queryHook)return {status:200,body:queryHook(source,body)};
      return {status:200,body:{results:source===calendar.dataSourceId?calendarRows:memberRows,has_more:false,next_cursor:null}};
    }
    if(path.startsWith('/data_sources/'))return {status:200,body:schemas[path.split('/')[2]!]};
    if(path.startsWith('/blocks/')&&path.endsWith('/children'))return {status:200,body:{results:children[path.split('/')[2]!]??[],has_more:false,next_cursor:null}};
    if(path.startsWith('/blocks/'))return {status:200,body:structuredClone(Object.values(children).flat().find(item=>item.id===path.split('/')[2]))};
    if(path.includes('/properties/')&&propertyHook)return {status:200,body:propertyHook(url)};
    if(path.startsWith('/pages/'))return {status:200,body:structuredClone([...memberRows,...calendarRows].find(item=>item.id===path.split('/')[2]))};
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  };
  const state=stateStore(),client=new OfficialNotionClient({token:'synthetic-token',transport,readPermit:{approved:true},...(writeApproved?{writePermit:{approved:true}}:{})});
  const adapter=new OfficialNotionAdapter({client,members:binding,calendar,stateStore:state.store,templateAttempts:2,templatePollMs:0,sleep:async()=>{}});
  return {adapter,requests,writes,children,schemas,state,...{
    setMembers:(rows:Record<string,unknown>[])=>{memberRows=rows;},setCalendar:(rows:Record<string,unknown>[])=>{calendarRows=rows;},setQuery:(hook:typeof queryHook)=>{queryHook=hook;},setProperty:(hook:typeof propertyHook)=>{propertyHook=hook;},setWriteFailure:()=>{writeFailure=true;},
  }};
}

test('inventory follows all official cursors using stable identity rather than duplicate names',async()=>{
  const h=harness();h.setQuery((_source,body)=>({results:[page(body.start_cursor?'page-two':'page-one',body.start_cursor?'company-two':'company-one')],has_more:!body.start_cursor,next_cursor:body.start_cursor?null:'next'}));
  const result=await h.adapter.listIdentities({trainerId:member.trainerId,cursor:null,scope:'all_members'});
  assert.equal(result.completeCoverage,true);assert.equal(result.identities.length,2);assert.equal(result.nextCursor,null);
  assert.deepEqual(result.identities.map(item=>item.companyMemberId),['company-one','company-two']);
  const queries=h.requests.filter(item=>item.url.includes('/query'));
  assert.deepEqual((queries[0]!.body as Record<string,unknown>).filter,{property:'trainer',rich_text:{equals:member.trainerId}});
  assert.equal(h.writes.length,0);
});

test('member lookup queries both stable IDs and validates tenant / schema / duplicates',async()=>{
  const h=harness();const result=await h.adapter.planMemberPage(member);assert.equal(result.existingPageId,'member-page');
  assert.deepEqual((h.requests.find(item=>item.url.includes('/query'))!.body as Record<string,unknown>).filter,{and:[{property:'trainer',rich_text:{equals:member.trainerId}},{property:'company',rich_text:{equals:member.companyMemberId}}]});
  const missing=harness();delete ((missing.schemas[members.dataSourceId] as {properties:Record<string,unknown>}).properties.trainer);
  await assert.rejects(missing.adapter.readMembers(member.trainerId),/NOTION_SCHEMA_BINDING_MISSING/);
  await assert.rejects(h.adapter.readMembers('another-trainer'),/NOTION_TRAINER_SCOPE_MISMATCH/);
  h.setMembers([page(),page('page-two')]);await assert.rejects(h.adapter.readMembers(member.trainerId),/NOTION_DUPLICATE_MEMBER_ID/);
  assert.equal(h.writes.length,0);
});

test('unknown statuses require review while identity-only inventory stays read-only',async()=>{
  const h=harness();h.setMembers([page('member-page',member.companyMemberId,'Unmapped status')]);
  await assert.rejects(h.adapter.readMembers(member.trainerId),/NOTION_STATUS_REVIEW_REQUIRED/);
  assert.equal((await h.adapter.listIdentities({trainerId:member.trainerId,cursor:null,scope:'all_members'})).identities.length,1);
});

test('exclusive data-source identity requires explicit ownership and exact canonical admin origin/path',async()=>{
  const binding:NotionMemberBinding={...members,identity:{mode:'exclusive-data-source-admin-url',trainerId:member.trainerId,exclusiveOwnershipApproved:true,adminUrl:ref('admin','url'),adminOrigin:'https://company.example',memberPathPrefix:'/manage/members/'}};
  const h=harness(binding);const row=page();(row.properties as Record<string,unknown>).Admin=value(ref('admin','url'),'https://company.example/manage/members/company-synthetic');h.setMembers([row]);
  assert.equal((await h.adapter.readMembers(member.trainerId))[0]!.companyMemberId,member.companyMemberId);
  (row.properties as Record<string,unknown>).Admin=value(ref('admin','url'),'https://foreign.example/manage/members/company-synthetic');
  await assert.rejects(h.adapter.readMembers(member.trainerId),/NOTION_ADMIN_URL_SCOPE_MISMATCH/);
  assert.throws(()=>harness({...binding,identity:{...binding.identity,exclusiveOwnershipApproved:false} as unknown as typeof binding.identity}),/NOTION_EXCLUSIVE_OWNERSHIP_REQUIRED/);
});

test('nonempty and partially duplicated templates never prove readiness or trigger reapplication',async()=>{
  const h=harness();h.children['member-page']!.pop();
  assert.equal(await h.adapter.isMemberPageReady({...member,notionPageId:'member-page'}),false);
  await assert.rejects(h.adapter.awaitTemplate(member.trainerId,member.companyMemberId),/NOTION_TEMPLATE_PENDING_OR_PARTIAL/);
  await assert.rejects(h.adapter.planMemberFill(member),/NOTION_TEMPLATE_PENDING_OR_PARTIAL/);
  assert.equal(h.writes.length,0);
});

test('create dry-run uses official template parameters and default execution is denied',async()=>{
  const h=harness();h.setMembers([]);const plan=await h.adapter.planMemberPage(member);
  assert.equal(plan.operations.length,1);const body=plan.operations[0]!.body;
  assert.deepEqual(body.parent,{type:'data_source_id',data_source_id:members.dataSourceId});
  assert.deepEqual(body.template,{type:'template_id',template_id:'synthetic-template',timezone:'Asia/Seoul'});assert.ok(!('children'in body));
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_WRITE_NOT_APPROVED/);assert.equal(h.writes.length,0);assert.equal(h.state.values.size,0);
});

test('injected write permit executes only issued plan, journals outcome, and never replays uncertain creation',async()=>{
  const h=harness(members,true);h.setMembers([]);const plan=await h.adapter.planMemberPage(member);
  await h.adapter.executePlan(plan);assert.equal(h.writes.length,1);assert.equal([...h.state.values.values()][0]!.pageId,'created-page');
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_PLAN_UNKNOWN_OR_ALREADY_EXECUTED/);
  const uncertain=harness(members,true);uncertain.setMembers([]);uncertain.setWriteFailure();
  await assert.rejects(uncertain.adapter.executePlan(await uncertain.adapter.planMemberPage(member)),NotionWriteUncertainError);
  assert.ok([...uncertain.state.values.values()][0]!.pendingWrite);
  await assert.rejects(async()=>uncertain.adapter.executePlan(await uncertain.adapter.planMemberPage(member)),/NOTION_PENDING_WRITE_RECONCILIATION_REQUIRED/);
  assert.equal(uncertain.writes.length,1);
});

test('personalization and raw survey append target only configured blocks, child-page rename uses pages endpoint',async()=>{
  const h=harness();const plan=await h.adapter.planMemberFill({...member,survey:[{question:'Exact question\nline',answer:'  Raw answer @@ $$$\n末尾  '}]});
  assert.deepEqual(plan.operations.map(operation=>operation.target),['/blocks/welcome','/pages/history','/blocks/survey/children']);
  assert.ok(!plan.operations.some(operation=>operation.target.includes('manual')));
  const child=plan.operations.find(operation=>operation.kind==='rename-child-page')!;
  assert.equal(((child.body.properties as Record<string,{title:Array<{text:{content:string}}>}>).title!.title[0]!.text.content),'Synthetic Member growth history');
  const append=plan.operations.find(operation=>operation.kind==='append-survey')!;
  assert.equal((((append.body.children as Array<{paragraph:{rich_text:Array<{text:{content:string}}>}}>)[0]!.paragraph.rich_text)[0]!.text.content),'Exact question\nline\n  Raw answer @@ $$$\n末尾  ');
  assert.equal(h.writes.length,0);
});

test('managed survey IDs preserve manual changes and preflight refuses intervening remote edits',async()=>{
  const h=harness(members,true),managed=block('managed','paragraph','old question\nold answer');h.children.survey!.push(managed);
  await h.state.store.write('notion:member:trainer-synthetic:company-synthetic',{pageId:'member-page',surveyBlocks:{'0':{blockId:'managed',fingerprint:fingerprint(blockContent(managed))}}});
  Object.assign(managed,block('managed','paragraph','Human edited answer'));
  const preserved=await h.adapter.planMemberFill({...member,survey:[{question:'old question',answer:'new answer'}]});
  assert.ok(preserved.warnings.includes('SURVEY_MANUAL_EDIT_PRESERVED'));assert.ok(!preserved.operations.some(operation=>operation.kind==='update-survey'));
  const plan=await h.adapter.planMemberFill(member);Object.assign(h.children['member-page']![1]!,block('welcome','paragraph','Human edited greeting'));
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_REMOTE_EDIT_PRESERVED/);assert.equal(h.writes.length,0);
});

test('calendar manual date/status overrides are detected and preserved; unknown statuses fail review',async()=>{
  const h=harness();h.setCalendar([eventPage({start:'2026-10-25T10:30:00+09:00',end:'2026-10-25T11:30:00+09:00'})]);
  const saved=await h.adapter.readCalendar(member.trainerId);assert.equal(saved[0]!.manualOverride,true);
  const plan=await h.adapter.planCalendar(member.trainerId,[{...saved[0]!,manualOverride:false,start:'2026-10-25T10:00:00+09:00',end:'2026-10-25T11:00:00+09:00'}]);
  assert.equal(plan.operations.length,0);assert.ok(plan.warnings.includes('CALENDAR_MANUAL_OVERRIDE_PRESERVED'));
  const unknown=eventPage();(unknown.properties as Record<string,Record<string,unknown>>).status!.select={name:'Unmapped'};h.setCalendar([unknown]);
  await assert.rejects(h.adapter.readCalendar(member.trainerId),/NOTION_CALENDAR_STATUS_REVIEW_REQUIRED/);
});

test('calendar updates only managed scheduling fields and create requires stable key, ready member relation and explicit offset range',async()=>{
  const h=harness();const event=(await h.adapter.readCalendar(member.trainerId))[0]!;
  const plan=await h.adapter.planCalendar(member.trainerId,[{...event,start:'2026-10-25T12:00:00+09:00',end:'2026-10-25T13:00:00+09:00'}]);
  assert.deepEqual(Object.keys(plan.operations[0]!.body.properties as object).sort(),['override','range','source-range','source-status','status']);
  h.setCalendar([]);const create=await h.adapter.planCalendar(member.trainerId,[event]);
  assert.deepEqual((create.operations[0]!.body.properties as Record<string,unknown>).relation,{relation:[{id:'member-page'}]});
  await assert.rejects(h.adapter.planCalendar(member.trainerId,[{...event,start:'2026-10-25T10:00:00'}]),/NOTION_TIMESTAMP_OFFSET_REQUIRED/);
  await assert.rejects(h.adapter.planCalendar(member.trainerId,[{...event,trainerId:'different'}]),/NOTION_CALENDAR_TENANT_OR_KEY_MISMATCH/);
  h.children['member-page']!.pop();await assert.rejects(h.adapter.planCalendar(member.trainerId,[event]),/NOTION_CALENDAR_MEMBER_TEMPLATE_REQUIRED/);
  assert.equal(h.writes.length,0);
});

test('incomplete official query responses never claim full inventory coverage',async()=>{
  const h=harness();h.setQuery(()=>({results:[page()],has_more:false,next_cursor:null,request_status:{type:'incomplete'}}));
  await assert.rejects(h.adapter.listIdentities({trainerId:member.trainerId,cursor:null,scope:'all_members'}),/NOTION_QUERY_INCOMPLETE/);assert.equal(h.writes.length,0);
});

test('inventory detects identity changes between complete read passes',async()=>{
  const h=harness();let pass=0;h.setQuery(()=>({results:[page('member-page',++pass===1?'company-one':'company-two')],has_more:false,next_cursor:null}));
  await assert.rejects(h.adapter.listIdentities({trainerId:member.trainerId,cursor:null,scope:'all_members'}),/NOTION_INVENTORY_CHANGED_RETRY/);assert.equal(h.writes.length,0);
});

test('calendar relation pagination reads beyond the first property page before accepting a relation',async()=>{
  const h=harness(),row=eventPage();(row.properties as Record<string,Record<string,unknown>>).relation!.has_more=true;h.setCalendar([row]);
  h.setProperty(url=>({results:[{object:'property_item',id:'relation',type:'relation',relation:{id:url.searchParams.has('start_cursor')?'foreign-member-page':'member-page'}}],has_more:!url.searchParams.has('start_cursor'),next_cursor:url.searchParams.has('start_cursor')?null:'relation-next'}));
  await assert.rejects(h.adapter.readCalendar(member.trainerId),/NOTION_CALENDAR_MEMBER_RELATION_MISMATCH/);
  assert.equal(h.requests.filter(request=>request.url.includes('/properties/')).length,2);assert.equal(h.writes.length,0);
});

test('mutating a preview body invalidates its execution capability',async()=>{
  const h=harness(members,true);h.setMembers([]);const plan=await h.adapter.planMemberPage(member);
  (plan.operations[0]!.body as Record<string,unknown>).parent={type:'data_source_id',data_source_id:'foreign-source'};
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_PLAN_PREVIEW_CHANGED/);assert.equal(h.writes.length,0);
});

test('two previews from the same managed revision cannot append duplicate survey blocks',async()=>{
  const h=harness({...members,template:{...members.template!,replacements:[]}},true),surveyMember={...member,survey:[{question:'Synthetic raw question',answer:'Synthetic raw answer'}]};
  const first=await h.adapter.planMemberFill(surveyMember),stale=await h.adapter.planMemberFill(surveyMember);
  await h.adapter.executePlan(first);assert.equal(h.writes.length,1);
  await assert.rejects(h.adapter.executePlan(stale),/NOTION_MANAGED_STATE_CHANGED_REPLAN/);assert.equal(h.writes.length,1);
});

test('fill execution revalidates member identity after planning before writing any blocks',async()=>{
  const h=harness(members,true),plan=await h.adapter.planMemberFill(member),reassigned=page();
  (reassigned.properties as Record<string,unknown>).Trainer=value(ref('trainer','rich_text'),richText('different-trainer'));h.setMembers([reassigned]);
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_TRAINER_SCOPE_MISMATCH/);assert.equal(h.writes.length,0);
});

test('calendar execution revalidates member readiness after planning before writing',async()=>{
  const h=harness(members,true),event=(await h.adapter.readCalendar(member.trainerId))[0]!;h.setCalendar([]);
  const plan=await h.adapter.planCalendar(member.trainerId,[event]);h.children['member-page']!.pop();
  await assert.rejects(h.adapter.executePlan(plan),/NOTION_CALENDAR_MEMBER_SCOPE_CHANGED_REPLAN/);assert.equal(h.writes.length,0);
});

test('durable personalization metadata persists only fingerprints rather than member text',async()=>{
  const h=harness({...members,template:{...members.template!,replacements:[members.template!.replacements[0]!]}},true);
  await h.adapter.executePlan(await h.adapter.planMemberFill(member));
  const state=[...h.state.values.values()][0]!,saved=state.personalizedBlocks!.welcome!;
  assert.match(saved.originalFingerprint,/^[a-f0-9]{64}$/);assert.match(saved.currentFingerprint,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(state).includes(member.name));assert.ok(!JSON.stringify(state).includes('@@@@'));assert.equal(state.revision,1);
});

test('renamed 신규 status reads canonically and explicit legacy aliases never recreate a 카톡전 option',async()=>{
  const binding:NotionMemberBinding={...members,statuses:{'신규':'신규','카톡전':'카톡전',Active:'진행'},createStatus:{신규:'신규'}};
  const h=harness(binding),schema=h.schemas[members.dataSourceId] as {properties:Record<string,Record<string,unknown>>};
  schema.properties.status!.select={options:[{name:'신규'},{name:'Active'}]};h.setMembers([page('member-page',member.companyMemberId,'신규')]);
  assert.equal((await h.adapter.readMembers(member.trainerId))[0]!.status,'신규');
  h.setMembers([page('member-page',member.companyMemberId,'카톡전')]);assert.equal((await h.adapter.readMembers(member.trainerId))[0]!.status,'신규');
  h.setMembers([]);const plan=await h.adapter.planMemberPage({...member,status:'카톡전'} as unknown as Member);
  assert.deepEqual((plan.operations[0]!.body.properties as Record<string,unknown>).status,{select:{name:'신규'}});
  assert.throws(()=>harness({...binding,createStatus:{신규:'카톡전'}}),/NOTION_LEGACY_STATUS_WRITE_FORBIDDEN/);assert.equal(h.writes.length,0);
});

test('withdrawal request requires explicit compact option mapping and rejects absent spaced labels',async()=>{
  const binding:NotionMemberBinding={...members,statuses:{...members.statuses,'탈퇴요청':'탈퇴 요청'}};
  const h=harness(binding),schema=h.schemas[members.dataSourceId] as {properties:Record<string,Record<string,unknown>>};
  schema.properties.status!.select={options:[{name:'New'},{name:'Active'},{name:'탈퇴요청'}]};h.setMembers([page('member-page',member.companyMemberId,'탈퇴요청')]);
  assert.equal((await h.adapter.readMembers(member.trainerId))[0]!.status,'탈퇴 요청');
  const absent=harness({...members,statuses:{...members.statuses,'탈퇴 요청':'탈퇴 요청'}});
  await assert.rejects(absent.adapter.readMembers(member.trainerId),/NOTION_SELECT_OPTION_UNVERIFIED/);assert.equal(h.writes.length,0);
});

test('explicit UID binding participates in schema validation and new-page properties without guessing a numeric conversion',async()=>{
 for(const [type,uid]of [['rich_text','001234'],['number','1234']]as const){const binding={...members,companyUid:ref('explicit-uid',type)},h=harness(binding);h.setMembers([]);const plan=await h.adapter.planMemberPage({...member,companyMemberId:uid});const props=plan.operations[0]!.body.properties as Record<string,unknown>;assert.deepEqual(props['explicit-uid'],type==='rich_text'?{rich_text:[{type:'text',text:{content:uid}}]}:{number:1234});assert.equal(h.writes.length,0);}
 const h=harness({...members,companyUid:ref('explicit-uid','number')});h.setMembers([]);await assert.rejects(h.adapter.planMemberPage({...member,companyMemberId:'001234'}),/REPRESENTATION_UNSAFE/);assert.equal(h.writes.length,0);
});
