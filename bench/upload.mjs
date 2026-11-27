// File upload: the upload step in act, the snapshot's file inputs, made files and files from the files folder,
// hidden inputs behind buttons and drop zones, iframes, privacy, record / replay / export.
// Fixtures: bench/upload-pages.mjs (each file input reports "files: <name> (<bytes>, <type>, <decoded>)").
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('upload');
const CANARY = 'CANARY-UPLOAD-7731';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const msOf = (out, kind = 'upload') => Number(new RegExp(`✓ ${kind} .*\\((\\d+)ms\\)`).exec(out)?.[1] ?? NaN);

const s = await connect({ prefix: 'fq-upload-' });
mkdirSync(path.join(s.dir, 'files', 'sub'), { recursive: true });
writeFileSync(path.join(s.dir, 'files', 'notes.txt'), `${CANARY} meeting notes\n`);
writeFileSync(path.join(s.dir, 'files', 'sub', 'scan.png'), PNG);
writeFileSync(path.join(s.dir, 'outside.txt'), 'not for upload\n');
const open = (p) => s.call('open', { url: `${base}${p}`, fresh: true });
const act = (steps) => s.call('act', { steps, snapshot: 'diff' });

// ---------------------------------------------------------------- 1. the snapshot and fill
let out = await open('/upload/plain');
has('snapshot: a file input is listed as "file" with the types it accepts', out, /e\d+ file "Select picture" accept:image\/\*/);
lacks('snapshot: a file input is not shown as a textbox', out, 'textbox "Select picture"');
out = await act([{ do: 'fill', target: 'Select picture', value: 'photo.png' }]);
has('fill on a file input says to use upload', out, '"Select picture" is a file input: use the upload step');
lacks('fill on a file input: no raw Playwright error', out, 'cannot be filled');

// ---------------------------------------------------------------- 2. made files on a plain input
out = await act([
  { do: 'upload', target: 'Select picture', value: 'photo.png' },
  { do: 'expect_text', value: 'files: photo.png (70 bytes, image/png, image 1x1)' },
]);
has('made PNG: uploaded, and the browser decodes it', out, '✓ upload "Select picture" "photo.png" — photo.png (70 bytes, made)', '✓ expect_text');
has('the snapshot diff shows the chosen file', out, /file "Select picture" ="photo\.png"/);
check('upload is fast (under 1 s)', msOf(out) < 1000, out);

out = await act([
  { do: 'upload', target: 'Select picture', value: 'big.jpg:6MB' },
  { do: 'expect_text', value: 'files: big.jpg (6291456 bytes, image/jpeg, image 1x1)' },
  { do: 'upload', target: 'Select picture', value: 'anim.gif:300KB' },
  { do: 'expect_text', value: 'files: anim.gif (307200 bytes, image/gif, image 1x1)' },
  { do: 'upload', target: 'Select picture', value: 'w.webp:200KB' },
  { do: 'expect_text', value: 'files: w.webp (204800 bytes, image/webp, image 1x1)' },
  { do: 'upload', target: 'Select picture', value: 'odd.webp:1001' },
  { do: 'expect_text', value: 'files: odd.webp (1001 bytes, image/webp, image 1x1)' },
  { do: 'upload', target: 'Select picture', value: 'edge.png:5242881' },
  { do: 'expect_text', value: 'files: edge.png (5242881 bytes, image/png, image 1x1)' },
  { do: 'upload', target: 'Select picture', value: 'half.jpg:1.5MB' },
  { do: 'expect_text', value: 'files: half.jpg (1572864 bytes, image/jpeg, image 1x1)' },
]);
has('made images of an exact size stay valid images (JPEG, GIF, WebP, PNG)', out, '6291456 bytes = 6 MB, made', '307200 bytes = 300 KB, made', '1572864 bytes = 1.5 MB, made');
lacks('made images of an exact size: no step failed', out, '✗');

out = await act([
  { do: 'upload', target: 'Select picture', value: 'tiny.png:10B' },
  { do: 'expect_text', value: 'files: tiny.png (10 bytes, image/png, not an image)' },
  { do: 'upload', target: 'Select picture', value: 'empty.png:0B' },
  { do: 'expect_text', value: 'files: empty.png (0 bytes, image/png, not an image)' },
  { do: 'upload', target: 'Select picture', value: 'data.json:2KB' },
  { do: 'expect_text', value: 'files: data.json (2048 bytes, application/json, valid json)' },
  { do: 'upload', target: 'Select picture', value: 'virus.exe' },
]);
has('a size below the smallest valid file is said to be cut', out, 'tiny.png (10 bytes, cut: not a valid PNG)');
has('a 0-byte file is said to be empty', out, 'empty.png (0 bytes, empty)');
has('an unknown type gets filler bytes, and says so', out, 'virus.exe (1024 bytes = 1 KB, filler bytes');
has('a file outside the accept list is pointed out', out, 'not in accept="image/*"');
lacks('negative uploads: no step failed', out, '✗');

