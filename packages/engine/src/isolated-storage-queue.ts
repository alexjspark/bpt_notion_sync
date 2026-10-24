import{parseNotionDestination}from'./runtime-scopes.ts';import type{NotionDestinationScope}from'./runtime-scopes.ts';
import{randomUUID}from'node:crypto';import{query,transaction}from'@trainer/db';
export const ISOLATED_STORAGE_SUITE='2026-10-24-single-page';
export interface IsolatedStorageRun {id:string;trainerId:string;testId:string;status:string;phase:string;pageId:string|null;createAttempted:boolean;report:Record<string,unknown>;errorCode:string|null}
interface Row{id:string;trainer_id:string;test_id:string;status:string;phase:string;page_id:string|null;create_attempted:boolean;report:Record<string,unknown>;error_code:string|null}
const map=(r:Row):IsolatedStorageRun=>({id:r.id,trainerId:r.trainer_id,testId:r.test_id,status:r.status,phase:r.phase,pageId:r.page_id,createAttempted:r.create_attempted,report:r.report,errorCode:r.error_code});
const cols='id,trainer_id,test_id,status,phase,page_id,create_attempted,report,error_code';
export async function getIsolatedStorageRun():Promise<IsolatedStorageRun|null>{const r=(await query<Row>('SELECT '+cols+' FROM isolated_storage_tests WHERE trainer_id=$1 AND suite_key=$2',['trainer-live-one',ISOLATED_STORAGE_SUITE])).rows[0];return r?map(r):null;}
export async function queueIsolatedStorageRun(approval?:{destination:NotionDestinationScope}){return transaction(async c=>{
 await c.query("SELECT pg_advisory_xact_lock(hashtext('isolated-storage-queue'))");
 let r=(await c.query<Row>('SELECT '+cols+' FROM isolated_storage_tests WHERE trainer_id=$1 AND suite_key=$2 FOR UPDATE',['trainer-live-one',ISOLATED_STORAGE_SUITE])).rows[0];
 if(!r){if(!approval)throw Error('ISOLATED_DESTINATION_APPROVAL_REQUIRED');const destination=parseNotionDestination(approval.destination);r=(await c.query<Row>('INSERT INTO isolated_storage_tests(id,trainer_id,suite_key,test_id,status,phase,report) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING '+cols,[randomUUID(),'trainer-live-one',ISOLATED_STORAGE_SUITE,'trainersync-test-'+randomUUID(),'queued','queued',JSON.stringify({destination})])).rows[0]!;}
 // A completed test is replayable as a result, never as another creation. Failed runs keep the same identifier/page.
 else if(['failed','needs_review'].includes(r.status))r=(await c.query<Row>('UPDATE isolated_storage_tests SET status=$2,error_code=NULL,updated_at=now() WHERE id=$1 RETURNING '+cols,[r.id,'queued'])).rows[0]!;
 return map(r);
});}
export async function claimIsolatedStorageRun(){return transaction(async c=>{const r=(await c.query<Row>('SELECT '+cols+" FROM isolated_storage_tests WHERE trainer_id=$1 AND suite_key=$2 AND status='queued' FOR UPDATE SKIP LOCKED",['trainer-live-one',ISOLATED_STORAGE_SUITE])).rows[0];if(!r)return null;await c.query("UPDATE isolated_storage_tests SET status='running',updated_at=now() WHERE id=$1",[r.id]);return{...map(r),status:'running'};});}
export function publicIsolatedStorageRun(run:IsolatedStorageRun|null){return run?{id:run.id,testIdentifier:run.testId,status:run.status,phase:run.phase,pageId:run.pageId,pageUrl:run.pageId?'https://app.notion.com/p/'+run.pageId.replaceAll('-',''):null,report:run.report,errorCode:run.errorCode}:null;}
