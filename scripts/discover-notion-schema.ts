import{parseLiveReadOnlyConfig}from'../packages/engine/src/live-runtime.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNotionSchema, notionSchemaDiscoveryReport } from './notion-schema-discovery.ts';
import type { NotionSchemaDependencies } from './notion-schema-discovery.ts';

export interface NotionSchemaCommandDependencies extends NotionSchemaDependencies {
  writeCandidate?(name: string, contents: string): Promise<void>;
}
import { isLocalReviewName as candidateNameAllowed, persistLocalReviewFile } from './local-review-file.ts';
export const persistNotionSchemaCandidate = persistLocalReviewFile;

/** stdout is a fixed diagnostic report. Optional candidate metadata stays under local-config/. */
export async function runNotionSchemaDiscoveryCommand(args: string[], env: Record<string, string | undefined>, dependencies: NotionSchemaCommandDependencies) {
  const candidateName = env.NOTION_SCHEMA_CANDIDATE_NAME;
  const invalid = args.length > 0 || (candidateName !== undefined && (!candidateNameAllowed(candidateName) || !dependencies.writeCandidate));
  let destination=dependencies.destination;
  if(!invalid&&!destination){try{if(!env.LIVE_READONLY_CONFIG_FILE)throw Error('CONFIG_REQUIRED');const config=parseLiveReadOnlyConfig(JSON.parse(await dependencies.readText(env.LIVE_READONLY_CONFIG_FILE)));if(!config.notion)throw Error('CONFIG_REQUIRED');destination=config.notion.members;}catch{/* fixed invalid_configuration report below */}}
  let result = invalid||!destination ? { report: notionSchemaDiscoveryReport('invalid_configuration') }
    : await discoverNotionSchema({ tokenFile: env.NOTION_TOKEN_FILE ?? '/run/secrets/notion_token',destination }, dependencies);
  if (candidateName !== undefined && 'candidate' in result && result.candidate) {
    try {
      await dependencies.writeCandidate!(candidateName, JSON.stringify({ version: 1, report: result.report, candidate: result.candidate }, null, 2) + '\n');
    } catch {
      result = { report: notionSchemaDiscoveryReport('needs_review') };
    }
  }
  return { exitCode: result.report.status === 'candidate_ready' ? 0 as const : 1 as const,
    output: JSON.stringify(result.report) + '\n', ...('candidate' in result && result.candidate ? { candidate: result.candidate } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runNotionSchemaDiscoveryCommand(process.argv.slice(2), process.env, {
      readText: path => readFile(path, 'utf8'),
      writeCandidate: (name, contents) => persistNotionSchemaCandidate(name, contents),
      transport: async request => {
        const response = await fetch(request.url, { method: request.method, headers: request.headers,
          redirect: 'error', signal: AbortSignal.timeout(15000) });
        return { status: response.status, body: await response.json() };
      },
    });
    process.stdout.write(result.output); process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(JSON.stringify(notionSchemaDiscoveryReport('needs_review')) + '\n'); process.exitCode = 1;
  }
}
