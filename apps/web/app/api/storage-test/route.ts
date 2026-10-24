import{getIsolatedStorageRun,queueIsolatedStorageRun,publicIsolatedStorageRun,getLiveReadOnlyState,LIVE_MANUAL_TRAINER_ID}from'@trainer/engine';
import{allowedOrigin,safeJson}from'../../../lib/server';import{assertSameOrigin}from'../../../lib/validation';
export const dynamic='force-dynamic';
const flags={mode:'isolated_storage_test',realMemberWritesEnabled:false,scheduledExecution:false,onlyOneSyntheticPage:true};
export async function GET(){try{const state=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID),run=await getIsolatedStorageRun();return safeJson({...flags,canQueue:state.connected&&run!==null,run:publicIsolatedStorageRun(run)});}catch{return safeJson({...flags,canQueue:false,errorCode:'ISOLATED_STORAGE_UNAVAILABLE',run:null},503);}}
export async function POST(request:Request){
 try{assertSameOrigin(request.headers,request.url,allowedOrigin(request));}catch{return safeJson({errorCode:'ISOLATED_ORIGIN_REJECTED'},403);}
 try{const b=await request.json();if(!b||Object.keys(b).length!==1||b.action!=='run_isolated_storage_test')throw new Error('invalid');}catch{return safeJson({errorCode:'ISOLATED_REQUEST_INVALID'},400);}
 try{const state=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID);if(!state.connected)return safeJson({...flags,errorCode:'ISOLATED_CONNECTION_REQUIRED'},409);
 if(!await getIsolatedStorageRun())return safeJson({...flags,errorCode:'ISOLATED_DESTINATION_APPROVAL_REQUIRED'},409);
 return safeJson({...flags,run:publicIsolatedStorageRun(await queueIsolatedStorageRun())},202);}catch{return safeJson({...flags,errorCode:'ISOLATED_QUEUE_UNAVAILABLE'},503);}
}
