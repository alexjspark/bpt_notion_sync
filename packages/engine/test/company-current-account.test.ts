import test from 'node:test';import assert from 'node:assert/strict';
import {COMPANY_CURRENT_ACCOUNT_URL,parseCompanyCurrentAccountResponse,verifyCompanyAccountResponse,isCompanyAccountProof} from '../src/company-current-account.ts';
const binding:import('../src/company-current-account.ts').CompanyAccountResponseBinding={endpoint:COMPANY_CURRENT_ACCOUNT_URL,expected:{uid:'synthetic-user-1',trainerId:'synthetic-trainer-1'},evidence:{reference:'synthetic-proof',verifiedAt:'2026-10-24T00:00:00Z'}};
test('current-user account parser selects only business IDs and never consumes token fields',()=>{
  const body={user:{uid:'synthetic-user-1',trainerId:'synthetic-trainer-1'},get token(){throw new Error('TOKEN_MUST_NOT_BE_READ');}};
  assert.deepEqual(parseCompanyCurrentAccountResponse(200,body),binding.expected);
  for(const body of [null,{user:{}},{user:{uid:'x',trainerId:''}}])assert.throws(()=>parseCompanyCurrentAccountResponse(200,body),/COMPANY_ACCOUNT_BINDING_UNVERIFIED/);
  assert.throws(()=>parseCompanyCurrentAccountResponse(401,body),/COMPANY_AUTH_REQUIRED/);
});
test('fresh account proof binds both user UID and trainer ID; forged proof and account changes fail closed',async()=>{
  const proof=await verifyCompanyAccountResponse(binding,async()=>binding.expected);assert.equal(isCompanyAccountProof(proof),true);
  assert.equal(isCompanyAccountProof({kind:'current-company-account'}),false);
  for(const changed of [{...binding.expected,uid:'other-user'},{...binding.expected,trainerId:'other-trainer'}])
    await assert.rejects(verifyCompanyAccountResponse(binding,async()=>changed),/COMPANY_ACCOUNT_MISMATCH/);
  await assert.rejects(verifyCompanyAccountResponse({...binding,endpoint:'https://other.invalid' as never},async()=>binding.expected),/COMPANY_ACCOUNT_BINDING_UNVERIFIED/);
});
