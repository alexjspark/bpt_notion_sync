import{randomUUID}from'node:crypto';import{auditEvent}from'@trainer/engine';
import{getContactSaveOnce,queueContactSaveOnce,publicContactSaveOnce,getLiveReadOnlyState,LIVE_MANUAL_TRAINER_ID}from'@trainer/engine';
import{allowedOrigin,safeJson}from'../../../lib/server';import{assertSameOrigin}from'../../../lib/validation';
export const dynamic='force-dynamic';
export async function GET(){try{const row=await getContactSaveOnce(),state=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID);return safeJson({mode:'one_time_editing_paused',generalWritesEnabled:false,scheduledExecution:false,canQueue:state.connected&&row?.status==='prepared',run:publicContactSaveOnce(row)});}catch{return safeJson({errorCode:'CONTACT_SAVE_STATUS_UNAVAILABLE'},503);}}
export async function POST(request:Request){
 try{assertSameOrigin(request.headers,request.url,allowedOrigin(request));}catch{return safeJson({errorCode:'CONTACT_SAVE_ORIGIN_REJECTED'},403);}
 try{const body=await request.json();if(!body||Object.keys(body).length!==1||body.action!=='save_approved_contacts_once')throw Error();}catch{return safeJson({errorCode:'CONTACT_SAVE_REQUEST_INVALID'},400);}
 try{const state=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID);if(!state.connected)return safeJson({errorCode:'CONTACT_SAVE_CONNECTION_REQUIRED'},409);const run=await queueContactSaveOnce(),requestId=randomUUID();await auditEvent({runId:run.id,runKind:'contact_once',requestId,accountId:LIVE_MANUAL_TRAINER_ID,stage:'ui_request',outcome:'succeeded',provider:'ui',operation:'queue'});await auditEvent({runId:run.id,runKind:'contact_once',requestId,accountId:LIVE_MANUAL_TRAINER_ID,stage:'queued',outcome:run.status==='queued'?'succeeded':'skipped',...(run.status==='queued'?{}:{reasonCode:'REPLAY_BLOCKED'})});return safeJson({mode:'one_time_editing_paused',run:publicContactSaveOnce(run)},202);}catch{return safeJson({errorCode:'CONTACT_SAVE_NOT_AVAILABLE'},409);}
}
