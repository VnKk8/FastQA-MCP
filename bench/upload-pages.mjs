// File upload fixtures for bench/upload.mjs, served by the demo server under /upload/<kind>.
// Every file input reports what the page received in a status line:
//   files: photo.png (69 bytes, image/png, image 1x1) | files: none
// Images are decoded by the browser, so a made file that is not a valid image shows "not an image".

const report = `
const describe = async (f) => {
  const bits = [f.size + ' bytes', f.type || 'no type'];
  if (/^image\\//.test(f.type)) {
    const img = new Image(); img.src = URL.createObjectURL(f);
    try { await img.decode(); bits.push('image ' + img.naturalWidth + 'x' + img.naturalHeight); } catch { bits.push('not an image'); }
  }
  if (/json/.test(f.type)) { try { JSON.parse(await f.text()); bits.push('valid json'); } catch { bits.push('invalid json'); } }
  return f.name + ' (' + bits.join(', ') + ')';
};
const watch = (input) => input.addEventListener('change', async () => {
  const out = document.getElementById('out-' + input.id);
  out.textContent = 'files: ' + (input.files.length ? (await Promise.all(Array.from(input.files).map(describe))).join(' | ') : 'none');
});
document.querySelectorAll('input[type=file]').forEach(watch);
`;

const shell = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto}.dz{border:2px dashed #888;padding:30px;text-align:center;cursor:pointer}
.btn{display:inline-block;position:relative;overflow:hidden;background:#246;color:#fff;padding:6px 12px;border-radius:4px}
.btn input{position:absolute;inset:0;opacity:0;cursor:pointer}</style></head><body>
${body}
<script>${report}${script}</script></body></html>`;

const status = (id) => `<p role="status" id="out-${id}">files: none</p>`;

const pages = {
  // a plain, visible file input with a label, inside a form that posts to the server
  plain: () => shell('Upload plain', `<h1>Profile</h1>
<form id="f">
  <label for="pic">Select picture</label> <input type="file" id="pic" name="pic" accept="image/*">
  ${status('pic')}
  <button type="submit">Send</button>
  <p role="status" id="server">server: nothing sent</p>
</form>`, `
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/upload', { method: 'POST', body: new FormData(e.target) });
  const j = await r.json();
  document.getElementById('server').textContent = 'server: ' + (j.files.map((x) => x.name + ' ' + x.bytes + ' bytes').join(' | ') || 'no file');
});`),
  // the real input is hidden; a styled button opens the file picker
  styled: () => shell('Upload styled', `<h1>Avatar</h1>
<input type="file" id="avatar" accept=".png,.jpg" style="display:none">
<button type="button" id="pick">Upload avatar</button>
${status('avatar')}`, `document.getElementById('pick').onclick = () => document.getElementById('avatar').click();`),
  // a drop zone: a plain div that opens the picker of a hidden multiple input
  dropzone: () => shell('Upload dropzone', `<h1>Documents</h1>
<div class="dz" id="zone">Drag files here or click to browse</div>
<input type="file" id="dz" multiple style="display:none">
${status('dz')}`, `document.getElementById('zone').onclick = () => document.getElementById('dz').click();`),
  // a transparent input over a styled label (a common CSS pattern)
  overlay: () => shell('Upload overlay', `<h1>Resume</h1>
<label class="btn">Choose file<input type="file" id="cv" accept=".pdf,.docx"></label>
${status('cv')}`),
  // several file inputs: a step without a target cannot pick one
  multi: () => shell('Upload multi', `<h1>Verification</h1>
<label for="front">Front of ID card</label> <input type="file" id="front" accept="image/*,.pdf"> ${status('front')}
<label for="back">Back of ID card</label> <input type="file" id="back" accept="image/*,.pdf"> ${status('back')}
<label for="att">Attachments</label> <input type="file" id="att" multiple> ${status('att')}`),
  // no file input at all; the button does nothing
  none: () => shell('Upload none', `<h1>Nothing to upload</h1><button type="button">Upload</button>`),
  // the plain page inside an iframe
  frame: () => shell('Upload frame', `<h1>Embedded</h1><iframe title="Uploader" src="/upload/plain" width="600" height="300"></iframe>`),
  // a disabled file input: a person cannot choose a file here
  disabled: () => shell('Upload disabled', `<h1>Closed</h1>
