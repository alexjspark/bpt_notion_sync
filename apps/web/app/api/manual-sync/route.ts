import{auditEvent}from'@trainer/engine';
import { randomUUID } from 'node:crypto';
import { getLiveReadOnlyState, LIVE_MANUAL_TRAINER_ID, listManualSyncRuns, queueManualSyncRun } from '@trainer/engine';
import { activeTrainerId, allowedOrigin, safeJson } from '../../../lib/server';
import { assertSameOrigin } from '../../../lib/validation';
import { parseManualSyncRequest } from '../../../lib/manual-sync-request';

export const dynamic = 'force-dynamic';

/** Credentials and read permits are intentionally absent from this runtime. */
const requiredConnections = ['company_read_session', 'notion_read_integration'] as const;
const state = {
  mode: 'dry_run' as const,
  connected: false,
  requiredConnections,
  automaticSyncEnabled: false,
  previewOnly: true,
  externalWritesEnabled: false,
};
function trainerId(): string {
  return process.env.LIVE_MANUAL_TRAINER_ID === LIVE_MANUAL_TRAINER_ID ? LIVE_MANUAL_TRAINER_ID : activeTrainerId();
}
async function currentState() {
  return trainerId() === LIVE_MANUAL_TRAINER_ID ? getLiveReadOnlyState(trainerId()) : { ...state, readiness: { companyRead: false, notionInventoryRead: false } };
}
function responseState(value: Awaited<ReturnType<typeof currentState>>) {
  const { readiness: _privateReadiness, ...publicState } = value;
  return publicState;
}

export async function GET() {
  try {
    const current = await currentState();
    return safeJson({ ...responseState(current), runs: await listManualSyncRuns(trainerId()) });
  } catch {
    return safeJson({ ...state, runs: [], errorCode: 'MANUAL_SYNC_STORAGE_UNAVAILABLE' }, 503);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request.headers, request.url, allowedOrigin(request));
  } catch {
    return safeJson({ errorCode: 'MANUAL_SYNC_ORIGIN_REJECTED' }, 403);
  }
  try {
    parseManualSyncRequest(await request.json());
  } catch {
    return safeJson({ errorCode: 'MANUAL_SYNC_INVALID_REQUEST' }, 400);
  }
  try {
    // The server chooses the tenant. Neither the request nor environment flags
    // can grant a company session, Notion permit, or real write approval.
    const current = await currentState();
    const requestId=randomUUID();const run = await queueManualSyncRun(trainerId(), requestId, current.readiness);
    await auditEvent({runId:run.id,runKind:'preview',requestId,accountId:run.trainerId,stage:'ui_request',outcome:'succeeded',provider:'ui',operation:'queue'});await auditEvent({runId:run.id,runKind:'preview',requestId,accountId:run.trainerId,stage:'queued',outcome:run.status==='needs_connection'?'held':'succeeded',...(run.status==='needs_connection'?{reasonCode:'NOT_CONNECTED'}:{})});
    return safeJson({ ...responseState(current), run }, 202);
  } catch {
    return safeJson({ ...state, errorCode: 'MANUAL_SYNC_QUEUE_UNAVAILABLE' }, 503);
  }
}
