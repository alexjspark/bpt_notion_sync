import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNotionReadOnly, notionReadOnlyReport } from './notion-readonly-check.ts';
import type { NotionReadOnlyDependencies } from './notion-readonly-check.ts';

/** The environment contains file locations only; token values are never CLI arguments or output. */
export async function runNotionReadOnlyCommand(args: string[], env: Record<string, string | undefined>, dependencies: NotionReadOnlyDependencies) {
  const report = args.length ? notionReadOnlyReport('invalid_configuration') : await checkNotionReadOnly({
    configFile: env.LIVE_READONLY_CONFIG_FILE ?? '/run/config/live-readonly.json',
    tokenFile: env.NOTION_TOKEN_FILE ?? '/run/secrets/notion_token',
  }, dependencies);
  return { exitCode: report.status === 'passed' ? 0 as const : 1 as const, output: `${JSON.stringify(report)}\n` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runNotionReadOnlyCommand(process.argv.slice(2), process.env, {
      onReview: code => {
        if (process.env.NOTION_READONLY_DIAGNOSTICS === '1') process.stderr.write(JSON.stringify({ mode: 'notion_readonly_diagnostic', reason: code }) + '\n');
      },
      readText: path => readFile(path, 'utf8'),
      transport: async request => {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, redirect: 'error',
          signal: AbortSignal.timeout(15000), ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        return { status: response.status, headers: { 'retry-after': response.headers.get('retry-after') ?? undefined }, body: await response.json() };
      },
    });
    process.stdout.write(result.output); process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify(notionReadOnlyReport('needs_verification'))}\n`); process.exitCode = 1;
  }
}
