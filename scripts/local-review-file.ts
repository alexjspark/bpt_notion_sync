import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const isLocalReviewName = (name: string) => name.length <= 80
  && /^[a-z0-9][a-z0-9._-]*\.json$/.test(name)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0]!);
const localDirectory = fileURLToPath(new URL('../local-config/', import.meta.url));
/** Local human-readable review artifacts only; no overwrite, activation or credential discovery. */
export async function persistLocalReviewFile(name: string, contents: string, directory = localDirectory) {
  if (!isLocalReviewName(name)) throw new Error('REVIEW_DESTINATION_REJECTED');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('REVIEW_DESTINATION_REJECTED');
  await writeFile(join(directory, name), contents, { encoding: 'utf8', flag: 'wx' });
}