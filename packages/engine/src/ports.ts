import type { Member, ScheduleEvent } from '@trainer/core';

/** Company implementation must prove complete trainer-scoped pagination before writes. */
export interface CompanyPage {
  members: Member[];
  nextCursor: string | null;
  scope: 'all_assigned';
  completeCoverage: boolean;
  snapshotId: string;
}
export interface CompanyAdapter {
  listMembers(input: { trainerId: string; cursor: string | null; scope: 'all_assigned' }): Promise<CompanyPage>;
}
export interface NotionAdapter {
  ensureMemberPage(member: Member): Promise<{ pageId: string }>;
  awaitTemplate(trainerId: string, companyMemberId: string): Promise<void>;
  fillMemberPage(member: Member): Promise<void>;
  readMembers(trainerId: string): Promise<Member[]>;
  /** Verify the same trainer/member page exists and its template is ready before using it as a calendar relation. */
  isMemberPageReady(member: Member): Promise<boolean>;
  readCalendar(trainerId: string): Promise<ScheduleEvent[]>;
  writeCalendar(trainerId: string, events: ScheduleEvent[]): Promise<void>;
}
export class RetryableError extends Error {
  constructor(message: string, public readonly retryAfterMs = 0) { super(message); this.name = 'RetryableError'; }
}
export class ExternalAdapterDisabledError extends Error {
  constructor() { super('Real company and Notion adapters are unimplemented and disabled. Connection approval and verified mappings are required.'); this.name = 'ExternalAdapterDisabledError'; }
}
export function assertMockMode(): void {
  if ((process.env.ADAPTER_MODE ?? 'mock') !== 'mock' || process.env.EXTERNAL_CONNECTIONS_ENABLED === 'true') {
    throw new ExternalAdapterDisabledError();
  }
}
