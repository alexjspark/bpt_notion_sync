import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const suite = process.argv[2];
function walk(dir) { return readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() && e.name !== 'node_modules' ? walk(join(dir,e.name)) : e.isFile() ? [join(dir,e.name)] : []); }
const files = [...walk('packages'), ...walk('apps/web/test'), ...walk('tests')].filter(f => /\.test\.ts$/.test(f)).filter(f => suite === 'integration' ? /integration/.test(f) : !/integration/.test(f));
if (!files.length) throw new Error(`No ${suite} tests found`);
if (suite === 'integration' && !process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Use npm run check:docker for an isolated PostgreSQL test database.');
const result = spawnSync(process.execPath, ['--import','tsx','--test', '--test-concurrency=1', ...files], {stdio:'inherit', env: process.env});
process.exit(result.status ?? 1);
