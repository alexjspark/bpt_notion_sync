import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeArgs = ['compose', '-p', 'trainer-sync-local', '-f', join(projectRoot, 'compose.yaml')];
const [backupArgument, requestedDatabase = 'trainer_sync_restore_test', ...extraArguments] = process.argv.slice(2);
let backupFd;
let databaseCreated = false;

function runPostgres(command, args, options = {}) {
  const result = spawnSync('docker', [...composeArgs, 'exec', '-T', 'postgres', command, ...args], {
    cwd: projectRoot, windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'], ...options,
  });
  if (result.error) throw new Error(`Could not run Docker: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? result.signal ?? 'unknown'}).`);
  return result;
}

try {
  if (!backupArgument || extraArguments.length > 0) {
    throw new Error('Usage: node scripts/restore.mjs <backup.dump> [trainer_sync_restore_test]');
  }
  // Deliberately allow only the disposable verification DB, never the application DB.
  if (!/^trainer_sync_restore_test$/.test(requestedDatabase)) {
    throw new Error('Restore target must be exactly trainer_sync_restore_test. The application database cannot be a target.');
  }
  const backupPath = resolve(projectRoot, backupArgument);
  if (extname(backupPath).toLowerCase() !== '.dump' || !statSync(backupPath).isFile()) {
    throw new Error('Input must be an existing PostgreSQL custom-format .dump file.');
  }
  backupFd = openSync(backupPath, 'r');
  const signature = Buffer.alloc(5);
  // A positional read leaves the descriptor at offset zero for pg_restore stdin.
  if (readSync(backupFd, signature, 0, signature.length, 0) !== 5 || signature.toString('ascii') !== 'PGDMP') {
    throw new Error('Input is not a PostgreSQL custom-format dump (PGDMP header missing).');
  }

  const existing = runPostgres('psql', [
    '--no-password', '-U', 'trainer', '-d', 'postgres', '-X', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1', '-c', `SELECT 1 FROM pg_database WHERE datname = '${requestedDatabase}';`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  if (existing.stdout.trim() !== '') {
    throw new Error(`Target ${requestedDatabase} already exists. Nothing was deleted or overwritten.`);
  }

  // createdb also rejects a concurrent creation of the same name; there is no DROP path.
  runPostgres('createdb', [
    '--no-password', '-U', 'trainer', '--maintenance-db=postgres', '--template=template0', requestedDatabase,
  ]);
  databaseCreated = true;
  runPostgres('pg_restore', [
    '--no-password', '-U', 'trainer', '-d', requestedDatabase,
    '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
  ], { stdio: [backupFd, 'inherit', 'inherit'] });

  console.log(`Restore complete into verification database only: ${requestedDatabase}`);
  console.log('The application database trainer_sync was not a restore target.');
  console.log('Verify schema, tenant boundaries, member/schedule/job counts and manual exceptions before relying on this backup.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Restore failed.');
  if (databaseCreated) {
    console.error(`Verification database ${requestedDatabase} is preserved for inspection. No database was dropped.`);
  }
  process.exitCode = 1;
} finally {
  if (backupFd !== undefined) {
    try { closeSync(backupFd); } catch { /* Do not obscure restore status. */ }
  }
}
