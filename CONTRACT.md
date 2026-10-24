> Current status and private runtime binding policy are in docs/MILESTONE-1.md and docs/PORTABLE-CONFIG.md. The original contract below is historical; general full synchronization and multi-user support remain incomplete.

# Implementation contract

TypeScript npm workspace with an isolated synthetic demo and a manual live dry-run path. Live adapter code is implemented; operational verification and credential setup remain incomplete. The user approved dedicated company-session preservation and a scoped Notion Integration with private local token storage. Existing Chrome credentials must never be copied. External writes and the daily company schedule remain disabled. Docker web host port 127.0.0.1:4310; worker and postgres have no published ports. Root owns infrastructure, package manifests and integration. Each assigned agent owns its directories.

## Workspace
- apps/web: Next.js app router, imports @trainer/db and @trainer/core.
- apps/worker: durable PostgreSQL worker, imports @trainer/engine.
- packages/core: pure domain logic and tests.
- packages/db: PostgreSQL migration, seed and repository.
- packages/engine: pure orchestration ports, mock and official adapters, manual preview queue, tenant locks and persistent operation state.

Packages export their src/index.ts for tsx / Next transpilePackages. Root supplies pg, luxon, typescript, tsx and their types. Tests use node:test and assert. Next uses React. Avoid external AI and Google APIs entirely.

## Domain contracts
MemberStatus: '신규' | '통화' | '진행' | '졸업' | '탈퇴' | '유예' | '확인필요'.
Legacy '카톡전' is accepted only as an explicit read-compatibility alias for '신규'; new initial-state output uses '신규'. Existing non-initial statuses are preserved, and this compatibility change does not authorize external writes.
FixedSlot: { weekday: number (ISO 1 Monday..7 Sunday), hour: number, minute: number, durationMinutes: 60 }.
Member: { trainerId, companyMemberId, name, status, notionPageId: string|null, registrationDate: string|null, assignmentDate: string|null, assignmentEvidence: 'new'|'existing'|'unknown', membershipActivity: 'active'|'withdrawn'|'unknown', memo: string, fixedSlot: FixedSlot|null, firstTrainingDate: string|null (explicit YYYY-MM-DD only), callAt: string|null (ISO offset), survey: Array<{question:string,answer:string}>, manualContent: string }.
ScheduleEvent: { key, trainerId, companyMemberId, kind: 'call'|'training', start: string, end: string, status: 'active'|'cancelled', manualOverride: boolean, sourceStart: string, sourceEnd: string, notionPageId?: string|null }. Stable key must contain trainer/member/kind and occurrence identity; preserve history/manual exceptions, and never generate guessed dates.
Issue: { code, message, companyMemberId?: string }.

Core src/index.ts exports types above plus:
- parseFixedSlot(memo: string): { slot: FixedSlot|null, issues: Issue[] } (Sunday 14 => Sunday14-15, ambiguous => issue)
- validateExplicitDate(value: string|null): {date:string|null,issues:Issue[]}
- reconcileSchedules(member: Member, existing: ScheduleEvent[], options: {now: string,timezone:string,horizonMonths:number}): {events:ScheduleEvent[],issues:Issue[]}
- prepareMember(source: Member, existing?: Member): {member:Member,issues:Issue[]} (only proven newly assigned => 신규; existing omissions retain/confirm status; no registration=>assignment inference)
- applyTemplateMappings(blocks: TemplateBlock[], mappings: TemplateMapping[], context: Record<string,string>): {blocks:TemplateBlock[],issues:Issue[]} (core agent defines/exports TemplateBlock/TemplateMapping, explicit position/context mappings only; preserve manual blocks)

## Repository public API (packages/db/src/index.ts)
export async function migrate(): Promise<void>;
export async function seed(): Promise<void>; (idempotent synthetic only, trainer-demo and trainer-other)
export async function getDashboard(trainerId:string): Promise<DashboardSnapshot>;
export async function enqueueJob(trainerId:string, kind:'company_sync'|'notion_poll', source?:'manual'|'schedule'): Promise<string>;
export async function saveSettings(trainerId:string, input: {dailyTime:string|null, timezone:string, horizonMonths:number, notionPollMinutes:number, mockScheduleEnabled:boolean}): Promise<void>;
export async function closeDb(): Promise<void>;
DashboardSnapshot: {trainer:{id:string,name:string}, mode:'mock', connections:Array<{type:string,status:string,detail:string}>, settings:{dailyTime:string|null,timezone:string,horizonMonths:number,notionPollMinutes:number,mockScheduleEnabled:boolean}, members:Member[], jobs:Array<{id:string,kind:string,status:string,attempts:number,createdAt:string,finishedAt:string|null,error:string|null}>, issues:Array<Issue & {id?:string}>, schedules:ScheduleEvent[], stats:{members:number,activeSchedules:number,needsReview:number,lastSuccess:string|null}}.

DB agent can add internal repository API for worker persistence/locking/recovery. Web actions derive the tenant exclusively from server configuration; reject cross origin and client-selected tenant IDs. The demo remains trainer-demo; dedicated live configuration uses trainer-live-one. Daily schedule remains OFF and dailyTime=null. Notion polling 5 minutes default applies mock only. UI distinguishes implemented adapter code, missing connections and incomplete verification; a connection is never inferred from token-file existence alone.

## Engine public API
export async function runWorkerTick(): Promise<void>;
export async function runJobOnce(): Promise<boolean>; (tests/CLI)
Worker entry repeatedly calls tick; durable jobs, leases/SKIP LOCKED or atomic claim; overlap prevention, bounded exponential retry incl retry-after, partial-stage idempotency, catchup after PC interruption. No secrets logged. Real company DOM profiles require observed evidence for account scope, unrestricted filters and complete pagination. Unknown structures fail closed. Official Notion reads and writes have independent permits; the live runtime only supplies a read permit. Synthetic mock Notion persists in Postgres so survives restart.
