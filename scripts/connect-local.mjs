import { join } from 'node:path';
import { writeSync } from 'node:fs';
import { createConnectionInputServer } from './connect-local-server.mjs';
import { preparePrivateSecretWriter } from './connect-local-storage.mjs';

try {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WINDOWS_PRIVATE_LOCATION_REQUIRED');
  if (process.argv.length !== 2) throw new Error('UNEXPECTED_ARGUMENTS');
  const privateDirectory = join(process.env.LOCALAPPDATA, 'TrainerSync', 'private', 'trainer-live-one');
  const writer = await preparePrivateSecretWriter({ privateDirectory });
  const input = createConnectionInputServer({
    persist: writer.persist,
    onStorageStarted() { writeSync(1, 'CONNECTION_STORAGE_STARTED; no repeat submission.\n'); },
    onSaved() { writeSync(1, 'PRIVATE_CONNECTION_FILES_SAVED; external writes remain disabled.\n'); },
    onStorageFailure() { writeSync(2, 'CONNECTION_STORAGE_RESULT_REQUIRES_INSPECTION; do not repeat setup.\n'); process.exitCode = 1; },
  });
  const { url } = await input.listen();
  process.stdout.write(`Connection key input (localhost only): ${url}\n`);
  const expiry = setTimeout(() => {
    writeSync(1, input.state === 'saving' ? 'INPUT_WINDOW_CLOSED_DURING_STORAGE; awaiting outcome.\n' : 'INPUT_WINDOW_EXPIRED; no automatic restart.\n');
    void input.stop();
  }, 30 * 60 * 1000);
  expiry.unref();
  input.server.once('close', () => clearTimeout(expiry));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    writeSync(1, 'INPUT_STOP_REQUESTED; active storage is allowed to finish.\n');
    void input.stop();
  });
} catch (error) {
  // Do not print exception messages, command output, paths from errors, or request bodies.
  const allowed = new Set(['WINDOWS_PRIVATE_LOCATION_REQUIRED', 'UNEXPECTED_ARGUMENTS', 'PRIVATE_PATH_ACL_REQUIRED', 'PRIVATE_PATH_CHECK_FAILED', 'EXISTING_SECRET_PRESERVED', 'LINKED_PRIVATE_PATH_DENIED']);
  process.stderr.write(`CONNECTION_SETUP_STOPPED: ${allowed.has(error?.message) ? error.message : 'PRIVATE_SETUP_FAILED'}\n`);
  process.exitCode = 1;
}
