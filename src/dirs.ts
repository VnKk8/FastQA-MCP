import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Where flows, reports, artifacts, sessions and config.json live. */
export const FLOW_DIR = () => path.resolve(process.env.FASTQA_DIR || path.join(process.cwd(), '.fastqa'));
/** File-system safe name: no separators, no traversal. */
export const safe = (n: string) => n.replace(/[^\w.-]+/g, '-').slice(0, 80);
/** Path relative to the fastqa dir with forward slashes, for use inside artifacts (never absolute). */
export const rel = (file: string) => path.relative(FLOW_DIR(), file).split(path.sep).join('/');

/** Write to a temp file in the same directory, then rename: readers never see a half-written file. */
export async function writeAtomic(file: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  // On Windows a rename onto a file that another process is replacing at the same moment fails with EPERM/EBUSY.
  // Retry briefly, bounded; the last writer wins and the target is always a complete file.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(tmp, file); return; }
    catch (e: any) {
      if (attempt < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { await new Promise((r) => setTimeout(r, 15 + attempt * 10)); continue; }
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
}

/**
 * Failure screenshots are bounded: keeps the newest `max` files that fastqa wrote into artifacts/ (fail-<time>.jpg and
 * <flow>-<run id or time>.jpg). Anything else in that directory is never touched.
 */
export async function pruneScreenshots(max: number): Promise<void> {
  const dir = path.join(FLOW_DIR(), 'artifacts');
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^(fail-\d+|.+-(\d{8}T\d{6}Z-[0-9a-f]{8}|\d{13}))\.jpg$/.test(n));
  if (names.length <= max) return;
  const files: Array<{ n: string; t: number }> = [];
  for (const n of names) { const st = await fs.lstat(path.join(dir, n)).catch(() => undefined); if (st?.isFile()) files.push({ n, t: st.mtimeMs }); }
  files.sort((a, b) => b.t - a.t);
  for (const f of files.slice(max)) await fs.rm(path.join(dir, f.n), { force: true }).catch(() => {});
}

/** Resolve a user-supplied relative path inside the fastqa dir (or the project dir). Rejects traversal and absolute escapes. */
export function inside(base: string, p: string): string {
  const full = path.resolve(base, p);
  const relp = path.relative(base, full);
  if (relp.startsWith('..') || path.isAbsolute(relp)) throw new Error(`Path "${p}" is outside ${base}`);
  return full;
}
