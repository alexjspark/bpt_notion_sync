import { randomUUID } from 'node:crypto';
import type { CompanyAdapter, CompanyPage } from './ports.ts';
import { assertCompanyProfile, CompanyDomError, parseCompanyListSnapshot, parseCompanySurveySnapshot } from './live-company-dom.ts';
import type { CompanyReadRecord, CompanyReadSession, CompanyTrainerBinding, VerifiedDomProfile } from './live-company-types.ts';

/** Full active-assigned read-only scan. The legacy all_assigned port literal means all active assigned here. */
export class LiveCompanyAdapter implements CompanyAdapter {
  private reading = false;
  constructor(private readonly options: {
    session: CompanyReadSession;
    profile: VerifiedDomProfile;
    binding: CompanyTrainerBinding;
    maxPages?: number;
  }) {
    assertCompanyProfile(options.profile);
    if (!Number.isSafeInteger(options.maxPages ?? 1000) || (options.maxPages ?? 1000) < 1 || (options.maxPages ?? 1000) > 1000) throw new CompanyDomError('COMPANY_PAGE_LIMIT_INVALID');
  }
  async listMembers(input: { trainerId: string; cursor: string | null; scope: 'all_assigned' }): Promise<CompanyPage> {
    if (input.scope !== 'all_assigned' || input.cursor !== null) throw new CompanyDomError('COMPANY_CURSOR_MISMATCH');
    const result = await this.scan(input.trainerId);
    return { members: result.records.map(record => record.member), nextCursor: null, scope: 'all_assigned', completeCoverage: true, snapshotId: result.snapshotId };
  }
  async readRecords(trainerId: string): Promise<CompanyReadRecord[]> {
    return (await this.scan(trainerId)).records;
  }
  private async scan(trainerId: string): Promise<{ records: CompanyReadRecord[]; snapshotId: string }> {
    if (this.reading) throw new CompanyDomError('COMPANY_READ_IN_PROGRESS');
    this.reading = true;
    try { return await this.scanExclusive(trainerId); }
    finally { this.reading = false; }
  }
  private async scanExclusive(trainerId: string): Promise<{ records: CompanyReadRecord[]; snapshotId: string }> {
    const { session, profile, binding } = this.options;
    if (trainerId !== binding.trainerId) throw new CompanyDomError('COMPANY_TRAINER_MISMATCH');
    // This identifies one sequential DOM scan; it does not claim a remote database transaction.
    const snapshotId = `company-dom:${randomUUID()}`;
    const records = new Map<string, CompanyReadRecord>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let ended = false;
    for (let index = 0; index < (this.options.maxPages ?? 1000); index++) {
      const snapshot = await session.readList({ cursor, snapshotId, trainer: binding });
      const page = parseCompanyListSnapshot(profile, binding, snapshot, { cursor, snapshotId });
      for (const record of page.records) {
        const existing = records.get(record.member.companyMemberId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new CompanyDomError('COMPANY_CONFLICTING_DUPLICATE');
        records.set(record.member.companyMemberId, record);
      }
      if (page.nextCursor === null) { ended = true; break; }
      if (seenCursors.has(page.nextCursor)) throw new CompanyDomError('COMPANY_PAGINATION_LOOP');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (!ended) throw new CompanyDomError('COMPANY_PAGE_LIMIT');
    if (profile.survey) {
      if (!session.readSurvey) throw new CompanyDomError('COMPANY_SURVEY_SESSION_UNAVAILABLE');
      for (const record of records.values()) {
        const snapshot = await session.readSurvey({ companyMemberId: record.member.companyMemberId, trainer: binding });
        record.member.survey = parseCompanySurveySnapshot(profile, binding, record.member.companyMemberId, snapshot);
      }
    }
    return { records: [...records.values()], snapshotId };
  }
}
