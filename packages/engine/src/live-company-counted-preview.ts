import{auditEvent}from'./audit-log.ts';
import {randomUUID} from 'node:crypto';
import {assertCompanyAccountResponseBinding,verifyCompanyAccountResponse,isCompanyAccountProof} from './company-current-account.ts';
import type {CompanyAccountResponseBinding,CompanyAccountProof,CompanyCurrentAccount} from './company-current-account.ts';
import type {Member} from '@trainer/core';
import {CompanyDomError} from './live-company-dom.ts';
import {COMPANY_MEMBER_HEADERS} from './live-company-types.ts';
import type {CompanyBrowserPage,CompanyTrainerBinding,CompanyDomEvidence} from './live-company-types.ts';
import type {CompanyAdapter} from './ports.ts';
import type {CompanyWithdrawalRequestInventory} from './withdrawal-plan.ts';

const origin='https://admin.biz-pt.com';
export interface CountedCompanyPreviewConfig {mode:'counted-ui';scopeApproved:true;evidence:CompanyDomEvidence;binding?:CompanyTrainerBinding;accountResponse?:CompanyAccountResponseBinding}
export interface CountedCompanyRow {uid:string;visibleUid:string;name:string;phone:string;email:string;activity:string;cellCount:number}
export interface CountedCompanySnapshot {
  url:string;passwordInputs:number;ready:boolean;accountMatches:number;accountMatched:boolean;headers:string[];
  rows:CountedCompanyRow[];invalidLinks:number;filterValues:string[];progressFilterMatches:number;nonemptySearch:number;total:number|null;filtered:number|null;enabledNext:number;requestHeading:boolean;
}
const fail=(code:string):never=>{throw new CompanyDomError(code);};
export function assertCountedCompanyBinding(binding:CompanyTrainerBinding|undefined,trainerId:string):asserts binding is CompanyTrainerBinding {
  if(!binding||binding.trainerId!==trainerId||!binding.accountBindingId||!binding.evidence?.reference?.trim()||!Number.isFinite(Date.parse(binding.evidence.verifiedAt))
    ||!binding.accountIdentity?.selector?.trim()||!/^[A-Za-z0-9][A-Za-z0-9_@.:-]{0,250}$/.test(binding.accountIdentity.expectedValue)
    ||/password|token|cookie|storage|authorization/i.test(binding.accountIdentity.selector+' '+(binding.accountIdentity.attribute??'')))
    fail('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
}
export function parseCountedCompanySnapshot(s:CountedCompanySnapshot,kind:'members'|'requests',proof?:CompanyAccountProof) {
  const path=kind==='members'?'/manage/members':'/manage/self-withdrawals';
  if(s.url!==origin+path||s.passwordInputs)fail('COMPANY_AUTH_REQUIRED');
  if(!isCompanyAccountProof(proof)){
    if(s.accountMatches!==1)fail('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
    if(!s.accountMatched)fail('COMPANY_ACCOUNT_MISMATCH');
  }
  if(!s.ready||s.invalidLinks||s.nonemptySearch||s.enabledNext!==0)fail('COMPANY_COVERAGE_UNVERIFIED');
  const count=kind==='members'?s.filtered:s.total;
  if(!Number.isSafeInteger(count)||count!==s.rows.length||new Set(s.rows.map(r=>r.uid)).size!==s.rows.length)fail('COMPANY_COVERAGE_UNVERIFIED');
  if(kind==='members'?(JSON.stringify(s.headers)!==JSON.stringify(COMPANY_MEMBER_HEADERS)||s.filterValues.length!==6||s.progressFilterMatches!==1||s.filterValues.filter(v=>v==='Y').length!==1||s.filterValues.some(v=>v!=='Y'&&v!=='all'))
    :(!s.requestHeading||s.headers.length!==10||s.filterValues.some(v=>v!=='all')))fail('COMPANY_FILTER_SCOPE_PARTIAL');
  for(const r of s.rows)if(r.visibleUid!==r.uid||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(r.visibleUid)||!r.name.trim()||r.cellCount!==(kind==='members'?15:10)||kind==='members'&&r.activity!=='Y')fail('COMPANY_ROW_SHAPE_MISMATCH');
  return s.rows;
}
const masked=(s:string)=>/\*|<redacted>|마스킹|비공개|가림/i.test(s);
export function mapCountedCompanyMember(r:CountedCompanyRow,trainerId:string) {
  const phone=r.phone.trim(),email=r.email.trim();
  const member:Member={trainerId,companyMemberId:r.uid,name:r.name.trim(),status:'\ud655\uc778\ud544\uc694',notionPageId:null,
    registrationDate:null,assignmentDate:null,assignmentEvidence:'unknown',membershipActivity:'active',memo:'',fixedSlot:null,firstTrainingDate:null,callAt:null,survey:[],manualContent:''};
  return {member,contact:{phone:phone&&!masked(phone)?phone:null,email:email&&!masked(email)?email:null,adminUrl:origin+'/manage/members/'+r.uid}};
}
export function countedContactVerification(rows:CountedCompanyRow[],trainerId:string) {
  const mapped=rows.map(r=>mapCountedCompanyMember(r,trainerId));
  return {rows:rows.length,namesMapped:mapped.filter((r,i)=>r.member.name===rows[i]!.name.trim()).length,
    phonePresent:mapped.filter(r=>r.contact.phone!==null).length,emailPresent:mapped.filter(r=>r.contact.email!==null).length,
    phoneMasked:rows.filter(r=>masked(r.phone)).length,emailMasked:rows.filter(r=>masked(r.email)).length,
    phoneMappingMatches:mapped.filter((r,i)=>r.contact.phone===(masked(rows[i]!.phone)?null:rows[i]!.phone.trim()||null)).length,
    emailMappingMatches:mapped.filter((r,i)=>r.contact.email===(masked(rows[i]!.email)?null:rows[i]!.email.trim()||null)).length};
}
/** Read-only, counted single-page UI lane. No cursor/end markers are invented. */
export class CountedCompanyPreviewAdapter implements CompanyAdapter,CompanyWithdrawalRequestInventory {
  private cached:{members:CountedCompanyRow[];requests:CountedCompanyRow[];snapshotId:string}|undefined;
  private binding:CompanyTrainerBinding|undefined;
  private accountResponse:CompanyAccountResponseBinding|undefined;
  contactVerification:ReturnType<typeof countedContactVerification>|undefined;
  constructor(private page:CompanyBrowserPage,config:CountedCompanyPreviewConfig,private trainerId:string,private accountReader?:(()=>Promise<CompanyCurrentAccount>)) {
    if(config.mode!=='counted-ui'||config.scopeApproved!==true||!config.evidence?.reference||!Number.isFinite(Date.parse(config.evidence.verifiedAt)))fail('COMPANY_COVERAGE_UNVERIFIED');
    if(config.accountResponse){if(config.binding||!accountReader)fail('COMPANY_ACCOUNT_BINDING_UNVERIFIED');assertCompanyAccountResponseBinding(config.accountResponse);this.accountResponse=config.accountResponse;}
    else{assertCountedCompanyBinding(config.binding,trainerId);this.binding=config.binding;}
  }
  async verifyAccount() {
    if(this.accountResponse){await verifyCompanyAccountResponse(this.accountResponse,this.accountReader!);return;}
    const identity=this.binding?.accountIdentity;if(!identity)fail('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
    const s=await this.page.evaluate(identity=>{const nodes=document.querySelectorAll(identity.selector);const n=nodes.length===1?nodes[0]:null;
      return{url:location.href,passwordInputs:document.querySelectorAll('input[type=password]').length,count:nodes.length,
        matched:n!==null&&(identity.attribute?n.getAttribute(identity.attribute):n.textContent)?.trim()===identity.expectedValue};},identity!);
    if(!s.url.startsWith(origin+'/')||s.passwordInputs)fail('COMPANY_AUTH_REQUIRED');
    if(s.count!==1)fail('COMPANY_ACCOUNT_BINDING_UNVERIFIED');if(!s.matched)fail('COMPANY_ACCOUNT_MISMATCH');
  }
  private async capture(kind:'members'|'requests'):Promise<CountedCompanySnapshot> {
    await this.verifyAccount();
    await this.page.goto(origin+(kind==='members'?'/manage/members':'/manage/self-withdrawals'),{waitUntil:'domcontentloaded'});
    for(let attempt=0;attempt<100;attempt++){
      const s=await this.page.evaluate(({kind,identity})=>{
        const tables=document.querySelectorAll('table'),headers=Array.from(tables[0]?.querySelectorAll('thead th')??[],n=>n.textContent?.trim()??'');
        const controls=Array.from(document.querySelectorAll('select'));
        const progressFilters=controls.filter(n=>Array.from(n.options).some(o=>o.value==='Y'&&o.textContent?.trim()==='진행')&&Array.from(n.options).some(o=>o.value==='N'&&o.textContent?.trim()==='탈퇴'));
        const nodes=identity?document.querySelectorAll(identity.selector):[],n=nodes.length===1?nodes[0]:null;
        const rows:CountedCompanyRow[]=[];let invalidLinks=0;
        for(const row of tables[1]?.querySelectorAll('tbody tr')??[]){
          const cells=row.querySelectorAll('td'),expected=kind==='members'?15:10;
          if(cells.length!==expected){invalidLinks++;continue;}
          const ids=Array.from(cells[1]!.querySelectorAll('a[href]')).flatMap(a=>{try{const u=new URL(a.getAttribute('href')??'',location.origin);
            return u.origin===location.origin&&!u.search&&!u.hash&&/^\/manage\/members\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(u.pathname)?[u.pathname.split('/').at(-1)!]:[];}catch{return[];}});
          if(ids.length!==1){invalidLinks++;continue;}
          rows.push({uid:ids[0]!,visibleUid:(cells[1]!.textContent??'').trim(),name:cells[2]!.textContent??'',phone:kind==='members'?cells[5]!.textContent??'':'',
            email:kind==='members'?cells[7]!.textContent??'':'',activity:kind==='members'?(cells[9]!.textContent??'').trim():'',cellCount:cells.length});
        }
        const text=document.body.textContent??'',totalMatch=text.match(/\uC804\uCCB4\s+[:：]?\s*([\d,]+)/),filteredMatch=text.match(/\uAC80\uC0C9\s+[:：]?\s*([\d,]+)/);
        const next=Array.from(document.querySelectorAll('button,a,[role=button]')).filter(n=>/^(next|다음)$/i.test((n.getAttribute('aria-label')??n.textContent??'').trim()));
        return{url:location.href,passwordInputs:document.querySelectorAll('input[type=password]').length,
          ready:tables.length===2&&(kind==='members'?controls.length===6&&controls.some(n=>n.value==='Y'):headers.length===10),
          accountMatches:nodes.length,accountMatched:n!==null&&(identity?.attribute?n.getAttribute(identity.attribute):n.textContent)?.trim()===identity?.expectedValue,
          headers,rows,invalidLinks,filterValues:controls.map(n=>n.value),progressFilterMatches:progressFilters.filter(n=>n.value==='Y').length,nonemptySearch:Array.from(document.querySelectorAll<HTMLInputElement>('input[type=text],input[type=search]')).filter(n=>n.value.trim()!=='').length,
          total:totalMatch?Number(totalMatch[1]!.replaceAll(',','')):null,filtered:filteredMatch?Number(filteredMatch[1]!.replaceAll(',','')):null,enabledNext:next.filter(n=>!n.hasAttribute('disabled')&&n.getAttribute('aria-disabled')!=='true').length,
          requestHeading:Array.from(document.querySelectorAll('h1,h2,h3')).some(n=>n.textContent?.trim()==='회원 탈퇴 요청 리스트')};
      },{kind,identity:this.binding?.accountIdentity});
      if(s.ready||s.passwordInputs){const proof=this.accountResponse?await verifyCompanyAccountResponse(this.accountResponse,this.accountReader!):undefined;parseCountedCompanySnapshot(s,kind,proof);return s;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }return fail('COMPANY_COVERAGE_UNVERIFIED');
  }
  async preflight(){await this.scan();}
  private async scan(){const auditStart=Date.now();await auditEvent({stage:'collect',outcome:'started',provider:'company',operation:'read'});
    const m=await this.capture('members'),r=await this.capture('requests'),m2=await this.capture('members'),r2=await this.capture('requests');
    if(JSON.stringify(m.rows)!==JSON.stringify(m2.rows)||JSON.stringify(r.rows)!==JSON.stringify(r2.rows))fail('COMPANY_SNAPSHOT_CHANGED');
    const restored=await this.capture('members');if(JSON.stringify(restored.rows)!==JSON.stringify(m.rows))fail('COMPANY_SNAPSHOT_CHANGED');await this.verifyAccount();
    this.contactVerification=countedContactVerification(m.rows,this.trainerId);
    await auditEvent({stage:'collect',outcome:'succeeded',provider:'company',operation:'read',durationMs:Date.now()-auditStart,counts:{members:m.rows.length,requests:r.rows.length}});
    await auditEvent({stage:'map',outcome:'succeeded',provider:'company',operation:'transform',fields:['name','phone','email'],counts:{mapped:m.rows.length}});
    for(const[field,present,masked]of [['phone',this.contactVerification.phonePresent,this.contactVerification.phoneMasked],['email',this.contactVerification.emailPresent,this.contactVerification.emailMasked]]as const)if(present<m.rows.length)await auditEvent({stage:'map',outcome:'held',provider:'company',operation:'transform',fields:[field],reasonCode:masked?'MASKED_SOURCE_VALUE':'MISSING_SOURCE_VALUE',counts:{mapped:present,held:m.rows.length-present}});
    await auditEvent({stage:'map',outcome:'held',provider:'company',operation:'transform',fields:['memo','fixedSlot','firstTrainingDate','survey'],reasonCode:'UNSUPPORTED_MAPPING'});
    return{members:m.rows,requests:r.rows,snapshotId:randomUUID()};
  }
  async listMembers(input:{trainerId:string;cursor:string|null;scope:'all_assigned'}){
    if(input.trainerId!==this.trainerId||input.cursor!==null||input.scope!=='all_assigned')fail('COMPANY_COVERAGE_UNVERIFIED');
    this.cached=await this.scan();
    return{members:this.cached.members.map(r=>mapCountedCompanyMember(r,this.trainerId).member),nextCursor:null,scope:'all_assigned' as const,completeCoverage:true,snapshotId:this.cached.snapshotId};
  }
  /** Contact values stay in worker memory; public preview receipts only contain verification counts. */
  async listAssignedContactSnapshot(){const scan=await this.scan();return scan.members.map(row=>{const mapped=mapCountedCompanyMember(row,this.trainerId);return{uid:row.uid,name:row.name.trim(),phone:mapped.contact.phone,email:mapped.contact.email};});}
  async listWithdrawalRequests(input:{trainerId:string;cursor:string|null;scope:'withdrawal_requests'}){
    if(input.trainerId!==this.trainerId||input.cursor!==null||input.scope!=='withdrawal_requests')fail('COMPANY_COVERAGE_UNVERIFIED');
    await this.verifyAccount();const scan=this.cached??await this.scan();this.cached=undefined;
    return{requests:scan.requests.map(r=>({trainerId:this.trainerId,companyMemberId:r.uid})),nextCursor:null,scope:'withdrawal_requests' as const,completeCoverage:true,snapshotId:scan.snapshotId};
  }
}
