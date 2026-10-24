import{parseNotionDestination}from'./runtime-scopes.ts';import type{NotionDestinationScope}from'./runtime-scopes.ts';
import{NotionReviewRequiredError,object,array,NOTION_API_ORIGIN}from'./live-notion-client.ts';
import type{NotionTransport,NotionRequest}from'./live-notion-client.ts';import type{MemberInfoSchema}from'./member-info-store.ts';import{textValue}from'./member-info-store.ts';
export const TEST_VALUES={phone:'00000000000',manualPhone:'00000000001',email:'initial@trainersync.invalid',manualEmail:'manual@trainersync.invalid',filledEmail:'filled-empty@trainersync.invalid'}as const;
export const initialTestText=(id:string)=>'TEST TrainerSync synthetic storage fixture | '+id;
export const manualTestText=(id:string)=>'USER MANUAL EDIT - PRESERVE BODY | '+id;
export interface TestScope{testId:string;pageId:string|null;createAttempted:boolean}
export function createIsolatedStorageTransport(options:{destination:NotionDestinationScope;scope:()=>TestScope;schema:()=>MemberInfoSchema|undefined;delegate:NotionTransport;
 beforeWrite:(request:NotionRequest,kind:'new-test-page'|'test-page'|'test-body',ids:string[])=>Promise<void>;created:(id:string)=>Promise<void>;allowTestRestore?:boolean}):NotionTransport{
 const destination=parseNotionDestination(options.destination);
 const fail=():never=>{throw new NotionReviewRequiredError('ISOLATED_TRANSPORT_SCOPE_REJECTED');};
 return async request=>{
  const scope=options.scope(),s=options.schema(),u=new URL(request.url),path=u.pathname.replace(/^\/v1/,'');
  if(u.origin!==NOTION_API_ORIGIN||!/^trainersync-test-[a-f0-9-]{36}$/.test(scope.testId))return fail();
  const source='/data_sources/'+destination.dataSourceId,db='/databases/'+destination.databaseId;
  const query=request.method==='POST'&&path===source+'/query';
  if(request.method==='GET'||query){
    const allowed=request.method==='GET'&&[source,db,...(scope.pageId?['/pages/'+scope.pageId,'/blocks/'+scope.pageId+'/children']:[])].includes(path);
    if(query){if(!s||object(object(request.body).filter).property!==s.admin||object(object(object(request.body).filter).url).equals!=='https://admin.biz-pt.com/manage/members/'+scope.testId)return fail();}
    else if(!allowed)return fail();
    return options.delegate(request);
  }
  if(!s||s.databaseId!==destination.databaseId||s.dataSourceId!==destination.dataSourceId)return fail();const body=object(request.body),title='TEST TrainerSync | '+scope.testId,admin='https://admin.biz-pt.com/manage/members/'+scope.testId;
  let kind:'new-test-page'|'test-page'|'test-body',ids:string[]=[];
  const checkProperties=(properties:unknown,create=false)=>{
    const p=object(properties);ids=Object.keys(p);const allowed=create?[s.name,s.status,s.admin,s.phone,s.email]:[s.status,s.phone,s.email,s.firstTraining];
    if(!ids.length||ids.some(id=>!allowed.includes(id))||create&&(ids.length!==5||!ids.includes(s.admin)))return fail();
    for(const[id,raw]of Object.entries(p)){const v=object(raw);
      if(id===s.name){if(!create||textValue(v.title)!==title)return fail();}
      else if(id===s.admin){if(!create||v.url!==admin)return fail();}
      else if(id===s.phone){if(![TEST_VALUES.phone,TEST_VALUES.manualPhone,null].includes(v.phone_number as never))return fail();}
      else if(id===s.email){if(![TEST_VALUES.email,TEST_VALUES.manualEmail,TEST_VALUES.filledEmail,null].includes(v.email as never))return fail();}
      else if(id===s.status){if(!['\uc2e0\uaddc','\uc720\uc608'].includes(String(object(v.select).name)))return fail();}
      else if(id===s.firstTraining){if(object(v.date).start!=='2099-01-01')return fail();}
    }
  };
  if(request.method==='POST'&&path==='/pages'){
    if(scope.pageId||!scope.createAttempted||Object.keys(body).some(k=>!['parent','properties','children'].includes(k))
      ||object(body.parent).data_source_id!==s.dataSourceId||object(body.parent).type!=='data_source_id')return fail();
    checkProperties(body.properties,true);const children=array(body.children);if(children.length!==1||textValue(object(object(children[0]).paragraph).rich_text)!==initialTestText(scope.testId))return fail();kind='new-test-page';
  }else if(request.method==='PATCH'&&scope.pageId&&path==='/pages/'+scope.pageId){
    if(Object.keys(body).length!==1)return fail();
    if(Object.hasOwn(body,'in_trash')){if(body.in_trash!==true&&!(body.in_trash===false&&options.allowTestRestore===true))return fail();}
    else if(Object.hasOwn(body,'properties'))checkProperties(body.properties);else return fail();kind='test-page';
  }else if(request.method==='PATCH'&&scope.pageId&&path==='/blocks/'+scope.pageId+'/children'){
    const children=array(body.children);if(Object.keys(body).length!==1||children.length!==1||textValue(object(object(children[0]).paragraph).rich_text)!==manualTestText(scope.testId))return fail();kind='test-body';
  }else return fail();
  await options.beforeWrite(request,kind,ids);const response=await options.delegate(request);
  if(kind==='new-test-page'&&response.status>=200&&response.status<300){const id=object(response.body).id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))return fail();await options.created(id);}
  return response;
 };
}
