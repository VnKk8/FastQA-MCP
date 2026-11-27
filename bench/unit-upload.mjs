// Unit tests of the upload value format and the made files (no browser): exact sizes, valid structure, refused paths.
// Run with: node --test bench/unit-upload.mjs   (after npm run build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFiles, UPLOAD_MAX_BYTES, sendAsBytes } from '../dist/upload.js';

const MB = 1024 * 1024;
const made = (v) => uploadFiles(v, UPLOAD_MAX_BYTES);
const one = (v) => { const f = made(v); assert.equal(f.length, 1); return f[0]; };

// a CRC-32 written independently of the module under test
const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
const crc = (b) => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };

/** Walks the file's own structure; returns the number of bytes after the format's end (trailing bytes). */
const check = {
  png(b) {
    assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let i = 8; let type = '';
    while (type !== 'IEND') {
      const len = b.readUInt32BE(i); type = b.subarray(i + 4, i + 8).toString('latin1');
      assert.equal(b.readUInt32BE(i + 8 + len), crc(b.subarray(i + 4, i + 8 + len)), `CRC of ${type}`);
      i += 12 + len;
    }
    return b.length - i;
  },
  jpg(b) {
    assert.equal(b.readUInt16BE(0), 0xffd8);
    let i = 2;
    for (;;) {
      assert.equal(b[i], 0xff, `marker at ${i}`);
      const m = b[i + 1];
      if (m === 0xda) break; // start of scan: entropy-coded data follows
      i += 2 + b.readUInt16BE(i + 2);
    }
    const end = b.lastIndexOf(Buffer.from([0xff, 0xd9]));
    assert.ok(end > i);
    return b.length - end - 2;
  },
  gif(b) {
    assert.equal(b.subarray(0, 6).toString('latin1'), 'GIF89a');
    // the 1x1 base: header, logical screen, 2-colour table, graphic control, image descriptor and data
    let i = 13 + 6;
    for (;;) {
      if (b[i] === 0x3b) return b.length - i - 1;
      if (b[i] === 0x21) { i += 2; while (b[i] !== 0) i += b[i] + 1; i++; continue; } // extension and its sub-blocks
      if (b[i] === 0x2c) { i += 10; i++; while (b[i] !== 0) i += b[i] + 1; i++; continue; } // image: descriptor, LZW size, data
      assert.fail(`unexpected GIF block 0x${b[i].toString(16)} at ${i}`);
    }
  },
  webp(b) {
    assert.equal(b.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(b.subarray(8, 12).toString('latin1'), 'WEBP');
    const riff = b.readUInt32LE(4) + 8;
    let i = 12; const ids = [];
    while (i < riff) { const id = b.subarray(i, i + 4).toString('latin1'); const n = b.readUInt32LE(i + 4); ids.push(id); i += 8 + n + (n & 1); }
    assert.equal(i, riff, 'chunks fill the RIFF exactly');
    if (ids.length > 1) assert.equal(ids[0], 'VP8X', 'extra chunks only in the extended format');
    assert.ok(ids.includes('VP8L'));
    return b.length - riff;
  },
  pdf(b) {
    const s = b.toString('latin1');
    assert.ok(s.startsWith('%PDF-1.'));
    const eof = s.lastIndexOf('%%EOF\n');
    const sx = Number(/startxref\n(\d+)\n%%EOF/.exec(s)[1]);
    assert.equal(s.slice(sx, sx + 4), 'xref');
    const rows = s.slice(sx).split('\n').filter((l) => / 00000 n $/.test(l));
    rows.forEach((l, i) => assert.equal(s.slice(Number(l.slice(0, 10)), Number(l.slice(0, 10)) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
    const st = /\/Length (\d+) >>\nstream\n/.exec(s);
    if (st) assert.equal(s.slice(st.index + st[0].length + Number(st[1]), st.index + st[0].length + Number(st[1]) + 10), '\nendstream');
    return b.length - eof - 6;
  },
};

test('sizes are exact for every type, from 0 bytes to several MB', () => {
  const sizes = [0, 1, 3, 4, 19, 20, 21, 37, 38, 39, 56, 63, 64, 65, 66, 70, 71, 89, 90, 91, 285, 300, 301, 999, 1000, 1001, 4096, 65536, 65537, 65541, 65542, 70000, 200001, 3 * MB + 7];
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'csv', 'json', 'svg', 'xml', 'html', 'md', 'bin', 'exe', 'docx']) {
    for (const n of sizes) assert.equal(one(`f.${ext}:${n}`).buffer.length, n, `${ext} at ${n} bytes`);
  }
});

test('a made file of at least the smallest valid size keeps a valid structure', () => {
  const sizes = [undefined, 100, 300, 1000, 1001, 65537, 65541, 70000, 200001, 2 * MB + 1];
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'pdf']) {
    for (const n of sizes) {
      const f = one(n === undefined ? `f.${ext}` : `f.${ext}:${n}`);
      if (f.buffer.length < one(`f.${ext}`).buffer.length) continue;
      const trailing = check[ext](f.buffer);
      assert.ok(trailing >= 0 && trailing < 64, `${ext} at ${n}: ${trailing} bytes after the end`);
      assert.equal(f.kind, 'made', `${ext} at ${n}`);
    }
  }
  assert.equal(check.png(one('f.png:5000').buffer), 0, 'PNG padding goes in a text chunk, not after IEND');
  assert.equal(check.jpg(one('f.jpg:70000').buffer), 0, 'JPEG padding goes in comment segments');
  assert.equal(check.gif(one('f.gif:5000').buffer), 0, 'GIF padding goes in a comment extension');
  assert.equal(check.webp(one('f.webp:5000').buffer), 0, 'WebP padding goes in a chunk inside the RIFF');
  assert.equal(check.pdf(one('f.pdf:5000').buffer), 0, 'PDF padding goes in a stream object');
});

