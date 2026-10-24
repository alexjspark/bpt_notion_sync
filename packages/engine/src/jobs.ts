import{auditEvent,safeAuditError}from'./audit-log.ts';
import { randomUUID } from 'node:crypto';
import { query, transaction } from '@trainer/db';
import { ExternalAdapterDisabledError, RetryableError } from './ports.ts';

export interface ClaimedJob {id:string;trainer_id:string;kind:'company_sync'|'notion_poll';attempts:number;}
const LEASE_SECONDS=120;
export async function claimJob():Promise<ClaimedJob|null> {
  return transaction(async client=>{
    await client.query(`UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,
      available_at=now(),lease_until=NULL,error='WORKER_INTERRUPTED: recovered expired lease'
      WHERE status='running' AND lease_until<now()`);
    await client.query(`DELETE FROM tenant_locks WHERE lease_until<now()`);
    const result = await client.query(`SELECT j.id,j.trainer_id,j.kind,j.attempts FROM jobs j
      WHERE j.status IN ('queued','retry') AND j.available_at<=now()
      AND NOT EXISTS(SELECT 1 FROM tenant_locks l WHERE l.trainer_id=j.trainer_id AND l.lease_until>=now())
      ORDER BY j.available_at,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
    const row=result.rows[0] as ClaimedJob|undefined;
    if(!row)return null;
    const lock=await client.query(`INSERT INTO tenant_locks(trainer_id,job_id,lease_until) VALUES($1,$2,now()+$3::int*interval '1 second')
      ON CONFLICT(trainer_id) DO UPDATE SET job_id=excluded.job_id,lease_until=excluded.lease_until
      WHERE tenant_locks.lease_until<now() RETURNING job_id`,[row.trainer_id,row.id,LEASE_SECONDS]);
    if(!lock.rowCount)return null;
    await client.query(`UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+$2::int*interval '1 second',error=NULL WHERE id=$1`,[row.id,LEASE_SECONDS]);
    return {...row,attempts:row.attempts+1};
  });
}
export async function renewLease(job:ClaimedJob):Promise<void> {
  await transaction(async client=>{
    const current=await client.query(`SELECT id FROM jobs WHERE id=$1 AND attempts=$2 AND status='running' FOR UPDATE`,[job.id,job.attempts]);
    if(!current.rowCount)throw new Error('JOB_LEASE_LOST');
    const locked=await client.query(`UPDATE tenant_locks SET lease_until=now()+$3::int*interval '1 second'
      WHERE trainer_id=$1 AND job_id=$2 AND lease_until>=now()
      AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND attempts=$4 AND status='running')
      RETURNING job_id`,[job.trainer_id,job.id,LEASE_SECONDS,job.attempts]);
    if(!locked.rowCount)throw new Error('JOB_LEASE_LOST');
    await client.query(`UPDATE jobs SET lease_until=now()+$2::int*interval '1 second' WHERE id=$1 AND status='running'`,[job.id,LEASE_SECONDS]);
  });
}
export async function assertJobLease(job:ClaimedJob):Promise<void> {
  const owned=await query(`SELECT 1 FROM tenant_locks l JOIN jobs j ON j.id=l.job_id
    WHERE l.trainer_id=$1 AND l.job_id=$2 AND l.lease_until>=now() AND j.status='running' AND j.attempts=$3`,[job.trainer_id,job.id,job.attempts]);
  if(!owned.rowCount)throw new Error('JOB_LEASE_LOST');
}
/** Session-backed transaction lock survives timer pauses, and releases if the worker connection dies. */
export async function withExecutionLock<T>(job:ClaimedJob,fn:()=>Promise<T>):Promise<T> {
  return transaction(async client=>{
    const result=await client.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtext('trainer-sync-execution'),hashtext($1)) AS locked`,[job.trainer_id]);
    if(!result.rows[0]?.locked)throw new RetryableError('Previous tenant execution is still finishing',1000);
    await assertJobLease(job);
    return fn();
  });
}
export function retryDelayMs(attempt:number,error:unknown):number {
  return Math.max(Math.min(300000,1000*2**Math.max(0,attempt-1)),error instanceof RetryableError?Math.max(0,error.retryAfterMs):0);
}
export async function finishJob(job:ClaimedJob,error?:unknown):Promise<void> {
  await transaction(async client=>{
    // All job mutations lock job first, then tenant lease, to avoid inverse lock ordering.
    const current=await client.query(`SELECT id FROM jobs WHERE id=$1 AND attempts=$2 AND status='running' FOR UPDATE`,[job.id,job.attempts]);
    if(!current.rowCount)throw new Error('JOB_LEASE_LOST');
    const owned=await client.query(`SELECT job_id FROM tenant_locks
      WHERE trainer_id=$1 AND job_id=$2 FOR UPDATE`,[job.trainer_id,job.id]);
    if(!owned.rowCount)throw new Error('JOB_LEASE_LOST');
    if(error===undefined) {
      await client.query(`UPDATE jobs SET status='succeeded',finished_at=now(),lease_until=NULL,error=NULL WHERE id=$1 AND status='running'`,[job.id]);
    }else {
      const terminal=job.attempts>=5||error instanceof ExternalAdapterDisabledError;
      // Safe local error summary only; adapters must never include credentials or raw HTTP payloads.
      const safe=safeAuditError(error);const message=safe.code+': '+safe.summary;
      await client.query(`UPDATE jobs SET status=$2,error=$3,available_at=now()+$4::int*interval '1 millisecond',
        lease_until=NULL,finished_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1 AND status='running'`,[job.id,terminal?'failed':'retry',message,retryDelayMs(job.attempts,error),terminal]);
    }
    await client.query(`DELETE FROM tenant_locks WHERE trainer_id=$1 AND job_id=$2`,[job.trainer_id,job.id]);
  });
  await auditEvent({runId:job.id,runKind:'mock_job',accountId:job.trainer_id,attempt:job.attempts,retryCount:Math.max(0,job.attempts-1),stage:error===undefined?'complete':job.attempts>=5||error instanceof ExternalAdapterDisabledError?'error':'retry',outcome:error===undefined?'succeeded':'failed',...(error===undefined?{}:{error})});
}
/** Test/administrative fixture helper: caller still needs a valid tenant row. */
export async function insertJobForTest(trainerId:string,kind:'company_sync'|'notion_poll'):Promise<string> {
  const id=randomUUID();
  await query(`INSERT INTO jobs(id,trainer_id,kind,source,status,attempts,available_at) VALUES($1,$2,$3,'manual','queued',0,now())`,[id,trainerId,kind]);
  return id;
}
