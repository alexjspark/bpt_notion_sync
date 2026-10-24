import test from'node:test';import assert from'node:assert/strict';
import{companyUidValue,planCompanyUidFill,fillCompanyUidOnce}from'../src/company-uid.ts';
test('UID strings preserve leading zeroes; existing numeric schema is supported only when round-trip lossless',()=>{
 assert.deepEqual(companyUidValue('001234','rich_text'),{rich_text:[{type:'text',text:{content:'001234'}}]});
 assert.deepEqual(companyUidValue('1234','number'),{number:1234});
 for(const uid of ['001234','9007199254740993','AB12'])assert.throws(()=>companyUidValue(uid,'number'),/REPRESENTATION_UNSAFE/);
});
test('UID fill preserves identical values and holds conflicts, unsupported types and invalid values',()=>{
 assert.equal(planCompanyUidFill('001234',{type:'rich_text',rich_text:[]}).decision,'fill');
 assert.equal(planCompanyUidFill('001234',{type:'rich_text',rich_text:[{type:'text',text:{content:'001234'}}]}).decision,'noop');
 assert.equal(planCompanyUidFill('001234',{type:'number',number:null}).decision,'held');
 assert.equal(planCompanyUidFill('1234',{type:'number',number:9999}).reasonCode,'UID_CONFLICT');
 assert.equal(planCompanyUidFill('1234',{type:'number',number:1234}).decision,'noop');
 assert.equal(planCompanyUidFill('1234',{type:'number',number:null}).decision,'fill');
 assert.equal(planCompanyUidFill('1234',{type:'unique_id',unique_id:null}).reasonCode,'UID_SCHEMA_UNSUPPORTED');
});
test('scoped UID storage emits only the UID property, replay does not write, manual fields and body remain unchanged',async()=>{
 let current:Record<string,unknown>={type:'rich_text',rich_text:[]},writes=0,consumed=0;const body='USER MANUAL BODY',other={phone:'SYNTHETIC_PHONE',status:'manual'};
 const input={uid:'001234',propertyId:'uid-property',read:async()=>structuredClone(current),consume:async()=>{consumed++;},write:async(b:Record<string,unknown>)=>{writes++;assert.deepEqual(Object.keys(b),['properties']);const p=b.properties as Record<string,Record<string,unknown>>;assert.deepEqual(Object.keys(p),['uid-property']);current={type:'rich_text',...p['uid-property']};}};
 assert.equal((await fillCompanyUidOnce(input)).verified,true);assert.equal((await fillCompanyUidOnce(input)).decision,'noop');assert.equal(writes,1);assert.equal(consumed,1);
 assert.equal(body,'USER MANUAL BODY');assert.deepEqual(other,{phone:'SYNTHETIC_PHONE',status:'manual'});
 current={type:'rich_text',rich_text:[{text:{content:'MANUAL_UID'}}]};assert.equal((await fillCompanyUidOnce(input)).reasonCode,'UID_CONFLICT');assert.equal(writes,1);
});
test('uncertain UID acknowledgement reconciles once without resending and a consumed scope prevents dispatch',async()=>{
 let writes=0,reads=0,current:Record<string,unknown>={type:'number',number:null};
 const input={uid:'1234',propertyId:'uid',read:async()=>{reads++;return structuredClone(current);},consume:async()=>{},write:async()=>{writes++;current={type:'number',number:1234};throw Error('SYNTHETIC_UNCERTAIN');}};
 const result=await fillCompanyUidOnce(input);assert.equal(result.verified,true);assert.equal(result.uncertain,true);assert.equal(writes,1);assert.equal(reads,2);
 current={type:'number',number:null};await assert.rejects(fillCompanyUidOnce({...input,consume:async()=>{throw Error('SCOPE_ALREADY_CONSUMED');}}));assert.equal(writes,1);
});
