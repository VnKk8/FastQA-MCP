// 1.0.4: the findings of the November 2026 technical review (FQA-01 … FQA-09) and the three gaps found while
// verifying it, end to end over real MCP stdio. Each check names the finding it covers. Own fixture servers:
// two origins on 127.0.0.1 (another port is a sibling of the same site) so first-party siblings can be tested.
import http from 'node:http';
import { connect, suite } from './lib.mjs';

const { check, has, lacks, done } = suite('review-findings');

const PW = 'S3ntinel-PW-91x';
const OTP = '739104';
const html = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;
const post = (url) => `fetch(${url}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })`;

let apiBase = '';
const pages = {
  // FQA-03: typed secrets in fields that the visual inspection describes (both overflow the page sideways)
  // (each field is covered by a button, so the visual inspection describes the field itself)
  '/secret': () => html('Secret', `<h1>Sign in</h1>
<label for="pw">Password</label><input type="password" id="pw" style="position:absolute;left:10px;top:80px;width:160px"><button type="button" style="position:absolute;left:40px;top:80px">Show</button>
<label for="otp">One-time code</label><input id="otp" name="otp" autocomplete="one-time-code" style="position:absolute;left:10px;top:140px;width:160px"><button type="button" style="position:absolute;left:40px;top:140px">Resend</button>
<input id="note" placeholder="Note" style="position:absolute;left:10px;top:200px;width:160px"><button type="button" style="position:absolute;left:40px;top:200px">Clear</button>`),
  // FQA-06: two saves to one endpoint, the first succeeds, the second fails
  '/saves': () => html('Saves', `<button type="button" id="a">Save A</button> <button type="button" id="b">Save B</button><p role="status" id="st"></p>`,
    `document.getElementById('a').onclick = async () => { const r = await ${post("'/api/save?x=a'")}; document.getElementById('st').textContent = 'A ' + r.status; };
document.getElementById('b').onclick = async () => { const r = await ${post("'/api/save?x=b'")}; document.getElementById('st').textContent = 'B ' + r.status; };`),
  // FQA-04: the same label in two rows (two records) and twice in one row (one record)
  '/rows': () => html('Rows', `<table><tr><td>Customer 1001</td><td><button type="button" onclick="st.textContent='Opened 1001'">Open</button></td></tr>
<tr><td>Customer 1002</td><td><button type="button" onclick="st.textContent='Opened 1002'">Open</button></td></tr></table>
<ul><li>Customer 2001 <a href="#" onclick="st.textContent='Viewed 2001';return false">View</a> <a href="#" onclick="st.textContent='Viewed 2001';return false">View</a></li></ul>
<p role="status" id="st"></p>`, 'var st = document.getElementById("st");'),
  // FQA-07: native confirm and prompt
  '/dialogs': () => html('Dialogs', `<button type="button" id="rm">Remove item</button> <button type="button" id="nm">Set name</button> <button type="button" id="no">Nothing</button><p role="status" id="st"></p>`,
    `const st = document.getElementById('st');
document.getElementById('rm').onclick = () => { st.textContent = confirm('Remove item 7?') ? 'Removed' : 'Kept'; };
document.getElementById('nm').onclick = () => { const v = prompt('Your name?'); st.textContent = v ? 'Hi ' + v : 'No name'; };
document.getElementById('no').onclick = () => { st.textContent = 'Nothing happened'; };`),
  // missed 2: an API on another port of the same host (a sibling of the site), failing
  '/sibling': () => html('Sibling', `<button type="button" id="s">Load orders</button><p role="status" id="st"></p>`,
    `document.getElementById('s').onclick = async () => { await fetch('${apiBase}/api/orders').catch(() => {}); document.getElementById('st').textContent = 'Loaded'; };`),
  // missed 3: HTTP 200 whose envelope says it failed
  '/envelope': () => html('Envelope', `<button type="button" id="e">Claim bonus</button><p role="status" id="st"></p>`,
    `document.getElementById('e').onclick = async () => { await ${post("'/api/claim'")}; document.getElementById('st').textContent = 'Done'; };`),
};
const app = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body); };
  if (pages[u.pathname]) return send(200, 'text/html', pages[u.pathname]());
  if (u.pathname === '/api/save') return send(u.searchParams.get('x') === 'b' ? 500 : 200, 'application/json', '{"ok":true}');
  if (u.pathname === '/api/claim') return send(200, 'application/json', JSON.stringify({ IsSuccess: false, Error: 'private-reason-text-77', Data: null }));
  send(404, 'text/plain', 'not found');
});
const api = http.createServer((req, res) => {
  res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end('{"error":"down"}');
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;
apiBase = `http://127.0.0.1:${api.address().port}`;

// ---------------------------------------------------------------- FQA-03: no typed value in visual or snapshot output
{
  const s = await connect({ prefix: 'fq-rev-3-' });
  await s.call('open', { url: `${base}/secret` });
  await s.call('act', { steps: [{ do: 'fill', target: 'Password', value: PW }, { do: 'fill', target: 'One-time code', value: OTP }, { do: 'fill', target: 'Note', value: 'Zq8-private-77' }] });
  const vis = await s.call('evidence', { view: 'visual' });
  has('FQA-03: the visual inspection still reports the covered fields', vis, 'overlap');
  lacks('FQA-03: an ordinary text field never shows what was typed either', vis, 'Zq8-private-77');
  lacks('FQA-03: a typed password never appears in visual findings', vis, PW);
  lacks('FQA-03: a typed one-time code never appears in visual findings', vis, OTP);
  has('FQA-03: fields are named by their label or placeholder instead', vis, 'input "Password"', 'input "One-time code"', 'input "Note"');
  const snap = await s.call('snapshot', {});
  lacks('FQA-03: a field declared as a one-time code shows no value in the snapshot', snap, OTP);
  has('FQA-03: the masked field is still listed', snap, /textbox "One-time code" =•••/);
  await s.close();
}

// ---------------------------------------------------------------- FQA-06: expect_request judges the latest action
{
  const s = await connect({ prefix: 'fq-rev-6-' });
  await s.call('open', { url: `${base}/saves` });
  let out = await s.call('act', { steps: [{ do: 'click', target: 'Save A' }, { do: 'click', target: 'Save B' }, { do: 'expect_request', target: 'POST /api/save', value: '2xx', timeout: 1500 }] });
  has('FQA-06: an earlier success cannot pass an assertion about a later failed save', out, /^FAILED at step 3\/3/, 'status not 2xx', 'latest matching request of the latest action');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Save B' }, { do: 'click', target: 'Save A' }, { do: 'expect_request', target: 'POST /api/save', value: '2xx' }] });
  has('FQA-06: the latest action succeeded: passes', out, /^PASSED 3\/3/);
  out = await s.call('act', { steps: [{ do: 'click', target: 'Save A' }, { do: 'click', target: 'Save B' }, { do: 'expect_request', target: 'POST /api/save', value: '2xx', scope: 'batch' }] });
  has('FQA-06: scope "batch" keeps the 1.0.3 meaning (any matching request of the batch)', out, /^PASSED 3\/3/);
  out = await s.call('act', { steps: [{ do: 'click', target: 'Save B' }, { do: 'expect_request', target: 'POST /api/save', value: '500' }] });
  has('FQA-06: a negative assertion on the latest action still works', out, /^PASSED 2\/2/);
  await s.close();
}

// ---------------------------------------------------------------- FQA-04: one label in several records is not guessed
{
  const s = await connect({ prefix: 'fq-rev-4-' });
  await s.call('open', { url: `${base}/rows` });
  let out = await s.call('act', { steps: [{ do: 'click', target: 'Open' }] });
  has('FQA-04: "Open" in two rows is refused and the rows are listed', out, /^FAILED at step 1\/1/, 'in different rows or cards', 'Customer 1001', 'Customer 1002');
  lacks('FQA-04: nothing was opened', out, 'Opened 100');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Open', within: 'Customer 1002' }, { do: 'expect_text', value: 'Opened 1002' }] });
  has('FQA-04: within picks the intended row', out, /^PASSED 2\/2/);
  out = await s.call('act', { steps: [{ do: 'click', target: 'View' }, { do: 'expect_text', value: 'Viewed 2001' }] });
  has('FQA-04: duplicates inside one record keep the fast path (first match)', out, /^PASSED 2\/2/);
  await s.close();
}

// ---------------------------------------------------------------- FQA-07: native dialogs, armed explicitly
{
  const s = await connect({ prefix: 'fq-rev-7-' });
  await s.call('open', { url: `${base}/dialogs` });
  let out = await s.call('act', { steps: [{ do: 'click', target: 'Remove item' }, { do: 'expect_text', value: 'Kept' }] });
  has('FQA-07: an unarmed confirm is still dismissed (never accepted implicitly)', out, /^PASSED 2\/2/);
  out = await s.call('act', { steps: [{ do: 'dialog', value: 'accept', target: 'Remove item 7' }, { do: 'click', target: 'Remove item' }, { do: 'expect_text', value: 'Removed' }] });
  has('FQA-07: an armed confirm with the expected message is accepted', out, /^PASSED 3\/3/, 'accepted as armed');
  out = await s.call('act', { steps: [{ do: 'dialog', value: 'accept', target: 'Delete everything' }, { do: 'click', target: 'Remove item' }] });
  has('FQA-07: a dialog with another message fails the step and is dismissed', out, /^FAILED at step 2\/2/, 'not one containing "Delete everything"');
  out = await s.call('act', { steps: [{ do: 'dialog', value: 'dismiss' }, { do: 'click', target: 'Nothing' }] });
  has('FQA-07: an armed dialog that does not appear fails within the step', out, /^FAILED at step 2\/2/, 'the armed dialog did not appear');
  out = await s.call('act', { steps: [{ do: 'dialog', value: 'accept:Ivan' }, { do: 'click', target: 'Set name' }, { do: 'expect_text', value: 'Hi Ivan' }] });
  has('FQA-07: a prompt can be answered', out, /^PASSED 3\/3/);
  check('FQA-07: the prompt answer is not written into the dialog fact', !/Your name\?[^\n]*Ivan/.test(out), out);
  out = await s.call('act', { steps: [{ do: 'dialog', value: 'maybe' }] });
  has('FQA-07: a dialog step needs accept or dismiss', out, /^FAILED at step 1\/1/, 'needs value "accept"');
  await s.close();
}

// ---------------------------------------------------------------- missed 2: a sibling origin is first party
{
  const s = await connect({ prefix: 'fq-rev-sib-' });
  await s.call('open', { url: `${base}/sibling` });
  const out = await s.call('act', { steps: [{ do: 'click', target: 'Load orders' }] });
  has('siblings: a 500 from the same host on another port is judged as first party', out, /NET-5XX/);
  await s.close();
  const off = await connect({ prefix: 'fq-rev-sib-off-', config: { quality: { firstPartySiblings: false } } });
  await off.call('open', { url: `${base}/sibling` });
  const out2 = await off.call('act', { steps: [{ do: 'click', target: 'Load orders' }] });
  lacks('siblings: quality.firstPartySiblings false restores the 1.0.3 behaviour', out2, 'NET-5XX');
  await off.close();
}

// ---------------------------------------------------------------- missed 3: 200 with a failed envelope
{
  const cfg = { capture: { payloads: 'json', allowedOrigins: [base], allowUnknownLength: true } };
  const s = await connect({ prefix: 'fq-rev-env-', config: cfg });
  await s.call('open', { url: `${base}/envelope` });
  let out = await s.call('act', { steps: [{ do: 'click', target: 'Claim bonus' }] });
  has('envelope: HTTP 200 with IsSuccess false is a lead (the .NET shape counts)', out, /ENVELOPE-ERROR/, 'issuccess = false');
  const ev = await s.call('evidence', { view: 'findings' });
  lacks('envelope: the error text of the body is never shown', out + ev, 'private-reason-text-77');
  await s.close();
  const rule = { id: 'claim-ok', method: 'POST', path: '/api/claim', jsonPointer: '/Data', exists: false, severity: 'low' };
  const r = await connect({ prefix: 'fq-rev-env-rule-', config: { ...cfg, quality: { businessRules: [rule] } } });
  await r.call('open', { url: `${base}/envelope` });
  out = await r.call('act', { steps: [{ do: 'click', target: 'Claim bonus' }] });
  lacks('envelope: a configured business rule for the endpoint is the authority', out, 'ENVELOPE-ERROR');
  await r.close();
  const n = await connect({ prefix: 'fq-rev-env-off-', config: { ...cfg, quality: { envelopeErrors: false } } });
  await n.call('open', { url: `${base}/envelope` });
  out = await n.call('act', { steps: [{ do: 'click', target: 'Claim bonus' }] });
  lacks('envelope: quality.envelopeErrors false turns it off', out, 'ENVELOPE-ERROR');
  await n.close();
}

app.close(); api.close();
done();
