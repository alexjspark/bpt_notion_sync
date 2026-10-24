import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNotionPartialPreview } from './notion-partial-preview.ts';
import { isLocalReviewName, persistLocalReviewFile } from './local-review-file.ts';
import { notionReadReviewCode } from '../packages/engine/src/live-runtime.ts';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportName = process.env.NOTION_PARTIAL_REPORT_NAME;
  try {
    if (process.argv.length !== 2 || !reportName || !isLocalReviewName(reportName) || !process.env.COMPANY_UI_SNAPSHOT_FILE) throw new Error('PARTIAL_CONFIG_INVALID');
    const result = await runNotionPartialPreview({
      configFile:process.env.LIVE_READONLY_CONFIG_FILE ?? '/run/config/live-readonly.json',
      tokenFile:process.env.NOTION_TOKEN_FILE ?? '/run/secrets/notion_token', companySnapshotFile:process.env.COMPANY_UI_SNAPSHOT_FILE,
    }, { readText:path=>readFile(path,'utf8'), transport:async request=>{
      const response = await fetch(request.url,{method:request.method,headers:request.headers,redirect:'error',signal:AbortSignal.timeout(15000),
        ...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});
      return {status:response.status,body:await response.json()};
    } });
    await persistLocalReviewFile(reportName,JSON.stringify(result.detail,null,2)+'\n');
    process.stdout.write(JSON.stringify(result.report)+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({mode:'partial_dry_run',status:'needs_verification',reason:notionReadReviewCode(error),externalWritesEnabled:false,automaticSyncEnabled:false})+'\n');
    process.exitCode=1;
  }
}