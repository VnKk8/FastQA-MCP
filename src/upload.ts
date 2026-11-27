import { promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLOW_DIR } from './dirs.js';

/** Largest file an upload step makes. Bigger files: put a real one in the files folder. */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export type UploadPart =
  | { folder: string }
  | { name: string; buffer: Buffer; kind: 'made' | 'cut' | 'empty' | 'filler'; format: string };

/**
 * Reads an upload value and makes the files it names.
 *   ""                 no files: clears the selection
 *   "a.png|b.pdf"      several files
 *   "files/<path>"     your own file from the files folder, returned as { folder } for the caller to find
 *   "<name>[:<size>]"  a made file: a valid file of the type its extension names, padded to <size> inside its own
 *                      structure (a PNG text chunk, JPEG and GIF comments, a WebP chunk, a PDF stream), so it stays valid.
 *                      Sizes: 512, 0B, 300KB, 1.5MB (KB = 1024 bytes). Other extensions get filler bytes (1 KB).
 * Self-contained (no imports, no outer names): exported specs embed its source, so a spec uploads byte for byte the
 * files that fastqa replay uploads.
 */
export function uploadFiles(value: string, maxBytes: number): UploadPart[] {
  const q = JSON.stringify;
  const ascii = (s: string) => Buffer.from(s, 'latin1');
  const fill = (n: number) => (n > 0 ? Buffer.alloc(n, 'fastqa ') : Buffer.alloc(0));
  const u32 = (n: number, le = false) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  const T: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = (b: Buffer) => { let c = ~0; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const b64 = (s: string) => Buffer.from(s, 'base64');

  // 1x1 images; JPEG and WebP come from Chromium's own encoder, without the colour profile
  const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
  const JPG = b64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAD//Z');
  const GIF = b64('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==');
  const WEBP = b64('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=');

  // Each format: its smallest valid file, and how to grow it by r bytes while it stays valid. Where r is too small for
  // the format's padding structure, the few bytes go after the file's end, which decoders ignore.
  const png = (r: number) => {
    if (r < 20) return Buffer.concat([PNG, fill(r)]);
    const td = Buffer.concat([ascii('tEXtComment\0'), fill(r - 20)]);
    return Buffer.concat([PNG.subarray(0, PNG.length - 12), u32(td.length - 4), td, u32(crc(td)), PNG.subarray(PNG.length - 12)]);
  };
  const jpg = (r: number) => {
    const segs: Buffer[] = [];
    while (r >= 4) { // comment segments of at most 65537 bytes; never leave 1 to 3 bytes over
      let n = Math.min(r, 65537); if (r - n > 0 && r - n < 4) n = r - 4;
      segs.push(Buffer.from([0xff, 0xfe, (n - 2) >> 8, (n - 2) & 255]), fill(n - 4)); r -= n;
    }
    // after the JFIF segment: type checks look for FF D8 FF E0 and "JFIF" at offset 6
    const app0 = 4 + JPG.readUInt16BE(4);
    return Buffer.concat([JPG.subarray(0, app0), ...segs, JPG.subarray(app0), fill(r)]);
  };
  const gif = (r: number) => {
    if (r < 3 || r === 4) return Buffer.concat([GIF, fill(r)]);
    // comment extension: sub-blocks of 1..255 bytes, each after its size byte, written into one buffer
    const p = r - 3; const blocks = fill(p);
    for (let i = 0, left = p; left > 0;) { let n = Math.min(left, 256); if (left - n === 1) n -= 1; blocks[i] = n - 1; i += n; left -= n; }
    return Buffer.concat([GIF.subarray(0, GIF.length - 1), Buffer.from([0x21, 0xfe]), blocks, Buffer.from([0]), GIF.subarray(GIF.length - 1)]);
  };
  const webp = (r: number) => {
    // extra chunks belong in the extended format: a VP8X header (no features, 1x1 canvas), the image, a padding chunk
    if (r < 26) return Buffer.concat([WEBP, fill(r)]);
    const d = (r - 26) & ~1; // RIFF chunks have even sizes: an odd r leaves one byte after the RIFF
    const body = Buffer.concat([ascii('WEBP'), ascii('VP8X'), u32(10, true), Buffer.alloc(10), WEBP.subarray(12), ascii('FQPD'), u32(d, true), fill(d)]);
    return Buffer.concat([ascii('RIFF'), u32(body.length, true), body, fill(r - 26 - d)]);
  };
  const pdfParts = (n: number, sp: number) => { // n < 0: no padding stream; sp: spaces in the trailer (shift no offset)
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
    let head = '%PDF-1.4\n'; const offs: number[] = [];
    for (let i = 0; i < objs.length; i++) { offs.push(head.length); head += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`; }
    const open = n < 0 ? '' : `4 0 obj\n<< /Length ${n} >>\nstream\n`; const close = n < 0 ? '' : '\nendstream\nendobj\n';
    if (n >= 0) offs.push(head.length);
    const xref = `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
      + `trailer\n<< /Size ${offs.length + 1} /Root 1 0 R${' '.repeat(sp)} >>\nstartxref\n${head.length + open.length + Math.max(n, 0) + close.length}\n%%EOF\n`;
    return { head, open, close, xref, length: head.length + open.length + Math.max(n, 0) + close.length + xref.length };
  };
  const pdfOf = (n: number, sp: number) => { const p = pdfParts(n, sp); return Buffer.concat([ascii(p.head + p.open), fill(Math.max(n, 0)), ascii(p.close + p.xref)]); };
  const PDF = pdfOf(-1, 0);
  const pdf = (r: number) => {
    if (r < 100) return pdfOf(-1, r);
    const size = PDF.length + r;
    let n = r - (pdfParts(0, 0).length - PDF.length);
    while (pdfParts(n, 0).length > size) n--; // the Length and offset digits grow with n
    return pdfOf(n, size - pdfParts(n, 0).length);
  };
  const markup = (head: string, tail: string) => {
    const base = ascii(head + tail);
    return { base, grow: (r: number) => Buffer.concat([ascii(head), r >= 7 ? Buffer.concat([ascii('<!--'), fill(r - 7), ascii('-->')]) : ascii(' '.repeat(r)), ascii(tail)]) };
  };
  const plain = (head: string, tail: string) => ({ base: ascii(head + tail), grow: (r: number) => Buffer.concat([ascii(head), fill(r), ascii(tail)]) });
  const formats: Record<string, { base: Buffer; grow: (r: number) => Buffer }> = {
    png: { base: PNG, grow: png }, jpg: { base: JPG, grow: jpg }, jpeg: { base: JPG, grow: jpg }, jfif: { base: JPG, grow: jpg },
    gif: { base: GIF, grow: gif }, webp: { base: WEBP, grow: webp }, pdf: { base: PDF, grow: pdf },
    txt: plain('fastqa test file\n', ''), md: plain('# fastqa test file\n', ''), csv: plain('id,note\n1,', '\n'), json: plain('{"fastqa":"', '"}'),
    svg: markup('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">', '</svg>\n'),
    xml: markup('<?xml version="1.0"?>\n<fastqa>', '</fastqa>\n'),
    html: markup('<!doctype html>\n<title>fastqa test file</title>\n', ''), htm: markup('<!doctype html>\n<title>fastqa test file</title>\n', ''),
  };
  // unknown types: filler bytes, behind the magic number that content checks look for
  const MAGIC: Record<string, string> = { exe: 'MZ', dll: 'MZ', zip: 'PK\x03\x04', docx: 'PK\x03\x04', xlsx: 'PK\x03\x04', pptx: 'PK\x03\x04', odt: 'PK\x03\x04', ods: 'PK\x03\x04', jar: 'PK\x03\x04', apk: 'PK\x03\x04' };

  const notName = (piece: string) => new Error(`${q(piece)} is not a file name. Made files take a plain name such as "photo.png" or "big.jpg:6MB"; your own files are written files/<name> and come from the files folder`);
  const out: UploadPart[] = [];
  for (const raw of value.split('|')) {
    const piece = raw.trim();
    if (!piece) continue;
    const own = /^files[\\/]([^]*)$/.exec(piece);
    if (own) {
      const segs = own[1].split(/[\\/]/);
      if (!own[1] || segs.some((x) => !x || x === '.' || x === '..' || x.includes(':'))) throw new Error(`${q(piece)} points outside the files folder`);
      out.push({ folder: segs.join('/') });
      continue;
    }
    if (/[\\/]/.test(piece)) throw notName(piece);
    const at = piece.lastIndexOf(':');
    const name = (at >= 0 ? piece.slice(0, at) : piece).trim();
    if (!name || name.length > 255 || name === '.' || name === '..' || /[:\u0000-\u001f]/.test(name)) throw notName(piece);
    let bytes: number | undefined;
    if (at >= 0) {
      const sizeText = piece.slice(at + 1).trim();
      const m = /^(\d+(?:\.\d+)?)\s*(b|kb?|mb?|gb?)?$/i.exec(sizeText);
      if (!m) throw new Error(`${q(piece)} has an unknown size ${q(sizeText)}. Use bytes or B, KB, MB, GB, e.g. "big.jpg:6MB" (KB = 1024 bytes)`);
      const unit = (m[2] || 'b').toLowerCase()[0];
      bytes = Math.round(Number(m[1]) * (unit === 'k' ? 1024 : unit === 'm' ? 1048576 : unit === 'g' ? 1073741824 : 1));
      if (bytes > maxBytes) throw new Error(`${q(piece)} is larger than the ${maxBytes / 1048576} MB limit for made files. Put a real file in the files folder and use files/<name>`);
    }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const f = formats[ext];
    const format = ext.toUpperCase() || 'file';
    if (f) {
      const size = bytes ?? f.base.length;
      if (size === 0) out.push({ name, buffer: Buffer.alloc(0), kind: 'empty', format });
      else if (size < f.base.length) out.push({ name, buffer: Buffer.from(f.base.subarray(0, size)), kind: 'cut', format });
      else out.push({ name, buffer: size === f.base.length ? Buffer.from(f.base) : f.grow(size - f.base.length), kind: 'made', format });
    } else {
      const size = bytes ?? 1024;
      const magic = ascii(MAGIC[ext] ?? '');
      out.push({ name, buffer: Buffer.from(Buffer.concat([magic, fill(size)]).subarray(0, size)), kind: size ? 'filler' : 'empty', format });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ runtime

/** Folders of made files, removed when their browser context closes, and at the latest when the process exits. */
const madeDirs = new Set<string>();
let exitHook = false;

/** A new folder for the files of one upload step. */
export async function madeDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(tmpdir(), 'fastqa-upload-'));
  madeDirs.add(d);
  if (!exitHook) { exitHook = true; process.once('exit', () => { for (const x of madeDirs) try { rmSync(x, { recursive: true, force: true }); } catch { /* still in use */ } }); }
  return d;
}

/** Removes folders of made files. Called when the browser context that may still read them has closed. */
export async function removeMadeDirs(dirs: string[]): Promise<void> {
  for (const d of dirs) {
    try { await fs.rm(d, { recursive: true, force: true }); madeDirs.delete(d); } catch { /* still in use: the exit hook tries again */ }
  }
}

export interface UploadFile { path: string; name: string; detail: string; bytes: number }

/** Where the files folder is, said the way a person finds it: relative to the working directory when inside it. */
export function filesFolder(): { dir: string; shown: string } {
  const dir = path.join(FLOW_DIR(), 'files');
  const r = path.relative(process.cwd(), dir);
  return { dir, shown: r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : dir };
}

const sizeText = (n: number) => `${n} bytes${n >= 1024 ? ` = ${+(n / (n >= 1048576 ? 1048576 : 1024)).toFixed(1)} ${n >= 1048576 ? 'MB' : 'KB'}` : ''}`;

/**
 * The files of an upload value, on disk for the browser: made files are written to `dir` (the browser reads a chosen
 * file only when the page uses it, so the folder must outlive the step), your own files are checked to be inside the
 * files folder, also after following links.
 */
export async function prepareUpload(value: string, dir: () => Promise<string>): Promise<UploadFile[]> {
  const parts = uploadFiles(value, UPLOAD_MAX_BYTES);
  const { dir: folder, shown } = filesFolder();
  const files: UploadFile[] = [];
  let made: string | undefined;
  for (const [i, p] of parts.entries()) {
    if ('folder' in p) {
      const full = path.join(folder, ...p.folder.split('/'));
      let real: string;
      try { real = await fs.realpath(full); } catch { throw new Error(`no file ${JSON.stringify(p.folder)} in ${shown}`); }
      const root = await fs.realpath(folder).catch(() => folder);
      const r = path.relative(root, real);
      if (!r || r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) throw new Error(`files/${p.folder} points outside the files folder (${shown})`);
      const st = await fs.stat(real);
      if (!st.isFile()) throw new Error(`files/${p.folder} is not a file`);
      files.push({ path: real, name: path.basename(real), detail: `${sizeText(st.size)}, your file`, bytes: st.size });
    } else {
      made ??= await dir();
      const sub = path.join(made, String(i));
      await fs.mkdir(sub, { recursive: true });
      const file = path.join(sub, p.name);
      try { await fs.writeFile(file, p.buffer); } catch { throw new Error(`${JSON.stringify(p.name)} cannot be a file name on this system`); }
      const kind = p.kind === 'cut' ? `cut: not a valid ${p.format}` : p.kind === 'filler' ? 'filler bytes' : p.kind;
      files.push({ path: file, name: p.name, detail: `${sizeText(p.buffer.length)}, ${kind}`, bytes: p.buffer.length });
    }
  }
  return files;
}

/** Playwright refuses more than this in bytes sent to the browser; paths have no such limit. */
export const BYTES_LIMIT = 45 * 1024 * 1024;

/**
 * Whether the files must go to the browser as bytes instead of paths. Chromium on Windows cannot open a path of 260
 * characters or more (a long file name in the temporary folder), and a browser on another machine (FASTQA_CDP_URL)
 * cannot read this disk: in both cases it would get an empty file while the step looked fine.
 */
export function sendAsBytes(paths: string[], o: { platform: string; cdpUrl?: string }): boolean {
  if (o.platform === 'win32' && paths.some((p) => p.length >= 260)) return true;
  if (!o.cdpUrl) return false;
  let host = '';
  try { host = new URL(o.cdpUrl).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return !['localhost', '127.0.0.1', '::1'].includes(host);
}

/** The files as bytes for setInputFiles, with the type a browser gives them. Only within BYTES_LIMIT in total. */
export async function asBytes(files: UploadFile[]): Promise<Array<{ name: string; mimeType: string; buffer: Buffer }>> {
  const total = files.reduce((a, f) => a + f.bytes, 0);
  if (total > BYTES_LIMIT) {
    throw new Error(`these files (${sizeText(total)}) cannot reach the browser: it cannot open their paths (a name too long for Windows, or a browser on another machine), and more than 45 MB cannot be sent as bytes. Use shorter names or smaller files`);
  }
  return Promise.all(files.map(async (f) => ({ name: f.name, mimeType: mimeOf(f.name), buffer: await fs.readFile(f.path) })));
}

/** The type a browser gives a file of this name; '' when it would not know. */
export function mimeOf(name: string): string {
  return name.includes('.') ? MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '' : '';
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', md: 'text/markdown',
  zip: 'application/zip', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
};

/** Whether a file name passes an input's accept attribute, the way a file picker filters ("image/*", ".pdf", "text/csv"). */
export function accepts(accept: string, name: string): boolean {
  const tokens = accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  const mime = MIME[ext.slice(1)] ?? '';
  return tokens.some((t) => (t.startsWith('.') ? t === ext : t.endsWith('/*') ? !!mime && mime.startsWith(t.slice(0, -1)) : t === mime));
}