<label for="shut">Photo</label> <input type="file" id="shut" disabled> ${status('shut')}`),
  // the upload button is disabled for 2.5 s, then opens the picker of a hidden input
  slowbutton: () => shell('Upload slow button', `<h1>Slow</h1>
<input type="file" id="slow" style="display:none"> <button type="button" id="go" disabled>Upload</button> ${status('slow')}`, `
document.getElementById('go').onclick = () => document.getElementById('slow').click();
setTimeout(() => { document.getElementById('go').disabled = false; }, 2500);`),
  // a hidden file input that is added 800 ms after the page, targeted by its selector
  latehidden: () => shell('Upload late hidden', `<h1>Late hidden</h1><div id="slot"></div>`, `
setTimeout(() => {
  document.getElementById('slot').innerHTML = '<input type="file" id="late" style="display:none"> <p role="status" id="out-late">files: none</p>';
  watch(document.getElementById('late'));
}, 800);`),
  // a selector that matches a text field and a file input: only the file input takes files
  form: () => shell('Upload form', `<h1>Form</h1>
<form id="frm"><label>Title <input name="title"></label> <input type="file" id="doc2"></form> ${status('doc2')}`),
  // a loose label match in the page ("Select picture of pet") and an exact one inside an iframe ("Select picture")
  pet: () => shell('Upload pet', `<h1>Pets</h1>
<label for="petpic">Select picture of pet</label> <input type="file" id="petpic" style="display:none">
<p role="status" id="pet">pet: none</p>
<iframe title="Uploader" src="/upload/plain" width="600" height="300"></iframe>`, `
document.getElementById('petpic').addEventListener('change', () => { document.getElementById('pet').textContent = 'pet: chosen'; });`),
  // a table where every row has an Attach button over a hidden file input
  rows: () => shell('Upload rows', `<h1>Invoices</h1><table>${Array.from({ length: 12 }, (_, i) => `<tr><td>Invoice ${i + 1}</td><td><input type="file" id="att${i + 1}" style="display:none"><button type="button" onclick="document.getElementById('att${i + 1}').click()">Attach ${i + 1}</button></td></tr>`).join('')}</table>
<button type="button">Save all</button>`),
  // the file input arrives a moment after the page
  late: () => shell('Upload late', `<h1>Late</h1><div id="slot"></div>`, `
setTimeout(() => {
  document.getElementById('slot').innerHTML = '<label for="doc">Document</label> <input type="file" id="doc"> <p role="status" id="out-doc">files: none</p>';
  watch(document.getElementById('doc'));
}, 400);`),
};

/** The fixture page for a path, or undefined. */
export function uploadPage(pathname) {
  const m = /^\/upload\/(\w+)$/.exec(pathname);
  return m && pages[m[1]] ? pages[m[1]]() : undefined;
}

/**
 * Counts the files in a multipart/form-data body without decoding it as text, so binary files keep their exact size.
 * Returns [{ name, bytes }].
 */
export function multipartFiles(raw, contentType) {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!b) return [];
  const sep = Buffer.from('--' + (b[1] || b[2]));
  const out = [];
  let i = raw.indexOf(sep);
  while (i >= 0) {
    const next = raw.indexOf(sep, i + sep.length);
    if (next < 0) break;
    const part = raw.subarray(i + sep.length + 2, next - 2); // skip CRLF after the boundary, drop CRLF before the next
    const head = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, head).toString('utf8');
    const name = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name !== undefined && name !== '') out.push({ name, bytes: part.length - head - 4 });
    i = next;
  }
  return out;
}
