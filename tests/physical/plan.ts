import{newJournal,reserveResource}from'./registry.ts';
import{requireUuid}from'../../packages/engine/src/team-errors.ts';
import{physicalNames,physicalLabels,PHYSICAL_DB,PHYSICAL_DB_PASSWORD,PHYSICAL_ORIGIN}from'./config.ts';
export interface PhysicalImages{runtime:string;browser:string;postgres:string}
export function imageId(value:string){if(!/^sha256:[a-f0-9]{64}$/.test(value))throw Error('PHYSICAL_PINNED_IMAGE_REQUIRED');return value;}
export function composePhysical(runId:string,images:PhysicalImages){
 runId=requireUuid(runId);for(const image of Object.values(images))imageId(image);
 const n=physicalNames(runId),url='postgresql://trainer_test:'+PHYSICAL_DB_PASSWORD+'@'+n.db+':5432/'+PHYSICAL_DB;
 const environment=(role:string)=>({TEAM_PHYSICAL_TEST_ONLY:'true',TEAM_PHYSICAL_TEST_APPROVED:'true',TEAM_TEST_RUN_ID:runId,TEAM_TEST_ROLE:role,DATABASE_URL:url,TEAM_PUBLIC_ORIGIN:PHYSICAL_ORIGIN,PHASE2_ENABLED:'true',TEAM_RUNTIME_APPROVED:'true',NEXT_TELEMETRY_DISABLED:'1'});
 const service=(role:'web'|'worker'|'gateway'|'egress'|'ingress')=>({image:images.runtime,pull_policy:'never',container_name:n[role],user:'pwuser',command:['node','--import','tsx','tests/physical/main.ts',role],environment:environment(role),labels:physicalLabels(runId,['gateway','worker','egress'].includes(role)?'phase2-'+role+'-v1':'physical-'+role+'-v1'),networks:{control:{}},restart:'no',init:true,depends_on:{web:{condition:'service_healthy'}},logging:{driver:'json-file',options:{'max-size':'5m','max-file':'2'}}});
 const db={image:images.postgres,pull_policy:'never',container_name:n.db,environment:{POSTGRES_USER:'trainer_test',POSTGRES_PASSWORD:PHYSICAL_DB_PASSWORD,POSTGRES_DB:PHYSICAL_DB},labels:physicalLabels(runId,'physical-db-v1'),tmpfs:['/var/lib/postgresql/data'],healthcheck:{test:['CMD','pg_isready','-U','trainer_test','-d',PHYSICAL_DB],interval:'2s',timeout:'3s',retries:30},networks:{control:{}},ports:['127.0.0.1:15436:5432'],restart:'no'};
 return{name:n.project,services:{db,web:{...service('web'),depends_on:{db:{condition:'service_healthy'}},healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:3000/_physical/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'2s',timeout:'3s',retries:30}},worker:service('worker'),gateway:service('gateway'),egress:service('egress'),ingress:{...service('ingress'),ports:['127.0.0.1:4316:4316']}},networks:{control:{name:n.network,internal:true,labels:physicalLabels(runId,'physical-control-v1')}}};
}
export interface OfflineImagePlan{runtimeBase:string;browserBase:string}
export function offlineBuildPlan(input:OfflineImagePlan){
 for(const value of Object.values(input))if(!/^[a-z0-9][a-z0-9./_-]*:[a-z0-9][a-z0-9._-]*$/i.test(value))throw Error('PHYSICAL_LOCAL_IMAGE_TAG_REQUIRED');
 return{requiresLocalImageInspection:true,requiresRecordedBaseImageIds:true,allowPull:false,allowDownload:false,arguments:['build','--pull=false','--network=none'],runtimeDockerfile:'tests/physical/Dockerfile.runtime',browserDockerfile:'tests/physical/Dockerfile.browser',args:{RUNTIME_BASE:input.runtimeBase,BROWSER_BASE:input.browserBase}};
}

export function plannedPhysicalJournal(runId:string){const j=newJournal(runId),n=physicalNames(runId);for(const role of['web','db','ingress','gateway','worker','egress']as const)reserveResource(j,{kind:'container',name:n[role],managed:['gateway','worker','egress'].includes(role)?'phase2-'+role+'-v1':'physical-'+role+'-v1'});reserveResource(j,{kind:'network',name:n.network,managed:'physical-control-v1'});return j;}

export function physicalRunnerEnvironment(runId:string,images:PhysicalImages){for(const image of Object.values(images))imageId(image);return{TEAM_PHYSICAL_TEST_ONLY:'true',TEAM_PHYSICAL_TEST_APPROVED:'true',TEAM_TEST_RUN_ID:requireUuid(runId),TEAM_TEST_ROLE:'runner',DATABASE_URL:'postgresql://trainer_test:'+PHYSICAL_DB_PASSWORD+'@127.0.0.1:15436/'+PHYSICAL_DB,TEAM_PUBLIC_ORIGIN:PHYSICAL_ORIGIN,PHASE2_ENABLED:'true',TEAM_RUNTIME_APPROVED:'true',TEAM_DOCKER_RUNNER_APPROVED:'true',PHYSICAL_BROWSER_IMAGE_ID:images.browser,PHYSICAL_GATEWAY_IMAGE_ID:images.runtime,PHYSICAL_WORKER_IMAGE_ID:images.runtime,PHYSICAL_EGRESS_IMAGE_ID:images.runtime};}
