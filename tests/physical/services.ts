import{assertActor,type TeamActor}from'../../packages/engine/src/team-auth.ts';
import{query,migrate,transaction}from'@trainer/db';import{TeamAuth,provisionTeamUser}from'../../packages/engine/src/team-auth.ts';
import{TeamVault}from'../../packages/engine/src/team-vault.ts';import{TeamConnections}from'../../packages/engine/src/team-connections.ts';import{TeamPreviewQueue}from'../../packages/engine/src/team-preview.ts';
import{QueuedCompanySessionProvider}from'../../packages/engine/src/team-browser-store.ts';import{DispatchedPreviewProvider}from'../../packages/engine/src/team-worker-dispatch.ts';
import{ScopedTeamAdapterPreview}from'../../packages/engine/src/team-adapter-preview.ts';import{syntheticMembers}from'@trainer/db';import type{TeamServices}from'../../apps/web/lib/team-api.ts';
import{fixtureConnectionAllowed,samePhysicalDestination,fixtureFor,PHYSICAL_KEY,PHYSICAL_HMAC,type PhysicalConfig}from'./config.ts';
import{TeamError}from'../../packages/engine/src/team-errors.ts';
export async function verifyPhysicalMarker(config:PhysicalConfig){
 const row=(await query('SELECT run_id FROM physical_test_run WHERE singleton=true')).rows[0];if(row?.run_id!==config.runId)throw Error('PHYSICAL_MARKER_MISMATCH');
}
export async function seedPhysical(config:PhysicalConfig){
 if(config.role!=='web'&&config.role!=='seed')throw Error('PHYSICAL_SEED_ROLE_DENIED');
 await migrate();
 await transaction(async c=>{await c.query('CREATE TABLE IF NOT EXISTS physical_test_run(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),run_id uuid NOT NULL)');const previous=(await c.query('SELECT run_id FROM physical_test_run FOR UPDATE')).rows[0];if(previous&&previous.run_id!==config.runId)throw Error('PHYSICAL_DATABASE_NOT_EMPTY');if(!previous){if((await c.query('SELECT 1 FROM team_users LIMIT 1')).rowCount)throw Error('PHYSICAL_DATABASE_NOT_EMPTY');await c.query('INSERT INTO physical_test_run(singleton,run_id) VALUES(true,$1)',[config.runId]);}});
 for(const which of['A','B']as const){const f=fixtureFor(config.runId,which);if(!(await query('SELECT 1 FROM team_users WHERE login=$1',[f.login])).rowCount)await provisionTeamUser({login:f.login,password:f.password,label:'TEST PHYSICAL '+which});}
}
export async function physicalFixture(config:PhysicalConfig,tenantId:string){
 await verifyPhysicalMarker(config);const rows=(await query('SELECT login FROM team_users WHERE tenant_id=$1',[tenantId])).rows;
 for(const which of['A','B']as const){const f=fixtureFor(config.runId,which);if(rows.length===1&&rows[0].login===f.login)return f;}throw new TeamError('FORBIDDEN',403);
}
export function mockNotionValidator(config:PhysicalConfig){return{validate:async(token:string,destination:unknown)=>{
 await verifyPhysicalMarker(config);const matches=(['A','B']as const).map(w=>fixtureFor(config.runId,w)).filter(f=>f.token===token&&samePhysicalDestination(f.destination,destination));if(matches.length!==1)throw new TeamError('DESTINATION_INVALID');
 }};}
export function physicalPreview(config:PhysicalConfig){
 return new ScopedTeamAdapterPreview(async input=>{
  const f=await physicalFixture(config,input.tenantId);if(input.token!==f.token||!samePhysicalDestination(input.destination,f.destination))throw new TeamError('DESTINATION_INVALID');
  const member={...syntheticMembers(input.tenantId)[0]!,companyMemberId:'SYNTHETIC_SHARED_UID',name:'TEST PHYSICAL '+f.which};
  return{company:{listMembers:async()=>({members:[member],nextCursor:null,scope:'all_assigned',completeCoverage:true,snapshotId:'synthetic-'+f.which})},notion:{listIdentities:async()=>({identities:[{trainerId:input.tenantId,companyMemberId:member.companyMemberId,pageId:'synthetic-page-'+f.which}],nextCursor:null,scope:'all_members',completeCoverage:true,snapshotId:'synthetic-'+f.which})},withdrawals:{listWithdrawalRequests:async()=>({requests:[],nextCursor:null,scope:'withdrawal_requests',completeCoverage:true,snapshotId:'synthetic-'+f.which})}};
 },PHYSICAL_HMAC);
}
class PhysicalConnections extends TeamConnections{
 constructor(private readonly config:PhysicalConfig){super(new TeamVault(PHYSICAL_KEY,'physical-test-only'),new QueuedCompanySessionProvider(undefined,5000,true),mockNotionValidator(config));}
 override async connectNotion(actor:TeamActor,input:{revision:number;token:string;destination:unknown}){assertActor(actor);const fixture=await physicalFixture(this.config,actor.tenantId);if(!fixtureConnectionAllowed(this.config.runId,fixture.which,input.token,input.destination))throw new TeamError('DESTINATION_INVALID');return super.connectNotion(actor,input);}
}
export function physicalWebServices(config:PhysicalConfig):TeamServices{
 const connections=new PhysicalConnections(config);
 return{auth:new TeamAuth(),connections,queue:new TeamPreviewQueue(connections,new DispatchedPreviewProvider())};
}
