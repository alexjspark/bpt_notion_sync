import { spawn } from 'node:child_process';
import { migrate, seed, closeDb } from '@trainer/db';
if (process.env.APP_MODE !== 'mock' || process.env.EXTERNAL_CONNECTIONS_ENABLED !== 'false') throw new Error('This local build permits mock mode with external connections disabled only.');
await migrate();
if (process.env.SEED_SYNTHETIC_DATA === 'true') await seed();
await closeDb();
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '0.0.0.0', '--port', process.env.PORT || '3000'], {stdio:'inherit'});
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal, () => server.kill(signal));
server.on('exit', code => process.exit(code ?? 1));
