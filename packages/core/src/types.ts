export type MemberStatus = '\uc2e0\uaddc' | '\ud1b5\ud654' | '\uc9c4\ud589' | '\uc878\uc5c5' | '\ud0c8\ud1f4' | '\ud0c8\ud1f4 \uc694\uccad' | '\uc720\uc608' | '\ud655\uc778\ud544\uc694';
/** Read compatibility only: new writes and initial states use 신규. */
export type LegacyMemberStatus = '\uce74\ud1a1\uc804';

export interface FixedSlot {
  /** ISO weekday: Monday=1, Sunday=7. */
  weekday: number;
  hour: number;
  minute: number;
  durationMinutes: 60;
}

export interface Member {
  trainerId: string;
  companyMemberId: string;
  name: string;
  status: MemberStatus;
  /** Prior recurring-training activation survives a pending withdrawal request. */
  trainingRecurrenceActive?: boolean;
  notionPageId: string | null;
  registrationDate: string | null;
  assignmentDate: string | null;
  assignmentEvidence: 'new' | 'existing' | 'unknown';
  membershipActivity: 'active' | 'withdrawn' | 'unknown';
  memo: string;
  fixedSlot: FixedSlot | null;
  firstTrainingDate: string | null;
  callAt: string | null;
  survey: Array<{ question: string; answer: string }>;
  manualContent: string;
}

export interface ScheduleEvent {
  key: string;
  trainerId: string;
  companyMemberId: string;
  kind: 'call' | 'training';
  start: string;
  end: string;
  status: 'active' | 'cancelled';
  manualOverride: boolean;
  /** Last timestamps written by the synchronizer, used to identify Calendar edits. */
  sourceStart: string;
  sourceEnd: string;
  /** Last status written by the synchronizer. Missing cancelled baselines are held as manual exceptions. */
  sourceStatus?: 'active' | 'cancelled';
  notionPageId?: string | null;
}

export interface Issue {
  code: string;
  message: string;
  companyMemberId?: string;
}

export interface TemplateBlock {
  id: string;
  text: string;
  ownership?: 'template' | 'managed' | 'manual';
  children?: TemplateBlock[];
}

export interface TemplateMapping {
  blockId: string;
  token: '$$$' | '@@' | '000';
  contextKey: string;
  /** If supplied, match the original block text before any replacements. */
  expectedText?: string;
  /** One-based token occurrence; mandatory when a block repeats the token. */
  occurrence?: number;
}

export interface ScheduleOptions {
  now: string;
  timezone: string;
  horizonMonths: number;
}
