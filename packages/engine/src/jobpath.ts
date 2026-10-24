// What a buyer may ship to a provider. The whole directory goes to someone else's machine,
// so refuse the places where keys and wallets live.
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { EngineError, badRequest } from './errors.ts';

/** Relative to $HOME: never ship these, or anything that contains them. */
export const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', join('.config', 'gcloud')];
/** Silicr / sidecar secret files: a bundle containing one would hand a provider a wallet or identity. */
const SECRET_FILES = new Set(['master.seed', 'identity.key', 'wallet.seed']);
const MAX_ENTRIES = 200_000;

function refuse(path: string, why: string): never {
  throw new EngineError('privacy', `refusing to send ${path} to a provider: ${why}`, 400);
}

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Resolve job.path (following symlinks) and refuse anything that would leak secrets:
 * the filesystem root, $HOME itself, anything inside or containing ~/.ssh, ~/.gnupg, ~/.aws
 * or ~/.config/gcloud, and any tree containing a .silicr dir or a Silicr secret file.
 * Returns the real path to pack.
 */
export async function checkJobPath(path: string, home: string = homedir()): Promise<string> {
  const abs = resolve(path);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw badRequest(`job.path is not a directory: ${abs}`);
  }
  if (!(await stat(real)).isDirectory()) throw badRequest(`job.path is not a directory: ${abs}`);
  const homes = new Set([resolve(home), await realpath(home).catch(() => resolve(home))]);
  if (real === sep || /^[A-Za-z]:\\?$/.test(real)) refuse(abs, 'that is the whole filesystem');
  if (homes.has(real)) refuse(abs, 'that is your whole home directory');
  for (const h of homes) {
    for (const rel of SENSITIVE_HOME_DIRS) {
      const plain = join(h, rel);
      for (const d of new Set([plain, await realpath(plain).catch(() => plain)])) {
        if (within(real, d)) refuse(abs, `it is inside ~/${rel}`);
        if (within(d, real)) refuse(abs, `it contains ~/${rel}`);
      }
    }
  }
  // Walk the tree (symlinks are not followed; the bundler refuses them anyway).
  const todo = [real];
  let seen = 0;
  while (todo.length) {
    const dir = todo.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) throw badRequest(`job.path has more than ${MAX_ENTRIES} entries; ship a smaller directory`);
      const p = join(dir, e.name);
      if (e.name === '.silicr') refuse(abs, `it contains ${relative(real, p)}, a Silicr data dir (wallet seeds and keys)`);
      if (e.isFile() && SECRET_FILES.has(e.name)) refuse(abs, `it contains ${relative(real, p)}, a wallet or identity secret`);
      if (e.isDirectory()) todo.push(p);
    }
  }
  return real;
}
