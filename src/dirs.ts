import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Where flows, reports, artifacts, sessions and config.json live. */
export const FLOW_DIR = () => path.resolve(process.env.FASTQA_DIR || path.join(process.cwd(), '.fastqa'));
/** File-system safe name: no separators, no traversal. */
export const safe = (n: string) => n.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'unnamed';
/** Path relative to the fastqa dir with forward slashes, for use inside artifacts (never absolute). */
export const rel = (file: string) => path.relative(FLOW_DIR(), file).split(path.sep).join('/');

/** Write to a temp file in the same directory, then rename: readers never see a half-written file. */
export async function writeAtomic(file: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  try { await fs.rename(tmp, file); }
  catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}

/** Resolve a user-supplied relative path inside the fastqa dir (or the project dir). Rejects traversal and absolute escapes. */
export function inside(base: string, p: string): string {
  const full = path.resolve(base, p);
  const relp = path.relative(base, full);
  if (relp.startsWith('..') || path.isAbsolute(relp)) throw new Error(`Path "${p}" is outside ${base}`);
  return full;
}