test('a padded JPEG keeps its JFIF header first, where type checks look for it', () => {
  for (const n of [290, 1000, 70000, 3 * MB]) {
    const b = one(`f.jpg:${n}`).buffer;
    assert.equal(b.subarray(0, 4).toString('hex'), 'ffd8ffe0', `${n}: SOI then APP0`);
    assert.equal(b.subarray(6, 11).toString('latin1'), 'JFIF\0', `${n}: JFIF at offset 6`);
  }
});

test('a large GIF keeps its comment sub-blocks valid', () => {
  for (const n of [60 * MB, 60 * MB + 1, 60 * MB + 2]) {
    const b = one(`f.gif:${n}`).buffer;
    assert.equal(b.length, n);
    assert.equal(check.gif(b), 0, `${n}`);
  }
});

test('files go to the browser as bytes only when it cannot open the paths', () => {
  const short = ['C:\\Temp\\fastqa-upload-abc\\0\\photo.png'];
  const long = [`C:\\Users\\someone\\AppData\\Local\\Temp\\fastqa-upload-abc\\0\\${'n'.repeat(251)}.png`];
  assert.equal(sendAsBytes(short, { platform: 'win32' }), false);
  assert.equal(sendAsBytes(long, { platform: 'win32' }), true, 'Windows cannot open paths of 260 characters and more');
  assert.equal(sendAsBytes(long, { platform: 'linux' }), false);
  for (const local of ['http://127.0.0.1:9222', 'http://localhost:9222', 'ws://[::1]:9222/devtools/browser/x', 'not a url']) assert.equal(sendAsBytes(short, { platform: 'linux', cdpUrl: local }), false, local);
  assert.equal(sendAsBytes(short, { platform: 'linux', cdpUrl: 'http://10.0.0.5:9222' }), true, 'a browser on another machine cannot read this disk');
});

test('text formats stay valid text of their type', () => {
  for (const n of [undefined, 100, 5000]) {
    const sz = n === undefined ? '' : `:${n}`;
    assert.doesNotThrow(() => JSON.parse(one(`d.json${sz}`).buffer.toString('utf8')));
    assert.match(one(`d.csv${sz}`).buffer.toString('utf8'), /^id,note\n1,/);
    assert.match(one(`d.svg${sz}`).buffer.toString('utf8'), /^<svg [^>]*>.*<\/svg>\n$/s);
    assert.match(one(`d.xml${sz}`).buffer.toString('utf8'), /<\/fastqa>\n$/);
    assert.match(one(`d.html${sz}`).buffer.toString('utf8'), /^<!doctype html>/);
    const comment = /<!--([^]*)-->/.exec(one(`d.svg${sz}`).buffer.toString('utf8'))?.[1] ?? '';
    assert.ok(!comment.includes('--'), 'no "--" inside the comment');
  }
});