out = await act([
  { do: 'upload', target: 'Select picture', value: 'big.jpg:6MB' },
  { do: 'click', target: 'Send' },
  { do: 'expect_text', value: 'server: big.jpg 6291456 bytes' },
]);
has('the server receives the made file byte for byte', out, '✓ expect_text "server: big.jpg 6291456 bytes"');

// ---------------------------------------------------------------- 3. several inputs, several files, clearing
await open('/upload/multi');
out = await act([
  { do: 'upload', target: 'Attachments', value: 'a.png|b.pdf:1KB|c.txt' },
  { do: 'expect_text', value: 'files: a.png (70 bytes, image/png, image 1x1) | b.pdf (1024 bytes, application/pdf) | c.txt (' },
]);
has('several files in one step', out, '✓ upload "Attachments" "a.png|b.pdf:1KB|c.txt" — a.png (70 bytes, made), b.pdf (1024 bytes = 1 KB, made), c.txt (', '✓ expect_text');
out = await act([{ do: 'upload', target: 'Attachments', value: '' }, { do: 'expect_text', value: 'files: none' }]);
has('an empty value clears the selection', out, '✓ upload "Attachments" "" — selection cleared', '✓ expect_text');
out = await act([{ do: 'upload', target: 'Front of ID card', value: 'a.png|b.png' }]);
has('two files on a single-file input: the step fails', out, '✗ upload "Front of ID card"');
out = await act([{ do: 'upload', value: 'a.png' }]);
has('no target on a page with several file inputs: the inputs are listed', out, '✗ upload "a.png" — 3 file inputs on the page', '"Front of ID card"', '"Back of ID card"', '"Attachments"');

// ---------------------------------------------------------------- 4. hidden inputs: a styled button, a drop zone, an overlay
out = await open('/upload/styled');
has('snapshot: a hidden file input is listed too, marked hidden', out, /e\d+ file accept:\.png,\.jpg \[hidden\]/);
const hiddenRef = /(e\d+) file accept:\.png,\.jpg \[hidden\]/.exec(out)?.[1];
out = await act([
  { do: 'upload', target: 'Upload avatar', value: 'me.jpg' },
  { do: 'expect_text', value: 'files: me.jpg (285 bytes, image/jpeg, image 1x1)' },
]);
has('a button that opens the file picker: the picker gets the file', out, '✓ upload "Upload avatar" "me.jpg" — me.jpg (285 bytes, made)', '✓ expect_text');
out = await act([{ do: 'upload', target: hiddenRef ?? 'e0', value: 'ref.png' }, { do: 'expect_text', value: 'files: ref.png (70 bytes' }]);
has('the hidden input by its snapshot ref', out, '✓ expect_text');

await open('/upload/dropzone');
out = await act([
  { do: 'upload', target: 'Drag files here or click to browse', value: 'a.pdf|b.pdf' },
  { do: 'expect_text', value: '| b.pdf (' },
]);
has('a drop zone that opens the picker of a hidden input', out, '✓ upload "Drag files here or click to browse"', '✓ expect_text');

await open('/upload/overlay');
out = await act([{ do: 'upload', target: 'Choose file', value: 'cv.pdf' }, { do: 'expect_text', value: 'files: cv.pdf (' }]);
has('a transparent input over a styled label, by the label text', out, '✓ upload "Choose file" "cv.pdf"', '✓ expect_text');

// ---------------------------------------------------------------- 5. no target, late inputs, no picker, iframes
await open('/upload/plain');
out = await act([{ do: 'upload', value: 'only.png' }, { do: 'expect_text', value: 'files: only.png (' }]);
has('no target: the page\'s only file input', out, '✓ upload "only.png" — only.png (70 bytes, made)', '✓ expect_text');
await open('/upload/late');
out = await act([{ do: 'upload', value: 'late.txt' }, { do: 'expect_text', value: 'files: late.txt (' }]);
has('no target: waits for a file input that arrives late', out, '✓ upload "late.txt"', '✓ expect_text');
await open('/upload/none');
out = await act([{ do: 'upload', value: 'x.png', timeout: 1000 }]);
has('no file input on the page: says so', out, '✗ upload "x.png" — no file input on the page');
let t0 = Date.now();
out = await act([{ do: 'upload', target: 'Upload', value: 'x.png' }]);
has('a button that opens no picker: says so', out, '✗ upload "Upload" "x.png" — clicking "Upload" opened no file picker');
check('a button that opens no picker: answered within 4 s', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);

