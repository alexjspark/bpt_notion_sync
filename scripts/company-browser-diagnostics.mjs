const approvedFragments = [
  'No usable sandbox',
  'Failed to move to new namespace',
  'Operation not permitted',
  'chrome_crashpad_handler',
  'profile appears to be in use',
  'Failed to create a ProcessSingleton',
  'SingletonLock',
];

/** Return constant allowlisted fragments only, never paths, URLs, or raw stderr. */
export function classifyBrowserStartupFailure(stderr) {
  return approvedFragments.filter(fragment => typeof stderr === 'string' && stderr.includes(fragment));
}
