import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeArgs = ['compose', '-p', 'trainer-sync-local', '-f', join(projectRoot, 'compose.yaml')];
let dumpFd;
let dumpPath;
let ownsDump = false;

try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/backup.mjs');
  const backupDirectory = join(projectRoot, 'backups');
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  dumpPath = join(backupDirectory, `${timestamp}.dump`);
  dumpFd = openSync(dumpPath, 'wx', 0o600);
  ownsDump = true;

  // Pass an OS file descriptor directly: never decode a custom-format dump as text.
  const result = spawnSync('docker', [
    ...composeArgs, 'exec', '-T', 'postgres',
    'pg_dump', '--no-password', '-U', 'trainer', '-d', 'trainer_sync', '-Fc',
  ], { cwd: projectRoot, stdio: ['ignore', dumpFd, 'inherit'], windowsHide: true, shell: false });
  if (result.error) throw new Error(`Could not run Docker: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pg_dump failed (exit ${result.status ?? result.signal ?? 'unknown'}).`);

  fsyncSync(dumpFd);
  closeSync(dumpFd);
  dumpFd = undefined;
  console.log(`Backup complete: ${dumpPath}`);
  console.log('This file is not a verified backup until a separate restore check succeeds.');
} catch (error) {
  if (dumpFd !== undefined) {
    try { closeSync(dumpFd); } catch { /* Preserve the original failure. */ }
  }
  console.error(error instanceof Error ? error.message : 'Backup failed.');
  if (ownsDump && dumpPath) {
    const incompletePath = `${dumpPath}.partial`;
    try {
      if (existsSync(incompletePath)) throw new Error('Partial path already exists.');
      renameSync(dumpPath, incompletePath);
      console.error(`Incomplete output preserved; do not restore it: ${incompletePath}`);
    } catch {
      console.error(`Output may be incomplete; do not restore it: ${dumpPath}`);
    }
  }
  process.exitCode = 1;
}
