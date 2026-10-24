export const TEAM_CODES = ['DISABLED','AUTH_REQUIRED','LOGIN_FAILED','LOGIN_THROTTLED','INVALID_INPUT','FORBIDDEN','NOT_FOUND','CONFLICT','VAULT_UNCONFIGURED','SECRET_INVALID','PROVIDER_UNAVAILABLE','ACCOUNT_UNVERIFIED','ACCOUNT_CHANGED','CONNECTION_CHANGED','NOT_READY','DESTINATION_INVALID','LEASE_LOST','PREVIEW_FAILED'] as const;
export type TeamCode = typeof TEAM_CODES[number];
export class TeamError extends Error { constructor(public readonly code: TeamCode, public readonly status=409) { super(code); this.name='TeamError'; } }
export const uuid = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export function requireUuid(v: unknown): string { if(!uuid(v)) throw new TeamError('INVALID_INPUT',400); return v.toLowerCase(); }
