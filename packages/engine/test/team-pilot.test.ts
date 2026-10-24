import{test}from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{loadTeamKey,teamKeyPair,decodeTeamKey}from'../src/team-key-loader.ts';import{inviteRecipient}from'../src/team-invites.ts';
import{TeamPilotRuntime,pilotSchema,type PilotPlan}from'../src/team-pilot-provider.ts';import{TeamVault}from'../src/team-vault.ts';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('pilot keys require separate protected files; ambiguous sources and malformed keys fail closed',()=>{
 assert.equal(loadTeamKey('TEAM_VAULT_MASTER_KEY',{}),undefined);assert.throws(()=>decodeTeamKey('bad'),{code:'SECRET_INVALID'});
 assert.throws(()=>loadTeamKey('TEAM_VAULT_MASTER_KEY',{TEAM_VAULT_MASTER_KEY:'a'.repeat(64),TEAM_VAULT_MASTER_KEY_FILE:'/tmp/other'}),{code:'SECRET_INVALID'});
 assert.throws(()=>teamKeyPair({TEAM_PILOT_ENABLED:'true',TEAM_VAULT_MASTER_KEY:'a'.repeat(64),TEAM_PREVIEW_HMAC_KEY:'b'.repeat(64)}),{code:'VAULT_UNCONFIGURED'});
 assert.throws(()=>teamKeyPair({TEAM_VAULT_MASTER_KEY:'a'.repeat(64),TEAM_PREVIEW_HMAC_KEY:'a'.repeat(64)}),{code:'SECRET_INVALID'});
 assert.throws(()=>loadTeamKey('TEAM_VAULT_MASTER_KEY',{TEAM_VAULT_MASTER_KEY_FILE:'relative'}),{code:'VAULT_UNCONFIGURED'});
});
test('invitation recipient is normalized and never stored as an email value',()=>{const h=inviteRecipient('Pilot@Example.invalid');assert.equal(h,inviteRecipient('pilot@example.invalid'));assert.equal(h.length,64);assert.ok(!h.includes('@'));assert.throws(()=>inviteRecipient('invalid'),{code:'INVALID_INPUT'});});
test('pilot plan encryption cannot cross tenant, run or purpose',()=>{const vault=new TeamVault(Buffer.alloc(32,7)),scope={tenantId:A,connectionId:B,revision:2,purpose:'pilot' as const},value=JSON.stringify({name:'SYNTHETIC_ONLY',email:'fiction@example.invalid'}),sealed=vault.seal(scope,value);assert.equal(vault.open(scope,sealed),value);assert.ok(!JSON.stringify(sealed).includes('fiction'));assert.throws(()=>vault.open({...scope,purpose:'notion'},sealed),{code:'SECRET_INVALID'});assert.throws(()=>vault.open({...scope,connectionId:A},sealed),{code:'SECRET_INVALID'});});
function schema(){const p=(id:string,type:string)=>({id,type});return{'\uc5b4\ub4dc\ubbfc':p('a','url'),'\uc804\ud654\ubc88\ud638':p('p','phone_number'),'\uc774\uba54\uc77c':p('e','email'),'\uc0dd\ub144\uc6d4\uc77c':p('b','date'),'\uc131\ubcc4':{...p('g','select'),select:{options:[{id:'m',name:'\ub0a8'},{id:'f',name:'\uc5ec'}]}},UID:p('u','rich_text')};}
test('pilot connection schema requires explicit field types and gender options; no guessing',()=>{assert.equal(pilotSchema(schema()).fields.uid.type,'rich_text');const bad=schema();bad.UID.type='number';assert.equal(pilotSchema(bad).fields.uid.type,'number');bad.UID.type='formula';assert.throws(()=>pilotSchema(bad),{code:'DESTINATION_INVALID'});});
function fixture(){
 const props={email:{id:'e',type:'email',email:null},status:{id:'s',type:'select',select:{id:'manual'}}},page={id:A,parent:{data_source_id:B},last_edited_time:'2026-01-01T00:00:00Z',properties:props,archived:false,in_trash:false};
 const plan:PilotPlan={uid:'00042',name:'SYNTHETIC MEMBER',pageId:A,databaseId:A,dataSourceId:B,lastEdited:page.last_edited_time,baseline:hash(props),changes:[{field:'email',id:'e',value:{email:'fiction@example.invalid'}}],held:[]};
 const scope={tenantId:A,connectionId:B,revision:1,sessionId:B,handle:'fake',binding:{accountId:'test-account',trainerId:'test-trainer'},destination:{databaseId:A,dataSourceId:B,templateId:A},token:'SYNTHETIC_TOKEN',assertCurrent:async()=>{}};
 return{page,plan,scope};
}
for(const mode of['normal','changed-before','uncertain','trash','protected-change','date-conflict']as const)test('one-member mutation: '+mode,async()=>{
 const {page,plan,scope}=fixture();let requests=0,consumed=0,reads=0;const events:string[]=[];
 if(mode==='date-conflict'){page.properties.email={id:'e',type:'date',email:null}as any;plan.changes=[{field:'birthDate',id:'e',value:{date:{start:'2000-01-01'}}}];plan.baseline=hash(page.properties);}
 const runtime=new TeamPilotRuntime({open:async()=>({page:{evaluate:async()=>({status:200,user:{uid:'test-account',trainerId:'test-trainer'}})},release:async()=>{}})}as never,async req=>{
  if(req.method==='PATCH'){events.push('patch');requests++;assert.equal(consumed,1);assert.deepEqual(req.body,{properties:Object.fromEntries(plan.changes.map(c=>[c.id,c.value]))});
   page.properties.email=mode==='date-conflict'?{id:'e',type:'date',date:{start:'2000-01-01',end:'2000-01-02',time_zone:null}}as any:{id:'e',type:'email',email:'fiction@example.invalid'};
   if(mode==='trash')page.in_trash=true;if(mode==='protected-change')page.properties.status.select.id='concurrent-manual';if(mode==='uncertain')throw Error('PRIVATE_VALUE_MUST_NOT_ESCAPE');return{status:200,body:structuredClone(page)};
  }
  reads++;if(mode==='changed-before')page.last_edited_time='2026-01-02T00:00:00Z';return{status:200,body:structuredClone(page)};
 });
 runtime.prepare=async()=>structuredClone(plan);
 if(mode==='changed-before'){await assert.rejects(runtime.execute(scope,plan,async()=>{consumed++;}),{code:'PILOT_CHANGED'});assert.equal(requests,0);assert.equal(consumed,0);return;}
 const result=await runtime.execute(scope,plan,async()=>{events.push('consume');consumed++;});assert.equal(requests,1);assert.equal(reads,2);assert.deepEqual(events,['consume','patch']);assert.equal(result.verified,mode==='normal'||mode==='uncertain');assert.equal(result.uncertain,mode==='uncertain');
});