test('small and empty files: cut and empty are said', () => {
  assert.equal(one('a.png:0B').kind, 'empty');
  assert.equal(one('a.png:10').kind, 'cut');
  assert.equal(one('a.png:10').buffer.toString('hex'), one('a.png').buffer.subarray(0, 10).toString('hex'), 'cut = the start of the valid file');
  assert.equal(one('a.png').kind, 'made');
  assert.equal(one('a.png').buffer.length, 70);
  assert.equal(one('a.jpg').buffer.length, 285);
  assert.equal(one('a.gif').buffer.length, 43);
  assert.equal(one('a.webp').buffer.length, 38);
});

test('an unknown extension gets filler bytes, with the magic number where it matters', () => {
  const exe = one('virus.exe');
  assert.equal(exe.kind, 'filler');
  assert.equal(exe.buffer.length, 1024, 'default size 1 KB');
  assert.equal(exe.buffer.subarray(0, 2).toString('latin1'), 'MZ');
  assert.equal(one('report.docx').buffer.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(one('noext').kind, 'filler');
});

test('the value format: several files, sizes and units, files/ paths, clearing', () => {
  assert.deepEqual(made(''), []);
  assert.deepEqual(made('   '), []);
  assert.equal(made('a.png|b.pdf| c.txt ').length, 3);
  assert.deepEqual(made('files/x/y.pdf'), [{ folder: 'x/y.pdf' }]);
  assert.deepEqual(made('files\\y.pdf'), [{ folder: 'y.pdf' }]);
  assert.equal(one('a.bin:1KB').buffer.length, 1024);
  assert.equal(one('a.bin:2k').buffer.length, 2048);
  assert.equal(one('a.bin:1.5MB').buffer.length, 1.5 * MB);
  assert.equal(one('a.bin:6 MB').buffer.length, 6 * MB);
  assert.equal(one('a.bin:512').buffer.length, 512);
  assert.equal(one('a.bin:512b').buffer.length, 512);
  assert.equal(one('фото на паспорт.png').name, 'фото на паспорт.png', 'unicode names and spaces are kept');
  assert.equal(one(`${'n'.repeat(251)}.png`).name.length, 255);
});

test('paths and bad values are refused before anything is made', () => {
  for (const bad of ['../x.png', '/etc/passwd', 'C:\\Windows\\win.ini', '~/.ssh/id_rsa', 'a/b.png', 'files/', 'files/../x', 'files/a/../../x', 'files//etc/passwd', 'files/C:\\x']) {
    assert.throws(() => made(bad), /is not a file name|outside the files folder/, bad);
  }
  assert.throws(() => made('big.jpg:6XB'), /unknown size "6XB"/);
  assert.throws(() => made('big.jpg:-1'), /unknown size "-1"/);
  assert.throws(() => made(':1KB'), /is not a file name/);
  assert.throws(() => made('x.bin:200MB'), /larger than the 100 MB limit/);
  assert.throws(() => made(`${'n'.repeat(252)}.png`), /is not a file name/);
  assert.equal(UPLOAD_MAX_BYTES, 100 * MB);
});

test('made files are deterministic, and the function works on its own (exported specs embed its source)', () => {
  const v = 'a.png:3000|b.jpg:70000|c.gif:999|d.webp:5001|e.pdf:4000|f.csv:300|g.exe';
  const again = new Function(`return (${uploadFiles.toString()})`)();
  const x = made(v); const y = again(v, UPLOAD_MAX_BYTES);
  assert.equal(x.length, y.length);
  x.forEach((f, i) => { assert.equal(f.name, y[i].name); assert.ok(f.buffer.equals(y[i].buffer), f.name); });
  assert.ok(made(v).every((f, i) => f.buffer.equals(x[i].buffer)));
});
