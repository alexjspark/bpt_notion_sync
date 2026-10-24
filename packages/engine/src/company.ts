import type { Member } from '@trainer/core';
import { syntheticMembers } from '@trainer/db';
import type { CompanyAdapter, CompanyPage } from './ports.ts';
import { assertMockMode, ExternalAdapterDisabledError } from './ports.ts';

export const COMPANY_READ_ONLY_URL = 'https://admin.biz-pt.com/manage/members';
/** No selectors, login flow, specialVideos path or private endpoint is guessed here. */
export class UnverifiedCompanyAdapter implements CompanyAdapter {
  async listMembers(): Promise<never> { throw new ExternalAdapterDisabledError(); }
}
export class MockCompanyAdapter implements CompanyAdapter {
  constructor(private readonly options: { now?: string; members?: Member[]; pageSize?: number } = {}) {}
  async listMembers(input: {trainerId: string; cursor: string | null; scope: 'all_assigned'}): Promise<CompanyPage> {
    assertMockMode();
    const members = this.options.members ?? syntheticMembers(input.trainerId, this.options.now ?? new Date().toISOString());
    const offset = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid mock page cursor');
    const size = this.options.pageSize ?? 2;
    return { members: structuredClone(members.slice(offset, offset + size)), nextCursor: offset + size < members.length ? String(offset + size) : null,
      scope: 'all_assigned', completeCoverage: true, snapshotId: `synthetic:${input.trainerId}` };
  }
}
export async function collectAssignedMembers(adapter: CompanyAdapter, trainerId: string): Promise<Member[]> {
  const found = new Map<string, Member>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  let snapshot: string | undefined;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await adapter.listMembers({ trainerId, cursor, scope: 'all_assigned' });
    if (page.scope !== 'all_assigned' || !page.completeCoverage || !page.snapshotId) throw new Error('COMPANY_COVERAGE_UNVERIFIED: no writes performed');
    if (snapshot !== undefined && snapshot !== page.snapshotId) throw new Error('COMPANY_SNAPSHOT_CHANGED: no writes performed');
    snapshot = page.snapshotId;
    for (const member of page.members) {
      if (member.trainerId !== trainerId || !member.companyMemberId) throw new Error('TENANT_MISMATCH: company page rejected');
      const old = found.get(member.companyMemberId);
      if (old && JSON.stringify(old) !== JSON.stringify(member)) throw new Error('COMPANY_CONFLICTING_DUPLICATE: manual review needed');
      found.set(member.companyMemberId, member);
    }
    if (page.nextCursor === null) return [...found.values()];
    if (seen.has(page.nextCursor)) throw new Error('COMPANY_PAGINATION_LOOP: no writes performed');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('COMPANY_PAGE_LIMIT: no writes performed');
}
