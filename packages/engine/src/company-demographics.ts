import{auditEvent,auditReason}from'./audit-log.ts';
import{DateTime}from'luxon';import{CompanyDomError}from'./live-company-dom.ts';import type{CompanyBrowserPage}from'./live-company-types.ts';
export type DemographicField='birthDate'|'gender';export type SourceGender='M'|'F';
export interface CompanyDemographics{uid:string;name:string;birthDate:string|null;gender:SourceGender|null;reasons:Partial<Record<DemographicField,string>>}
export function parseExplicitBirthDate(raw:string,today:string):{value:string|null;reason?:string}{
 const value=raw.trim();if(!value)return{value:null,reason:'source_missing'};
 if(/[*\u2022\u25cf]/u.test(value))return{value:null,reason:'source_masked'};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return{value:null,reason:'source_format_uncertain'};
 const d=DateTime.fromISO(value,{zone:'UTC'});if(!d.isValid||d.year<1||d.toISODate()!==value||value>today)return{value:null,reason:'source_invalid_date'};
 return{value};
}
export interface DemographicSnapshot{url:string;passwordInputs:number;nameCount:number;name:string;birthLabelCount:number;birthInputCount:number;birthRaw:string;genderLabelCount:number;radios:{value:string;label:string;checked:boolean}[]}
export function parseCompanyDemographics(snapshot:DemographicSnapshot,uid:string,name:string,today:string):CompanyDemographics{
 if(snapshot.url!=='https://admin.biz-pt.com/manage/members/'+uid||snapshot.passwordInputs||snapshot.nameCount!==1||snapshot.name.trim()!==name.trim())throw new CompanyDomError('COMPANY_DEMOGRAPHIC_IDENTITY_UNVERIFIED');
 const result:CompanyDemographics={uid,name,birthDate:null,gender:null,reasons:{}};
 if(snapshot.birthLabelCount!==1||snapshot.birthInputCount!==1)result.reasons.birthDate='source_field_unverified';
 else{const birth=parseExplicitBirthDate(snapshot.birthRaw,today);result.birthDate=birth.value;if(birth.reason)result.reasons.birthDate=birth.reason;}
 const expected=[{value:'F',label:'\uc5ec\uc131'},{value:'M',label:'\ub0a8\uc131'}],actual=snapshot.radios.map(r=>({value:r.value,label:r.label.trim()})).sort((a,b)=>a.value.localeCompare(b.value));
 const checked=snapshot.radios.filter(r=>r.checked);
 if(snapshot.genderLabelCount!==1||JSON.stringify(actual)!==JSON.stringify(expected))result.reasons.gender='source_options_unverified';
 else if(!checked.length)result.reasons.gender='source_missing';
 else if(checked.length!==1||!['M','F'].includes(checked[0]!.value))result.reasons.gender='source_selection_uncertain';
 else result.gender=checked[0]!.value as SourceGender;
 return result;
}
async function readCompanyDemographicsRaw(page:CompanyBrowserPage,uid:string,name:string,guard:()=>Promise<void>):Promise<CompanyDemographics>{
 if(!/^\d+$/.test(uid))throw new CompanyDomError('COMPANY_MEMBER_ID_INVALID');await guard();
 await page.goto('https://admin.biz-pt.com/manage/members/'+uid,{waitUntil:'domcontentloaded'});
 let before:DemographicSnapshot|undefined;
 for(let attempt=0;attempt<100;attempt++){
  const snapshot=await page.evaluate(()=>{
   const names=document.querySelectorAll<HTMLInputElement>('input[name=name]'),births=document.querySelectorAll<HTMLInputElement>('input[name=birth]');
   const labels=Array.from(document.querySelectorAll('label')),birth=labels.filter(l=>l.textContent?.trim()==='\uc0dd\ub144\uc6d4\uc77c'),gender=labels.filter(l=>l.textContent?.trim()==='\uc131\ubcc4');
   return{url:location.href,passwordInputs:document.querySelectorAll('input[type=password]').length,nameCount:names.length,name:names[0]?.value??'',birthLabelCount:birth.length,birthInputCount:births.length,birthRaw:births[0]?.value??'',genderLabelCount:gender.length,
    radios:Array.from(gender[0]?.parentElement?.querySelectorAll<HTMLInputElement>('input[type=radio]')??[]).map(r=>({value:r.value,label:r.parentElement?.textContent?.trim()??'',checked:r.checked}))};
  },undefined);
  if(snapshot.passwordInputs)throw new CompanyDomError('COMPANY_AUTH_REQUIRED');
  if(snapshot.nameCount===1&&snapshot.name.trim()===name.trim()&&snapshot.birthLabelCount===1&&snapshot.genderLabelCount===1){
   if(before&&JSON.stringify(before)===JSON.stringify(snapshot)){await guard();return parseCompanyDemographics(snapshot,uid,name,new Date().toISOString().slice(0,10));}before=snapshot;
  }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new CompanyDomError('COMPANY_DEMOGRAPHIC_FIELD_UNVERIFIED');
}

export async function readCompanyDemographics(page:CompanyBrowserPage,uid:string,name:string,guard:()=>Promise<void>):Promise<CompanyDemographics>{const start=Date.now();await auditEvent({stage:'collect',outcome:'started',memberId:uid,fields:['birthDate','gender'],provider:'company',operation:'read'});try{const result=await readCompanyDemographicsRaw(page,uid,name,guard);await auditEvent({stage:'collect',outcome:'succeeded',memberId:uid,durationMs:Date.now()-start,fields:['birthDate','gender'],provider:'company',operation:'read'});for(const f of ['birthDate','gender']as const)await auditEvent({stage:'map',outcome:result[f]===null?'held':'succeeded',memberId:uid,fields:[f],provider:'company',operation:'transform',...(result[f]===null?{reasonCode:auditReason(result.reasons[f]??'source_missing')}:{})});return result;}catch(error){await auditEvent({stage:'collect',outcome:'failed',memberId:uid,fields:['birthDate','gender'],provider:'company',operation:'read',error,durationMs:Date.now()-start});throw error;}}
