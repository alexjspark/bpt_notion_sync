import{query,closeDb}from'@trainer/db';
const run=process.argv[2];if(!run||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(run))throw Error('VALID_RUN_ID_REQUIRED');
try{const rows=await query('SELECT id,occurred_at,level,stage,outcome,event FROM sync_audit_events WHERE run_id=$1 ORDER BY id LIMIT 1000',[run]);for(const r of rows.rows)console.log(JSON.stringify(r));}finally{await closeDb();}
