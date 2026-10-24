import test from 'node:test';import assert from 'node:assert/strict';
import {COMPANY_MEMBER_HEADERS} from '../src/live-company-types.ts';
import {parseCountedCompanySnapshot,assertCountedCompanyBinding,countedContactVerification} from '../src/live-company-counted-preview.ts';
import type {CountedCompanySnapshot} from '../src/live-company-counted-preview.ts';
const row={uid:'synthetic-member',visibleUid:'synthetic-member',name:'SYNTHETIC_NAME',phone:'SYNTHETIC_PHONE',email:'synthetic@example.invalid',activity:'Y',cellCount:15};
function snapshot():CountedCompanySnapshot{return{url:'https://admin.biz-pt.com/manage/members',passwordInputs:0,ready:true,accountMatches:1,accountMatched:true,headers:[...COMPANY_MEMBER_HEADERS],rows:[row],invalidLinks:0,filterValues:['all','Y','all','all','all','all'],progressFilterMatches:1,nonemptySearch:0,total:2,filtered:1,enabledNext:0,requestHeading:false};}
test('counted preview requires stable matching account and complete actual count evidence',()=>{
  assert.equal(parseCountedCompanySnapshot(snapshot(),'members').length,1);
  for(const changed of [{accountMatches:0},{accountMatched:false},{progressFilterMatches:0},{filtered:2},{filtered:null},{enabledNext:1},{nonemptySearch:1},{rows:[{...row,activity:'N'}]}]){
    assert.throws(()=>parseCountedCompanySnapshot({...snapshot(),...changed},'members'),/COMPANY_/);
  }
  assert.throws(()=>assertCountedCompanyBinding(undefined,'synthetic-trainer'),/COMPANY_ACCOUNT_BINDING_UNVERIFIED/);
  const request={...snapshot(),url:'https://admin.biz-pt.com/manage/self-withdrawals',headers:Array(10).fill('synthetic-header'),filterValues:[],rows:[{...row,cellCount:10}],total:1,requestHeading:true};
  assert.equal(parseCountedCompanySnapshot(request,'requests').length,1);
  assert.throws(()=>parseCountedCompanySnapshot({...request,total:null},'requests'),/COMPANY_COVERAGE_UNVERIFIED/);
});
test('contact mapping returns only aggregate evidence and leaves masked values unavailable',()=>{
  const result=countedContactVerification([row,{...row,uid:'masked-member',phone:'***',email:'<redacted>'}],'synthetic-trainer');
  assert.deepEqual(result,{rows:2,namesMapped:2,phonePresent:1,emailPresent:1,phoneMasked:1,emailMasked:1,phoneMappingMatches:2,emailMappingMatches:2});
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC|@|synthetic-member|masked-member/);
});

test('visible UID is mandatory and must match the route string without dropping leading zeroes',()=>{
 const base=snapshot();base.rows=[{...row,uid:'001234',visibleUid:'001234'}];assert.equal(parseCountedCompanySnapshot(base,'members')[0]!.uid,'001234');
 for(const visibleUid of ['1234','','other'])assert.throws(()=>parseCountedCompanySnapshot({...base,rows:[{...base.rows[0]!,visibleUid}]},'members'));
 assert.throws(()=>parseCountedCompanySnapshot({...base,filtered:2,rows:[base.rows[0]!,base.rows[0]!] },'members'));
});
