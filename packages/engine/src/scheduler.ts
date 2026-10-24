import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { getSettings, query, transaction } from '@trainer/db';
import { assertMockMode } from './ports.ts';

/** Daily local wall time; skipped PC-off days coalesce into one complete catch-up scan. */
export function nextDailyDue(nowIso:string,time:string,timezone:string):string {
  const now=DateTime.fromISO(nowIso,{zone:timezone});
  const [hour,minute]=time.split(':').map(Number);
  let due=now.set({hour,minute,second:0,millisecond:0});
  if(due<=now)due=due.plus({days:1});
  return due.toUTC().toISO()!;
}
export async function scheduleDueJobs(nowIso=new Date().toISOString()):Promise<void> {
  assertMockMode();
  const trainers=await query<{id:string}>(`SELECT id FROM trainers ORDER BY id`);
  for(const {id} of trainers.rows) {
    const settings=await getSettings(id);
    const kinds: Array<'company_sync'|'notion_poll'>=['notion_poll'];
    if(settings.mockScheduleEnabled&&settings.dailyTime)kinds.push('company_sync');
    else await query(`DELETE FROM scheduler_state WHERE trainer_id=$1 AND kind='company_sync'`,[id]);
    for(const kind of kinds) {
      await transaction(async client=>{
        await client.query(`INSERT INTO scheduler_state(trainer_id,kind,next_due) VALUES($1,$2,$3::timestamptz)
          ON CONFLICT(trainer_id,kind) DO NOTHING`,[id,kind,kind==='company_sync'?nextDailyDue(nowIso,settings.dailyTime!,settings.timezone):nowIso]);
        const state=await client.query(`SELECT next_due FROM scheduler_state WHERE trainer_id=$1 AND kind=$2 FOR UPDATE`,[id,kind]);
        if(new Date(state.rows[0].next_due).getTime()>new Date(nowIso).getTime())return;
        // Queue insertion and cursor advance commit together; a process stop cannot
        // leave a consumed cursor without its job, or multiply a catch-up backlog.
        await client.query(`INSERT INTO jobs(id,trainer_id,kind,source) VALUES($1,$2,$3,'schedule')
          ON CONFLICT(trainer_id,kind) WHERE status IN ('queued','running','retry') DO NOTHING`,[randomUUID(),id,kind]);
        const next=kind==='company_sync'?nextDailyDue(nowIso,settings.dailyTime!,settings.timezone):DateTime.fromISO(nowIso).plus({minutes:settings.notionPollMinutes}).toUTC().toISO();
        await client.query(`UPDATE scheduler_state SET next_due=$3::timestamptz WHERE trainer_id=$1 AND kind=$2`,[id,kind,next]);
      });
    }
  }
}
