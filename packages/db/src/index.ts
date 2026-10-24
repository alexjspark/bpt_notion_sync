import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Member, Issue, ScheduleEvent } from '@trainer/core';
import { normalizeMember } from '@trainer/core';
import { syntheticMembers } from './fixtures.ts';
export { syntheticMembers } from './fixtures.ts';

export interface Settings {
  dailyTime: string | null;
  timezone: string;
  horizonMonths: number;
  notionPollMinutes: number;
  mockScheduleEnabled: boolean;
}
export const defaultSettings: Settings = { dailyTime: null, timezone: 'Asia/Seoul', horizonMonths: 3, notionPollMinutes: 5, mockScheduleEnabled: false };
export type JobKind = 'company_sync' | 'notion_poll';
export interface DashboardSnapshot {
  trainer: { id: string; name: string };
  mode: 'mock';
  connections: Array<{ type: string; status: string; detail: string }>;
  settings: Settings;
  members: Member[];
  jobs: Array<{ id: string; kind: string; status: string; attempts: number; createdAt: string; finishedAt: string | null; error: string | null }>;
  issues: Array<Issue & { id?: string }>;
  schedules: ScheduleEvent[];
  stats: { members: number; activeSchedules: number; needsReview: number; lastSuccess: string | null };
}

let pool: pg.Pool | undefined;
function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required; no external database is selected automatically.');
    pool = new pg.Pool({ connectionString, max: 8 });
  }
  return pool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
