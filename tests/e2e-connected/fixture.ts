import { OfficialNotionAdapter } from '../../packages/engine/src/live-notion.ts';
import { OfficialNotionClient } from '../../packages/engine/src/live-notion-client.ts';
import { LiveCompanyAdapter } from '../../packages/engine/src/live-company.ts';
import { COMPANY_MEMBER_HEADERS } from '../../packages/engine/src/live-company-types.ts';
import type { CompanyReadSession, CompanyTrainerBinding, VerifiedDomProfile } from '../../packages/engine/src/live-company-types.ts';
import { verifyWithdrawalStatusMapping } from '../../packages/engine/src/withdrawal-plan.ts';

export function connectedPreviewFixture(trainerId:string) {
  const active='\uc9c4\ud589',requested='\ud0c8\ud1f4\uc694\uccad';
  const ids=['existing','new','pending','request-missing','already'];
  const evidence={reference:'synthetic-connected-e2e',verifiedAt:'2026-10-23'};
  const binding:CompanyTrainerBinding={trainerId,accountBindingId:'synthetic-account',evidence,accountIdentity:{selector:'[data-account]',attribute:'data-account',expectedValue:'synthetic'}};
  const profile:VerifiedDomProfile={id:'synthetic-connected-e2e',evidence,origin:'https://admin.biz-pt.com',listUrl:'https://admin.biz-pt.com/manage/members',memberPathPrefix:'/manage/members/',
    list:{evidence,headerSelector:'th',bodySelector:'tbody',rowSelector:'tbody tr',cellSelector:'td',uidLinkSelector:'a[href]',headers:COMPANY_MEMBER_HEADERS},statusMap:{},
    coverage:{evidence,activeMembership:{scope:'active-assigned',filterKey:'progress',activeValue:active},allFilterControlsSelector:'[data-filter]',
      filters:[{key:'progress',selector:'[data-filter]',read:'value',unrestrictedValue:'all'}],
      ownership:{mode:'stable-trainer-key',rowAttribute:'data-trainer',sourceTrainerKey:'synthetic-trainer',evidence},
      pagination:{evidence,cursorSelector:'[data-cursor]',initialCursorValue:'1',nextSelector:'[data-next]',nextCursorAttribute:'data-next',endSelector:'[data-end]',endValue:'end',nextUrl:()=>{throw new Error('NO_SECOND_PAGE');}}}};
  let companyReads=0,notionReads=0;
  const session:CompanyReadSession={readList:async input=>{companyReads++;return {profileId:profile.id,url:profile.listUrl,passwordInputCount:0,accountBindingId:binding.accountBindingId,snapshotId:input.snapshotId,
    headers:COMPANY_MEMBER_HEADERS,bodyCount:1,rows:ids.map(id=>({sourceTrainerKey:'synthetic-trainer',cells:['1',id,'SYNTHETIC_PRIVATE_NAME','','','000-0000-0000','','synthetic@example.invalid','SYNTHETIC_PRIVATE_TRAINER',active,'','','','',''].map((textContent,index)=>({textContent,...(index===1?{links:['/manage/members/'+id]}:{})}))})),
    filters:[{key:'progress',value:active,matchCount:1}],filterControlCount:1,pagination:{cursor:null,nextCursor:null,endValue:'end',nextCount:0,endCount:1}};}};
  const company=new LiveCompanyAdapter({session,profile,binding});
  const databaseId='11111111-1111-4111-8111-111111111111',dataSourceId='22222222-2222-4222-8222-222222222222';
  const page=(uid:string,id:string,status:string)=>({object:'page',id,parent:{type:'data_source_id',data_source_id:dataSourceId},properties:{
    Name:{id:'name',type:'title',title:[{type:'text',text:{content:'SYNTHETIC_PRIVATE_NAME'}}]},Admin:{id:'admin',type:'url',url:'https://admin.biz-pt.com/manage/members/'+uid},Status:{id:'status',type:'select',select:{name:status}}}});
  const rows=[page('existing','page-one',active),page('pending','page-two',active),page('already','page-five',requested)];
  const requests:Array<{method:string;url:string}>=[];
  const client=new OfficialNotionClient({token:'SYNTHETIC_PRIVATE_TOKEN',readPermit:{approved:true},transport:async request=>{
    notionReads++;requests.push({method:request.method,url:request.url});
    if(request.method==='GET'&&request.url==='https://api.notion.com/v1/databases/'+databaseId)return {status:200,body:{data_sources:[{id:dataSourceId}]}};
    if(request.method==='GET'&&request.url==='https://api.notion.com/v1/data_sources/'+dataSourceId)return {status:200,body:{properties:{Name:{id:'name',type:'title'},Admin:{id:'admin',type:'url'},Status:{id:'status',type:'select',select:{options:[{id:'request-option',name:requested}]}}}}};
    if(request.method==='POST'&&request.url==='https://api.notion.com/v1/data_sources/'+dataSourceId+'/query')return {status:200,body:{results:rows,has_more:false,next_cursor:null,request_status:{type:'complete'}}};
    throw new Error('UNEXPECTED_TRANSPORT_ROUTE_OR_WRITE');
  }});
  const notion=new OfficialNotionAdapter({client,members:{databaseId,dataSourceId,allowedTrainerIds:[trainerId],identity:{mode:'exclusive-data-source-admin-url',trainerId,exclusiveOwnershipApproved:true,adminUrl:{id:'admin',type:'url'},adminOrigin:'https://admin.biz-pt.com',memberPathPrefix:'/manage/members/'},name:{id:'name',type:'title'},status:{id:'status',type:'select'},statuses:{},createStatus:{}}});
  return {company,notion,requests,reads:()=>({companyReads,notionReads}),
    withdrawalStatusMapping:verifyWithdrawalStatusMapping({optionName:requested,dataSourceId,propertyId:'status',actualOptions:[{id:'request-option',name:requested}]}),
    withdrawalRequests:{listWithdrawalRequests:async()=>({requests:['pending','request-missing','already'].map(companyMemberId=>({trainerId,companyMemberId})),nextCursor:null,scope:'withdrawal_requests' as const,completeCoverage:true,snapshotId:'synthetic-withdrawal'})}};
}
