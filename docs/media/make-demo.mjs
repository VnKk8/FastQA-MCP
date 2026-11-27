// Renders docs/media/demo.html frame by frame and writes docs/media/fastqa-demo.gif (the README animation).
// Run from the project folder: node docs/media/make-demo.mjs [--fps=12.5] [--png=<folder> to also save a few frames]
// Needs only what the project already has: Playwright and its bundled PNG decoder. The GIF encoder is below:
// one global 256-colour palette, LZW, and frames that store only the pixels that changed (the rest transparent).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));
const here = path.dirname(fileURLToPath(import.meta.url));
const W = 960, H = 540;
const STEP = Math.round(1000 / Number(args.fps || 12.5)); // ms per frame; GIF delays are in 1/100 s
const out = path.join(here, 'fastqa-demo.gif');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'demo.html')).href);
await page.evaluate(() => document.fonts.ready);
const TOTAL = await page.evaluate(() => window.TOTAL);
const times = []; for (let t = 0; t < TOTAL; t += STEP) times.push(t);
const shot = async (t) => { await page.evaluate((x) => window.render(x), t); return PNG.sync.read(await page.screenshot({ type: 'png' })).data; };

// ---- palette: the most frequent colours (5 bits per channel) over a sample of frames; index 255 stays transparent
const counts = new Map();
for (const t of times.filter((_, i) => i % 6 === 0)) {
  const px = await shot(t);
  for (let i = 0; i < px.length; i += 4) { const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
}
const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([k]) => k);
const pal = keys.map((k) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);
while (pal.length < 256) pal.push([0, 0, 0]);
const nearest = new Int16Array(32768).fill(-1);
const indexOf = (r, g, b) => {
  const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let n = nearest[k];
  if (n < 0) {
    let best = 1e9;
    for (let i = 0; i < 255; i++) { const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2; if (d < best) { best = d; n = i; } }
    nearest[k] = n;
  }
  return n;
};

// ---- GIF writer
const bytes = [];
const u16 = (n) => { bytes.push(n & 255, (n >> 8) & 255); };
const ascii = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
ascii('GIF89a'); u16(W); u16(H); bytes.push(0xf7, 0, 0); // global colour table of 256 entries
for (const [r, g, b] of pal) bytes.push(r, g, b);
bytes.push(0x21, 0xff, 0x0b); ascii('NETSCAPE2.0'); bytes.push(3, 1, 0, 0, 0); // loop forever

/** GIF LZW of palette indices into length-prefixed sub-blocks (min code size 8, codes up to 12 bits). */
function lzw(ix) {
  const clear = 256, eoi = 257; let size = 9, next = 258; const table = new Map(); const data = []; let acc = 0, nbits = 0;
  const emit = (code) => { acc |= code << nbits; nbits += size; while (nbits >= 8) { data.push(acc & 255); acc >>>= 8; nbits -= 8; } };
  emit(clear);
  let cur = ix[0];
  for (let i = 1; i < ix.length; i++) {
    const k = ix[i]; const key = (cur << 8) | k; const hit = table.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next === 4096) { emit(clear); table.clear(); size = 9; next = 258; }
    else { if (next >= 1 << size) size++; table.set(key, next++); }
    cur = k;
  }
  emit(cur); emit(eoi);
  if (nbits > 0) data.push(acc & 255);
  const blocks = [];
  for (let i = 0; i < data.length; i += 255) { const part = data.slice(i, i + 255); blocks.push(part.length, ...part); }
  return blocks;
}

let prev; let pending; // the last written frame's indices, and a frame waiting for its final delay
const flush = () => {
  if (!pending) return;
  const { x, y, w, h, ix, delay } = pending;
  bytes.push(0x21, 0xf9, 4, 0x05, delay & 255, delay >> 8, 255, 0); // keep previous frame, index 255 transparent
  bytes.push(0x2c); u16(x); u16(y); u16(w); u16(h); bytes.push(0, 8);
  for (const b of lzw(ix)) bytes.push(b);
  bytes.push(0);
};
const delay = Math.round(STEP / 10);
const saveAt = args.png ? new Set([3600, 7400, 11800, 15600, 19600].map((t) => Math.floor(t / STEP) * STEP)) : new Set();
let frames = 0;
for (const t of times) {
  const px = await shot(t);
  if (saveAt.has(t)) { mkdirSync(args.png, { recursive: true }); const png = new PNG({ width: W, height: H }); px.copy(png.data); writeFileSync(path.join(args.png, `frame-${t}.png`), PNG.sync.write(png)); }
  const cur = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < cur.length; i++, p += 4) cur[i] = indexOf(px[p], px[p + 1], px[p + 2]);
  // the rectangle that changed since the previous frame; an unchanged frame only lengthens the one before
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!prev || cur[i] !== prev[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { pending.delay += delay; continue; }
  flush();
  const w = x1 - x0 + 1, h = y1 - y0 + 1; const ix = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y0 + y) * W + x0 + x;
    ix[y * w + x] = prev && cur[i] === prev[i] ? 255 : cur[i];
  }
  pending = { x: x0, y: y0, w, h, ix, delay };
  prev = cur; frames++;
}
pending.delay += 150; // the last frame holds a moment longer before the loop starts again
flush();
bytes.push(0x3b);
writeFileSync(out, Buffer.from(bytes));
await browser.close();
console.log(`${path.relative(process.cwd(), out)}: ${W}x${H}, ${frames} frames, ${(TOTAL / 1000).toFixed(1)} s, ${(bytes.length / 1024).toFixed(0)} KB`);
