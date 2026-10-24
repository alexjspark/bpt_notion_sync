import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, migrate, query } from '@trainer/db';
import { getLiveReadOnlyState, LIVE_MANUAL_TRAINER_ID, publishLiveReadOnlyState } from '../src/live-runtime.ts';

before(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Dedicated TEST_DATABASE_URL required');
  process.env.DATABASE_URL=url;await migrate();
});
after(async()=>{await query('DELETE FROM trainers WHERE id=$1',[LIVE_MANUAL_TRAINER_ID]);await closeDb();});
test('DB-backed read-only readiness is tenant scoped, credential-free and expires when worker stops',async()=>{
  assert.equal((await getLiveReadOnlyState('synthetic-no-live-tenant')).connected,false);
  await publishLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID,{companyStatus:'ready',notionStatus:'ready',previewKeyReady:true});
  const connected=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID);
  assert.equal(connected.connected,true);assert.equal(connected.externalWritesEnabled,false);assert.equal(connected.automaticSyncEnabled,false);
  assert.equal((await getLiveReadOnlyState('trainer-other')).connected,false);
  await assert.rejects(publishLiveReadOnlyState('trainer-demo',{companyStatus:'ready',notionStatus:'ready',previewKeyReady:true}),/LIVE_TRAINER_BINDING_INVALID/);
  await query("UPDATE live_readonly_state SET heartbeat_at=now()-interval '31 seconds' WHERE trainer_id=$1",[LIVE_MANUAL_TRAINER_ID]);
  const expired=await getLiveReadOnlyState(LIVE_MANUAL_TRAINER_ID);
  assert.equal(expired.connected,false);assert.equal(expired.companyStatus,'worker_offline');
  assert.deepEqual(expired.requiredConnections,['company_read_session','notion_read_integration']);
  const columns=(await query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='live_readonly_state' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
  assert.deepEqual(columns,['trainer_id','company_status','notion_status','preview_key_ready','heartbeat_at']);
});