await open('/upload/frame');
out = await act([{ do: 'upload', target: 'Select picture', value: 'inframe.png' }, { do: 'expect_text', value: 'files: inframe.png (70 bytes' }]);
has('a file input inside an iframe', out, '✓ upload "Select picture" "inframe.png"', '✓ expect_text');

// ---------------------------------------------------------------- 6. your own files: only from the files folder
await open('/upload/plain');
out = await act([
  { do: 'upload', target: 'Select picture', value: 'files/notes.txt' },
  { do: 'expect_text', value: 'files: notes.txt (' },
  { do: 'upload', target: 'Select picture', value: 'files/sub/scan.png' },
  { do: 'expect_text', value: 'files: scan.png (70 bytes, image/png, image 1x1)' },
]);
has('a real file from the files folder, also in a subfolder', out, /notes\.txt \(\d+ bytes, your file/, 'scan.png (70 bytes, your file)');
lacks('a real file from the files folder: no step failed', out, '✗');
out = await act([{ do: 'upload', target: 'Select picture', value: 'files/../outside.txt' }]);
has('files/.. is refused', out, '✗ upload', 'outside the files folder');
out = await act([{ do: 'upload', target: 'Select picture', value: 'files/missing.pdf' }]);
has('a missing file is named', out, '✗ upload', 'no file "missing.pdf" in');
for (const bad of ['../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini', '~/.ssh/id_rsa']) {
  out = await act([{ do: 'upload', target: 'Select picture', value: bad }]);
  has(`a path is not a made file name: ${bad}`, out, '✗ upload', 'is not a file name');
}
out = await act([{ do: 'upload', target: 'Select picture', value: 'big.jpg:6XB' }]);
has('an unknown size unit is refused', out, '✗ upload', 'unknown size "6XB"');
let linked = false;
try { symlinkSync(path.join(s.dir, 'outside.txt'), path.join(s.dir, 'files', 'link.txt')); linked = true; } catch { /* no symlink rights (Windows without developer mode) */ }
if (linked) {
  out = await act([{ do: 'upload', target: 'Select picture', value: 'files/link.txt' }]);
  has('a symlink out of the files folder is refused', out, '✗ upload', 'outside the files folder');
} else console.log('skip a symlink out of the files folder is refused (cannot create symlinks here)');

// ---------------------------------------------------------------- 7. size limit and large files
await open('/upload/multi');
out = await act([{ do: 'upload', target: 'Attachments', value: 'huge.bin:60MB' }, { do: 'expect_text', value: 'files: huge.bin (62914560 bytes', timeout: 15000 }]);
has('a made file over 50 MB (above Playwright\'s in-memory limit)', out, '✓ upload "Attachments" "huge.bin:60MB"', '✓ expect_text');
out = await act([{ do: 'upload', target: 'Attachments', value: 'x.bin:200MB' }]);
has('a made file over the limit is refused', out, '✗ upload', 'larger than the 100 MB limit');

// ---------------------------------------------------------------- 7b. edge cases found in review
await open('/upload/plain');
const longName = `${'n'.repeat(251)}.png`;
out = await act([{ do: 'upload', target: 'Select picture', value: longName }, { do: 'expect_text', value: `files: ${longName} (70 bytes, image/png, image 1x1)` }]);
has('a 255-character file name reaches the page whole (Windows path limit)', out, '✓ expect_text');
writeFileSync(path.join(s.dir, 'files', '..notes.txt'), 'dots\n');
out = await act([{ do: 'upload', target: 'Select picture', value: 'files/..notes.txt' }, { do: 'expect_text', value: 'files: ..notes.txt (' }]);
has('a file whose name starts with two dots is not taken for a path outside', out, '✓ expect_text');

await open('/upload/disabled');
out = await act([{ do: 'upload', target: 'Photo', value: 'x.png', timeout: 1000 }]);
has('a disabled file input: the step fails, as it would for a person', out, '✗ upload "Photo" "x.png" — the file input is disabled');
has('a disabled file input: the page got no file', await s.call('snapshot', {}), 'files: none');

await open('/upload/slowbutton');
out = await act([{ do: 'upload', target: 'Upload', value: 'slow.png', timeout: 5000 }, { do: 'expect_text', value: 'files: slow.png (' }]);
has('a button that becomes clickable after 2.5 s still gets its file picker answered', out, '✓ upload "Upload" "slow.png"', '✓ expect_text');

await open('/upload/latehidden');
out = await act([{ do: 'upload', target: '#late', value: 'late.png', timeout: 4000 }, { do: 'expect_text', value: 'files: late.png (' }]);
has('a hidden file input that appears late, by its selector', out, '✓ upload "#late" "late.png"', '✓ expect_text');

await open('/upload/pet');
out = await act([{ do: 'upload', target: 'Select picture', value: 'pet.png' }, { do: 'expect_text', value: 'files: pet.png (' }, { do: 'expect_no_text', value: 'pet: chosen' }]);
has('an exact label in an iframe wins over a loose one in the page', out, '✓ expect_text', '✓ expect_no_text');

out = await open('/upload/rows');
const hiddenLines = out.split('\n').filter((l) => / file .*\[hidden\]/.test(l)).length;
check('the snapshot lists at most 5 hidden file inputs per frame', hiddenLines === 5, out);
has('the rest are counted, and the visible buttons are all listed', out, '7 more hidden file inputs', 'button "Attach 12"', 'button "Save all"');

// ---------------------------------------------------------------- 8. privacy: file contents never reach results or artifacts
await open('/upload/plain');
out = await act([{ do: 'upload', target: 'Select picture', value: 'files/notes.txt' }, { do: 'click', target: 'Send' }, { do: 'expect_text', value: 'server: notes.txt' }]);
has('your file is sent to the page\'s server', out, '✓ expect_text');
const ev = await s.call('evidence', {});
lacks('evidence does not contain the file contents', out + ev, CANARY);
await s.call('flow', { action: 'save', name: 'privacy' });
lacks('a saved flow does not contain the file contents', readFileSync(path.join(s.dir, 'flows', 'privacy.json'), 'utf8'), CANARY);
await s.close();

// ---------------------------------------------------------------- 9. record, replay, export
{
  const r = await connect({ prefix: 'fq-upload-flow-' });
  mkdirSync(path.join(r.dir, 'files'), { recursive: true });
  writeFileSync(path.join(r.dir, 'files', 'notes.txt'), 'meeting notes\n');
  await r.call('open', { url: `${base}/upload/plain` });
  let o = await r.call('act', { steps: [
    { do: 'upload', target: 'Select picture', value: 'photo.png' },
    { do: 'expect_text', value: 'files: photo.png (70 bytes, image/png, image 1x1)' },
    { do: 'goto', value: `${base}/upload/styled` },
    { do: 'upload', target: 'Upload avatar', value: 'me.jpg:2MB' },
    { do: 'expect_text', value: 'files: me.jpg (2097152 bytes, image/jpeg, image 1x1)' },
    { do: 'goto', value: `${base}/upload/multi` },
    { do: 'upload', target: 'Attachments', value: 'files/notes.txt|big.png:1MB' },
    { do: 'expect_text', value: 'files: notes.txt (14 bytes, text/plain) | big.png (1048576 bytes, image/png, image 1x1)' },
    { do: 'goto', value: `${base}/upload/form` },
    { do: 'upload', target: 'css=#frm input', value: 'doc.pdf' },
    { do: 'expect_text', value: 'files: doc.pdf (' },
  ] });
  has('recording: every upload ran', o, '✓ upload "Select picture"', '✓ upload "Upload avatar"', '✓ upload "Attachments"', '✓ upload "css=#frm input"');
  lacks('recording: every step passed', o, '✗');
  await r.call('flow', { action: 'save', name: 'uploads' });
  const flow = readFileSync(path.join(r.dir, 'flows', 'uploads.json'), 'utf8');
  has('the saved flow keeps the upload steps', flow, '"do": "upload"', '"value": "me.jpg:2MB"', '"value": "files/notes.txt|big.png:1MB"');
  o = await r.call('flow', { action: 'run', name: 'uploads' });
  has('replay: the flow passes with the same files', o, /^1\/1 flows passed/);
  o = await r.call('flow', { action: 'export', name: 'uploads' });
  has('export: upload steps are executable', o, 'await fq.upload(', 'me.jpg:2MB');
  lacks('export: no upload step is left unsupported', o, 'fastqa:unsupported step');
  await r.close();
  writeFileSync(path.join(r.dir, 'playwright.config.mjs'), `export default { testDir: './tests', reporter: 'line', use: { launchOptions: { executablePath: ${JSON.stringify(process.env.FASTQA_CHROME || '')} || undefined } } };`);
  try {
    const { stdout } = await promisify(exec)(`node "${path.resolve('node_modules/@playwright/test/cli.js')}" test -c "${r.dir}/playwright.config.mjs"`, { cwd: r.dir, env: { ...process.env, NODE_PATH: path.resolve('node_modules') } });
    has('the exported spec runs and passes with @playwright/test', stdout, /1 passed/);
  } catch (e) { check('the exported spec runs and passes with @playwright/test', false, `${e.stdout}\n${e.stderr}`); }
}

srv.close();
process.exit(done() ? 1 : 0);
