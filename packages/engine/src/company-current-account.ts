import{setVerifiedAuditAccount}from'./audit-log.ts';
import {CompanyDomError} from './live-company-dom.ts';
import type {CompanyDomEvidence} from './live-company-types.ts';
export const COMPANY_CURRENT_ACCOUNT_URL='https://admin.biz-pt.com/api/auth/session';
export interface CompanyCurrentAccount {uid:string;trainerId:string}
export interface CompanyAccountResponseBinding {endpoint:typeof COMPANY_CURRENT_ACCOUNT_URL;expected:CompanyCurrentAccount;evidence:CompanyDomEvidence}
export interface CompanyAccountProof {readonly kind:'current-company-account'}
const proofs=new WeakSet<object>();
const validId=(value:unknown):boolean=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export function parseCompanyCurrentAccountResponse(status:number,value:unknown):CompanyCurrentAccount {
  if(status===401||status===403)throw new CompanyDomError('COMPANY_AUTH_REQUIRED');
  const user=status===200&&value&&typeof value==='object'?(value as {user?:unknown}).user:undefined;
  if(!user||typeof user!=='object')throw new CompanyDomError('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
  // Only current-user business identifiers are selected. Token, cookie and other auth fields are ignored.
  const raw=user as {uid?:unknown;trainerId?:unknown};
  const uid=['string','number'].includes(typeof raw.uid)?String(raw.uid):'',trainerId=['string','number'].includes(typeof raw.trainerId)?String(raw.trainerId):'';
  if(!validId(uid)||!validId(trainerId))throw new CompanyDomError('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
  return{uid,trainerId};
}
export function assertCompanyAccountResponseBinding(b:CompanyAccountResponseBinding):void {
  if(b.endpoint!==COMPANY_CURRENT_ACCOUNT_URL||!validId(b.expected?.uid)||!validId(b.expected?.trainerId)||!b.evidence?.reference?.trim()||!Number.isFinite(Date.parse(b.evidence.verifiedAt)))
    throw new CompanyDomError('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
}
export async function verifyCompanyAccountResponse(b:CompanyAccountResponseBinding,read:()=>Promise<CompanyCurrentAccount>):Promise<CompanyAccountProof> {
  assertCompanyAccountResponseBinding(b);const current=await read();
  if(!validId(current.uid)||!validId(current.trainerId))throw new CompanyDomError('COMPANY_ACCOUNT_BINDING_UNVERIFIED');
  if(current.uid!==b.expected.uid||current.trainerId!==b.expected.trainerId)throw new CompanyDomError('COMPANY_ACCOUNT_MISMATCH');
  setVerifiedAuditAccount(current.uid,current.trainerId);
  const proof=Object.freeze({kind:'current-company-account' as const});proofs.add(proof);return proof;
}
export const isCompanyAccountProof=(proof:unknown):proof is CompanyAccountProof=>!!proof&&typeof proof==='object'&&proofs.has(proof);

export async function readCompanyCurrentAccountInPage(page:import('./live-company-types.ts').CompanyBrowserPage):Promise<CompanyCurrentAccount> {
  const selected=await page.evaluate(async()=>{
    if(location.origin!=='https://admin.biz-pt.com')return{status:401,user:null};
    const r=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(12000)});
    const body=r.status===200?await r.json():null;
    // Do not return tokens, cookies, names, email or the whole authentication response.
    return{status:r.status,user:{uid:body?.user?.uid,trainerId:body?.user?.trainerId}};
  },undefined);
  return parseCompanyCurrentAccountResponse(selected.status,selected);
}
