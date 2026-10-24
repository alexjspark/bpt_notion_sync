import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeamVault } from '../src/team-vault.ts';
import { TeamError } from '../src/team-errors.ts';
import { hashTeamPassword,verifyTeamPassword,assertActor } from '../src/team-auth.ts';
import { TeamRuntimeCache,OfficialTeamNotionValidator } from '../src/team-providers.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const scope={tenantId:A,connectionId:C,revision:1,purpose:'notion' as const};
test('vault requires operator-supplied master; no plaintext fallback',()=>{
 const v=new TeamVault();assert.equal(v.ready,false);assert.throws(()=>v.seal(scope,'SYNTHETIC_TOKEN'),{code:'VAULT_UNCONFIGURED'});
 assert.throws(()=>new TeamVault(Buffer.alloc(31)),{code:'SECRET_INVALID'});
});
test('vault ciphertext is random, authenticated, and bound to tenant/connection/revision/purpose',()=>{
 const v=new TeamVault(Buffer.alloc(32,7)),secret='SYNTHETIC_PRIVATE_TOKEN',e=v.seal(scope,secret);
 assert.equal(v.open(scope,e),secret);assert.ok(!JSON.stringify(e).includes(secret));assert.notEqual(e.ciphertext,v.seal(scope,secret).ciphertext);
 for(const changed of [{...scope,tenantId:B},{...scope,connectionId:B},{...scope,revision:2},{...scope,purpose:'other'}])assert.throws(()=>v.open(changed as never,e),{code:'SECRET_INVALID'});
 assert.throws(()=>v.open(scope,{...e,tag:Buffer.alloc(16).toString('base64')}),{code:'SECRET_INVALID'});
 assert.throws(()=>new TeamVault(Buffer.alloc(32,8)).open(scope,e),{code:'SECRET_INVALID'});
});
test('password hash verifies exact input and rejects malformed or attacker-selected cost',async()=>{
 const p='SYNTHETIC password! ',h=await hashTeamPassword(p);
 assert.equal(await verifyTeamPassword(p,h),true);assert.equal(await verifyTeamPassword(p.trim(),h),false);
 assert.equal(await verifyTeamPassword(p,'scrypt-v999$huge$cost'),false);assert.ok(!h.includes(p));
 await assert.rejects(hashTeamPassword('short'),{code:'INVALID_INPUT'});
});
test('client-forged actor objects are rejected',()=>assert.throws(()=>assertActor({userId:A,tenantId:B,authVersion:1}),{code:'AUTH_REQUIRED'}));
test('runtime cache isolates identical logical inputs by tenant and connection revision',()=>{
 const c=new TeamRuntimeCache<object>(),a={tenantId:A,connectionId:C,revision:1},b={...a,tenantId:B};
 const av=c.get(a,()=>({})),bv=c.get(b,()=>({}));assert.notEqual(av,bv);assert.equal(c.get(a,()=>({})),av);
 assert.notEqual(c.get({...a,revision:2},()=>({})),av);c.invalidate(B);assert.notEqual(c.get(b,()=>({})),bv);
});
test('official Notion validator only reads exact DB, data source and listed template; mismatches held',async()=>{
 const paths:string[]=[];const d={databaseId:A,dataSourceId:B,templateId:C};
 const v=new OfficialTeamNotionValidator(async r=>{paths.push(r.url);assert.equal(r.method,'GET');return{status:200,body:r.url.includes('/templates')?{templates:[{id:C}],has_more:false}:r.url.includes('/databases/')?{data_sources:[{id:B}]}:{parent:{database_id:A},properties:{title:{type:'title'}}}};});
 await v.validate('SYNTHETIC_TOKEN',d);assert.equal(paths.length,3);
 const bad=new OfficialTeamNotionValidator(async()=>({status:200,body:{data_sources:[{id:C}]}}));await assert.rejects(bad.validate('SYNTHETIC_TOKEN',d),{code:'DESTINATION_INVALID'});
});
