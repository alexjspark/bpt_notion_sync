/** The browser can request a preview, but cannot select a tenant or grant access. */
export function parseManualSyncRequest(value: unknown): { action: 'preview' } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MANUAL_SYNC_INVALID_REQUEST');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'action') || body.action !== 'preview') {
    throw new Error('MANUAL_SYNC_INVALID_REQUEST');
  }
  return { action: 'preview' };
}