/** A caller holding a session lock must reuse this client for its fenced work. */
export async function connectDb(): Promise<PoolClient> { return getPool().connect(); }
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
export async function closeDb(): Promise<void> { if (pool) { await pool.end(); pool = undefined; } }
export async function migrate(): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trainer-sync-migration'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const version of ['001_initial', '002_connections', '003_manual_sync', '004_notion_managed_state', '005_live_readonly_state', '006_company_review_code', '007_isolated_storage_tests', '008_oneoff_contact_save', '009_oneoff_profile_save', '010_sync_audit_events', '011_team_tenants', '012_team_browser_runtime', '013_team_pilot']) {
      const applied = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (!applied.rowCount) {
        const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
      }
    }
  });
}
export async function seed(): Promise<void> {
  if (process.env.ADAPTER_MODE && process.env.ADAPTER_MODE !== 'mock') throw new Error('Synthetic seed is mock-only.');
  for (const [id, name] of [['trainer-demo', '데모 트레이너'], ['trainer-other', '격리 검증 트레이너']] as const) {
    await query('INSERT INTO trainers(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id, name]);
    for (const provider of ['company', 'notion']) {
      await query('INSERT INTO connections(trainer_id,provider,public_config) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [id, provider, JSON.stringify({ fixtureOnly: true, syntheticScope: id })]);
    }
    for (const member of syntheticMembers(id)) {
      await query('INSERT INTO members(trainer_id,company_member_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [id, member.companyMemberId, JSON.stringify(member)]);
    }
  }
}
export async function getSettings(trainerId: string): Promise<Settings> {
  const result = await query<{ settings: Settings }>('SELECT settings FROM trainers WHERE id=$1', [trainerId]);
  if (!result.rows[0]) throw new Error('Unknown trainer.');
  return { ...defaultSettings, ...result.rows[0].settings };
}
export async function saveSettings(trainerId: string, input: Settings): Promise<void> {
  if (input.dailyTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime)) throw new Error('dailyTime must be HH:mm or null.');
  if (typeof input.timezone !== 'string' || !input.timezone) throw new Error('Invalid timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw new Error('Invalid timezone.'); }
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 1 || input.horizonMonths > 12) throw new Error('horizonMonths must be 1..12.');
  if (!Number.isInteger(input.notionPollMinutes) || input.notionPollMinutes < 5 || input.notionPollMinutes > 1440) throw new Error('notionPollMinutes must be 5..1440.');
  if (typeof input.mockScheduleEnabled !== 'boolean') throw new Error('mockScheduleEnabled must be boolean.');
  if (input.mockScheduleEnabled && input.dailyTime === null) throw new Error('Choose a time before enabling the mock daily schedule.');
  await transaction(async (client) => {
    const result = await client.query<{ settings: Settings }>('SELECT settings FROM trainers WHERE id=$1 FOR UPDATE', [trainerId]);
    if (!result.rows[0]) throw new Error('Unknown trainer.');
    const previous = { ...defaultSettings, ...result.rows[0].settings };
    await client.query('UPDATE trainers SET settings=$2::jsonb WHERE id=$1', [trainerId, JSON.stringify(input)]);
    if (previous.dailyTime !== input.dailyTime || previous.timezone !== input.timezone || previous.mockScheduleEnabled !== input.mockScheduleEnabled) {
      await client.query('DELETE FROM scheduler_state WHERE trainer_id=$1 AND kind=$2', [trainerId, 'company_sync']);
    }
    if (previous.notionPollMinutes !== input.notionPollMinutes) {
      await client.query('DELETE FROM scheduler_state WHERE trainer_id=$1 AND kind=$2', [trainerId, 'notion_poll']);
    }
  });
}
export async function getMembers(trainerId: string): Promise<Member[]> {
  return (await query<{ data: Member }>('SELECT data FROM members WHERE trainer_id=$1 ORDER BY company_member_id', [trainerId])).rows.map((row) => normalizeMember(row.data));
}
export async function getMember(trainerId: string, companyMemberId: string): Promise<Member | undefined> {
  const saved = (await query<{ data: Member }>('SELECT data FROM members WHERE trainer_id=$1 AND company_member_id=$2', [trainerId, companyMemberId])).rows[0]?.data;
  return saved ? normalizeMember(saved) : undefined;
}
export async function upsertMember(trainerId: string, member: Member): Promise<void> {
  member = normalizeMember(member);
  if (trainerId !== member.trainerId) throw new Error('Tenant mismatch.');
  await query('INSERT INTO members(trainer_id,company_member_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(trainer_id,company_member_id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()', [trainerId, member.companyMemberId, JSON.stringify(member)]);
}
export async function getSchedules(trainerId: string, companyMemberId?: string): Promise<ScheduleEvent[]> {
  const result = companyMemberId === undefined
    ? await query<{ data: ScheduleEvent }>("SELECT data FROM schedules WHERE trainer_id=$1 ORDER BY data->>'start',event_key", [trainerId])
    : await query<{ data: ScheduleEvent }>("SELECT data FROM schedules WHERE trainer_id=$1 AND company_member_id=$2 ORDER BY data->>'start',event_key", [trainerId, companyMemberId]);
  return result.rows.map((row) => row.data);
}
export async function saveSchedules(trainerId: string, events: ScheduleEvent[]): Promise<void> {
  if (events.some((event) => event.trainerId !== trainerId)) throw new Error('Tenant mismatch.');
  await transaction(async (client) => {
    for (const event of events) {
      await client.query('INSERT INTO schedules(trainer_id,event_key,company_member_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(trainer_id,event_key) DO UPDATE SET data=EXCLUDED.data,updated_at=now()', [trainerId, event.key, event.companyMemberId, JSON.stringify(event)]);
    }
  });
}
export async function replaceIssues(trainerId: string, companyMemberId: string | null, issues: Issue[]): Promise<void> {
  if (issues.some((issue) => issue.companyMemberId && issue.companyMemberId !== companyMemberId)) throw new Error('Member issue mismatch.');
  await transaction(async (client) => {
    await client.query('DELETE FROM issues WHERE trainer_id=$1 AND company_member_id IS NOT DISTINCT FROM $2', [trainerId, companyMemberId]);
    for (const issue of issues) await client.query('INSERT INTO issues(id,trainer_id,company_member_id,code,message) VALUES($1,$2,$3,$4,$5)', [randomUUID(), trainerId, companyMemberId, issue.code, issue.message]);
  });
}
export async function enqueueJob(trainerId: string, kind: JobKind, source: 'manual' | 'schedule' = 'manual'): Promise<string> {
  const result = await query<{ id: string }>("INSERT INTO jobs(id,trainer_id,kind,source) VALUES($1,$2,$3,$4) ON CONFLICT(trainer_id,kind) WHERE status IN ('queued','running','retry') DO UPDATE SET id=jobs.id RETURNING id", [randomUUID(), trainerId, kind, source]);
  return result.rows[0]!.id;
}
export async function getDashboard(trainerId: string): Promise<DashboardSnapshot> {
  const trainer = (await query<{ id: string; name: string }>('SELECT id,name FROM trainers WHERE id=$1', [trainerId])).rows[0];
  if (!trainer) throw new Error('Unknown trainer.');
  const [settings, members, schedules, jobRows, issueRows, connectionRows] = await Promise.all([
    getSettings(trainerId), getMembers(trainerId), getSchedules(trainerId),
    query<{ id: string; kind: string; status: string; attempts: number; created_at: Date; finished_at: Date | null; error: string | null }>('SELECT id,kind,status,attempts,created_at,finished_at,error FROM jobs WHERE trainer_id=$1 ORDER BY created_at DESC LIMIT 40', [trainerId]),
    query<{ id: string; code: string; message: string; company_member_id: string | null }>('SELECT id,code,message,company_member_id FROM issues WHERE trainer_id=$1 ORDER BY created_at DESC', [trainerId]),
    query<{ provider: string }>('SELECT provider FROM connections WHERE trainer_id=$1 ORDER BY provider', [trainerId]),
  ]);
  const jobs = jobRows.rows.map((row) => ({ id: row.id, kind: row.kind, status: row.status, attempts: row.attempts, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, error: row.error }));
  const issues = issueRows.rows.map((row) => ({ id: row.id, code: row.code, message: row.message, ...(row.company_member_id ? { companyMemberId: row.company_member_id } : {}) }));
  return { trainer, mode: 'mock', settings, members, schedules, jobs, issues,
    connections: (connectionRows.rows.length ? connectionRows.rows.map((row) => row.provider) : ['company', 'notion']).map((provider) => ({
      type: provider,
      status: 'mock',
      detail: provider === 'company'
        ? '합성 데이터만 사용. 실제 셀렉터·로그인·specialVideos 추출은 미검증/비활성화.'
        : '로컬 PostgreSQL에 모의 페이지·일정 저장. 실제 토큰·템플릿 매핑·API 연결 없음.',
    })),
    stats: { members: members.length, activeSchedules: schedules.filter((event) => event.status === 'active').length, needsReview: issues.length, lastSuccess: jobs.find((job) => job.status === 'succeeded')?.finishedAt ?? null },
  };
}
