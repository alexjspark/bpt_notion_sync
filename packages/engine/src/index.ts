import { MockCompanyAdapter } from './company.ts';
import { MockNotionAdapter } from './notion.ts';
import { assertJobLease, claimJob, finishJob, renewLease, withExecutionLock } from './jobs.ts';
import { scheduleDueJobs } from './scheduler.ts';
import { syncCompany, pollNotion } from './sync.ts';
import { assertMockMode } from './ports.ts';
import type { SyncAdapters } from './sync.ts';
export * from './ports.ts';
export * from './company.ts';
export * from './notion.ts';
export * from './jobs.ts';
export * from './scheduler.ts';
export * from './sync.ts';
export * from './manual-sync.ts';
export * from './live-notion.ts';
export * from './live-notion-pg-store.ts';
export * from './live-company.ts';
export * from './live-company-counted-preview.ts';
export * from './company-current-account.ts';
export * from './live-company-special-videos.ts';
export * from './live-runtime.ts';

export async function runJobOnce(adapters:SyncAdapters={company:new MockCompanyAdapter(),notion:new MockNotionAdapter()}):Promise<boolean> {
  assertMockMode();
  const job=await claimJob();
  if(!job)return false;
  let leaseError:unknown;
  const heartbeat=setInterval(()=>{void renewLease(job).catch(error=>{leaseError=error;});},20000);
  try {
    const guarded={...adapters,guard:async()=>{if(leaseError)throw leaseError;await assertJobLease(job);}};
    await withExecutionLock(job,async()=>{
      if(job.kind==='company_sync')await syncCompany(job.trainer_id,guarded);
      else await pollNotion(job.trainer_id,guarded);
    });
    if(leaseError)throw leaseError;
    await finishJob(job);
  }catch(error){await finishJob(job,error);}
  finally{clearInterval(heartbeat);}
  return true;
}
export async function runWorkerTick():Promise<void> {
  assertMockMode();
  await scheduleDueJobs();
  await runJobOnce();
}

export * from './member-info-store.ts';
export * from './isolated-storage-queue.ts';
export * from './isolated-storage-worker.ts';

export * from './oneoff-contact-save.ts';

export * from './oneoff-profile-save.ts';

export {auditEvent,withAuditContext,safeAuditError,pruneAuditLog,closeAuditLog} from './audit-log.ts';
