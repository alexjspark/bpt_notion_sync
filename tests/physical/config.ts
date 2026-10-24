import{requireUuid}from'../../packages/engine/src/team-errors.ts';
export const PHYSICAL_DB='trainer_sync_team_physical_test';
export const PHYSICAL_ORIGIN='http://localhost:4316';
export const PHYSICAL_DB_PASSWORD='SYNTHETIC_PHYSICAL_DB_ONLY';
export const PHYSICAL_PASSWORD='SYNTHETIC_PHYSICAL_LOGIN_ONLY';
export const PHYSICAL_KEY=Buffer.alloc(32,17),PHYSICAL_HMAC=Buffer.alloc(32,18);
export const PHYSICAL_PEERS={gateway:'trainer-sync-team-gateway',worker:'trainer-sync-team-worker',egress:'trainer-sync-team-egress'}as const;
export const physicalNames=(runId:string)=>{const suffix=requireUuid(runId).replaceAll('-','');return{project:'ts-team-physical-'+suffix,network:'ts-team-test-control-'+suffix,web:'trainer-sync-team-test-web',db:'trainer-sync-team-test-db',ingress:'trainer-sync-team-test-ingress',...PHYSICAL_PEERS};};
export interface PhysicalConfig{runId:string;role:'web'|'worker'|'gateway'|'egress'|'ingress'|'runner'|'seed';databaseUrl:string;origin:typeof PHYSICAL_ORIGIN}
export function physicalConfig(input:Record<string,string|undefined>):PhysicalConfig{
 if(input.TEAM_PHYSICAL_TEST_ONLY!=='true'||input.TEAM_PHYSICAL_TEST_APPROVED!=='true')throw Error('PHYSICAL_TEST_NOT_APPROVED');
 const runId=requireUuid(input.TEAM_TEST_RUN_ID),role=input.TEAM_TEST_ROLE;
 if(!['web','worker','gateway','egress','ingress','runner','seed'].includes(role??''))throw Error('PHYSICAL_ROLE_INVALID');
 const databaseUrl=input.DATABASE_URL;if(!databaseUrl)throw Error('PHYSICAL_DATABASE_REQUIRED');
 const url=new URL(databaseUrl),host=role==='runner'?'127.0.0.1':'trainer-sync-team-test-db',port=role==='runner'?'15436':'5432';
 if(url.protocol!=='postgresql:'||url.hostname!==host||url.port!==port||url.pathname!=='/'+PHYSICAL_DB||url.username!=='trainer_test'||decodeURIComponent(url.password)!==PHYSICAL_DB_PASSWORD||url.search||url.hash)throw Error('PHYSICAL_DATABASE_SCOPE_INVALID');
 if(input.TEAM_PUBLIC_ORIGIN!==PHYSICAL_ORIGIN)throw Error('PHYSICAL_ORIGIN_INVALID');
 for(const key of['TEAM_VAULT_MASTER_KEY','TEAM_PREVIEW_HMAC_KEY','NOTION_TOKEN','NOTION_TOKEN_FILE','COMPANY_CDP_ENDPOINT'])if(input[key])throw Error('PHYSICAL_REAL_CREDENTIAL_CONFIG_REJECTED');
 return Object.freeze({runId,role:role as PhysicalConfig['role'],databaseUrl,origin:PHYSICAL_ORIGIN});
}
export function fixtureFor(runId:string,which:'A'|'B'){
 const suffix=requireUuid(runId).replaceAll('-','').slice(0,12),prefix=which==='A'?'a':'b';
 return{which,login:'physical-'+which.toLowerCase()+'-'+suffix,password:PHYSICAL_PASSWORD,token:'SYNTHETIC_NOTION_'+which,destination:{databaseId:prefix+'1111111-1111-4111-8111-111111111111',dataSourceId:prefix+'2222222-2222-4222-8222-222222222222',templateId:prefix+'3333333-3333-4333-8333-333333333333'},binding:{accountId:'SYNTHETIC_ACCOUNT_'+which,trainerId:'SYNTHETIC_TRAINER_'+which}};
}
export function physicalLabels(runId:string,managed:string){return{'trainer-sync.test-run':requireUuid(runId),'trainer-sync.test-purpose':'physical-isolation','trainer-sync.managed':managed};}
export function physicalBrowserArgs(){return['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--password-store=basic','--proxy-server=http://ts-team-egress:3128','--disable-quic','--dns-prefetch-disable','--window-size=1600,1000','--window-position=0,0','about:blank'];}

export function samePhysicalDestination(a:unknown,b:unknown){if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;return ['databaseId','dataSourceId','templateId'].every(k=>(a as Record<string,unknown>)[k]===(b as Record<string,unknown>)[k]);}

export function fixtureConnectionAllowed(runId:string,which:'A'|'B',token:string,destination:unknown){const f=fixtureFor(runId,which);return token===f.token&&samePhysicalDestination(destination,f.destination);}
