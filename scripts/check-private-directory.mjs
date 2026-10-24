import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyWindowsPrivatePath } from './connect-local-storage.mjs';

try {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || process.argv.length !== 2) throw new Error('PRIVATE_CHECK_UNAVAILABLE');
  const root = join(process.env.LOCALAPPDATA, 'TrainerSync', 'private');
  await verifyWindowsPrivatePath(root);
  const trainerDirectory = join(root, 'trainer-live-one');
  try {
    const metadata = await lstat(trainerDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('PRIVATE_CHECK_FAILED');
    await verifyWindowsPrivatePath(trainerDirectory);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('PRIVATE_DIRECTORY_VERIFIED; no key was read, created or collected.');
} catch {
  console.error('PRIVATE_DIRECTORY_NOT_VERIFIED; do not enter a key.');
  process.exitCode = 1;
}
