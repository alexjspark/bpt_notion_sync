import { readFileSync } from 'node:fs';
try {
  const bootstrap = JSON.parse(readFileSync('/run/company-login/bootstrap.json', 'utf8'));
  if (typeof bootstrap.url !== 'string' || Date.now() > bootstrap.expiresAt) throw new Error();
  process.stdout.write(`${bootstrap.url}\n`);
} catch {
  console.error('COMPANY_LOGIN_URL_UNAVAILABLE_OR_ALREADY_USED');
  process.exitCode = 1;
}
