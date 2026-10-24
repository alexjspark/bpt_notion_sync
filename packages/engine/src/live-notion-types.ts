import type { FixedSlot, LegacyMemberStatus, Member, MemberStatus, ScheduleEvent } from '@trainer/core';

/** Use stable property IDs obtained from the official schema endpoint, not display-name guesses. */
export interface NotionProperty<T extends string = string> { readonly id: string; readonly type: T }
export type NotionIdentityBinding = {
  readonly mode: 'properties';
  readonly trainerId: NotionProperty<'rich_text'>;
  readonly companyMemberId: NotionProperty<'rich_text'>;
} | {
  readonly mode: 'exclusive-data-source-admin-url';
  readonly trainerId: string;
  readonly exclusiveOwnershipApproved: true;
  readonly adminUrl: NotionProperty<'url'>;
  readonly adminOrigin: string;
  readonly memberPathPrefix: '/manage/members/';
};
export interface NotionBlockSelector {
  /** Zero-based child positions in the duplicated template; the selected type and text must match. */
  readonly path: readonly number[];
  readonly type: string;
  readonly expectedText: string;
}
export interface NotionTemplateReplacement extends NotionBlockSelector {
  readonly ownership: 'template';
  readonly token: string;
  readonly contextKey: string;
  /** One-based position; required even when the token occurs once. */
  readonly occurrence: number;
}
export interface NotionTemplateBinding {
  readonly templateId: string;
  readonly timezone: string;
  /** All exact fingerprints must be present. An arbitrary nonempty page is never ready. */
  readonly readiness: readonly NotionBlockSelector[];
  readonly replacements: readonly NotionTemplateReplacement[];
  readonly surveyContainer?: NotionBlockSelector;
  readonly context: (member: Member) => Readonly<Record<string, string>>;
}
export interface NotionMemberBinding {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly allowedTrainerIds: readonly string[];
  readonly identity: NotionIdentityBinding;
  readonly name: NotionProperty<'title'>;
  readonly companyUid?:NotionProperty<'rich_text'|'number'>;
  readonly status: NotionProperty<'select' | 'status'>;
  /** Every source option is explicitly mapped or causes review. No fuzzy status conversion. */
  readonly statuses: Readonly<Record<string, MemberStatus | LegacyMemberStatus>>;
  readonly createStatus: Readonly<Partial<Record<MemberStatus, string>>>;
  readonly weekday?: NotionProperty<'select'>;
  readonly weekdays?: Readonly<Record<string, number>>;
  readonly time?: NotionProperty<'select'>;
  readonly times?: Readonly<Record<string, Pick<FixedSlot, 'hour' | 'minute'>>>;
  readonly firstTraining?: NotionProperty<'date'>;
  readonly callAt?: NotionProperty<'date'>;
  readonly template?: NotionTemplateBinding;
}
export interface NotionCalendarBinding {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly name: NotionProperty<'title'>;
  readonly trainerId: NotionProperty<'rich_text'>;
  readonly companyMemberId: NotionProperty<'rich_text'>;
  readonly key: NotionProperty<'rich_text'>;
  readonly memberRelation: NotionProperty<'relation'>;
  readonly range: NotionProperty<'date'>;
  readonly sourceRange: NotionProperty<'date'>;
  readonly status: NotionProperty<'select' | 'status'>;
  readonly sourceStatus: NotionProperty<'select' | 'status'>;
  readonly statuses: Readonly<Record<string, ScheduleEvent['status']>>;
  readonly writeStatuses: Readonly<Record<ScheduleEvent['status'], string>>;
  readonly kind: NotionProperty<'select'>;
  readonly kinds: Readonly<Record<string, ScheduleEvent['kind']>>;
  readonly writeKinds: Readonly<Record<ScheduleEvent['kind'], string>>;
  readonly manualOverride: NotionProperty<'checkbox'>;
}
export interface NotionManagedState {
  revision?: number;
  pageId?: string;
  /** Hash of the synchronizer's last text; updates require this exact remote value. */
  surveyBlocks?: Record<string, {blockId: string; fingerprint: string}>;
  personalizedBlocks?: Record<string, {originalFingerprint: string; currentFingerprint: string}>;
  /** Persisted before a write; a crash/uncertain outcome requires reconciliation. */
  pendingWrite?: {operation: NotionPlanOperation['kind']};
}
/** A durable, tenant-scoped store and distributed lock are required for executing plans. */
export interface NotionManagedStateStore {
  withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
  read(key: string): Promise<NotionManagedState | undefined>;
  write(key: string, state: NotionManagedState): Promise<void>;
}
export interface NotionPlanOperation {
  readonly kind: 'create-member' | 'personalize-block' | 'rename-child-page' | 'append-survey' | 'update-survey' | 'create-calendar' | 'update-calendar';
  readonly target: string;
  readonly body: Readonly<Record<string, unknown>>;
}
export interface NotionWritePlan {
  readonly trainerId: string;
  readonly companyMemberId?: string;
  readonly existingPageId?: string;
  readonly operations: readonly NotionPlanOperation[];
  readonly warnings: readonly string[];
}

/** Complete-query, partial-identity inventory for read-only previews; it never grants write/apply readiness. */
export interface NotionPartialPreviewInventory {
  identities: Array<{ trainerId: string; companyMemberId: string; pageId: string; label: string; existingStatus: string | null }>;
  reviewRows: Array<{ pageId: string; label: string; reason: 'missing_admin_url' | 'invalid_admin_url' }>;
  queryCoverage: 'complete';
  identityCoverage: 'partial' | 'complete';
  canProveAbsence: boolean;
  snapshotId: string;
}