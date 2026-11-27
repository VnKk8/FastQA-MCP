// Unit tests of the pure modules (no browser): redaction, config and presets, event store, correlation, rules and policy.
// Run with: node --test bench/unit.mjs   (after npm run build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, MASK } from '../dist/privacy/redact.js';
import { parseConfig, ConfigError, CAPS } from '../dist/config.js';
import { EventStore } from '../dist/observation/store.js';
import { ActionTracker } from '../dist/correlation/actions.js';
import { QualityEngine } from '../dist/quality/engine.js';
import { normalizePath, pathMatches, endpointMatches, jsonPointer, shapeOf } from '../dist/util/paths.js';

const cfg = (raw = {}, opts = {}) => parseConfig(raw, { env: {}, ...opts });

// ------------------------------------------------------------------ privacy
test('network URLs lose credentials, fragments and query values; allowlisted parameters stay', () => {
  const r = new Redactor(); r.configure({ keepQueryParams: ['page'] });
  const out = r.networkUrl('https://user:pw@shop.test/api/track?token=CANARY-TOKEN-1&email=jane@example.com&page=2#frag');
  assert.equal(out, `https://shop.test/api/track?token=${MASK}&email=…&page=2`);
  assert.ok(!/CANARY|jane|user:pw|frag/.test(out));
});
test('a secret seen in a recognizable position is removed everywhere afterwards', () => {
  const r = new Redactor();
  r.networkUrl('https://shop.test/x?access_token=CANARY-TOKEN-9f3k2');
  assert.equal(r.text('console said CANARY-TOKEN-9f3k2 twice: CANARY-TOKEN-9f3k2'), `console said ${MASK} twice: ${MASK}`);
  assert.equal(r.knownOnly('goto /a?x=CANARY-TOKEN-9f3k2'), 'goto /a?x=CANARY-TOKEN-9f3k2', 'a value learned from the page never rewrites a flow');
  r.addSecret('user-supplied-secret', 'password');
  assert.equal(r.knownOnly('fill user-supplied-secret'), 'fill {{password}}', 'a bound placeholder does');
});
test('credential patterns in free text are masked; ordinary UI text survives', () => {
  const r = new Redactor();
  assert.equal(r.text('Authorization: Bearer CANARY-BEARER-77x1abc'), `Authorization: Bearer ${MASK}`);
  assert.equal(r.text('auth rejected for token CANARY-TOKEN-9f3k2'), `auth rejected for token ${MASK}`);
  assert.equal(r.text('GET /cb?api_key=abc123&x=1'), `GET /cb?api_key=${MASK}&x=1`);
  for (const ui of ['Basic information', 'Password confirmation', 'textbox "Password" [required]', 'Bearer shares are listed', 'Token expired yesterday', 'Secret Santa 2026 signup'])
    assert.equal(r.text(ui), ui, `must not change: ${ui}`);
});
test('headers and JSON: secret-named fields masked, the rest kept, structure bounded', () => {
  const r = new Redactor();
  assert.deepEqual(r.headers({ authorization: 'Bearer CANARY-BEARER-77x1', cookie: 'sid=abc', accept: 'application/json' }), { authorization: MASK, cookie: MASK, accept: 'application/json' });
  const j = r.json({ name: 'Jane', password: 'CANARY-PW-55z8', session: { token: 'CANARY-TOKEN-9f3k2' }, items: [{ pin: 1234, qty: 2 }] });
  assert.deepEqual(j, { name: 'Jane', password: MASK, session: { token: MASK }, items: [{ pin: MASK, qty: 2 }] });
  assert.ok(!JSON.stringify(j).includes('CANARY'));
  assert.equal(r.text('later: CANARY-PW-55z8'), `later: ${MASK}`, 'a masked JSON value is learned');
  const deep = {}; let cur = deep; for (let i = 0; i < 40; i++) { cur.n = {}; cur = cur.n; }
  assert.ok(JSON.stringify(r.json(deep)).length < 400, 'depth is bounded');
});
test('short values are not treated as secrets; page URLs keep ordinary query values', () => {
  const r = new Redactor();
  r.addSecret('wrong', 'password'); r.addSecret('secret123', 'password');
  assert.equal(r.text('something went wrong with secret123'), 'something went wrong with {{password}}');
  assert.equal(r.pageUrl('https://shop.test/orders?tab=open&reset_token=CANARY-RESET-1234'), `https://shop.test/orders?tab=open&reset_token=${MASK}`);
  assert.equal(r.pageUrl('https://shop.test/account'), 'https://shop.test/account');
});

// ------------------------------------------------------------------ config and presets
test('defaults: observe, metadata only, no enforcement, legacy TLS without a config file', () => {
  const c = cfg();
  assert.equal(c.mode, 'observe'); assert.equal(c.enforce, false); assert.equal(c.capture.payloads, 'off');
  assert.equal(c.capture.maxEvents, 2000); assert.equal(c.capture.maxBytes, 8 * 1024 * 1024); assert.equal(c.capture.maxBodyBytes, 16 * 1024);
  assert.equal(c.browser.ignoreHTTPSErrors, true); assert.equal(c.browser.legacyTls, true);
  assert.equal(c.strictLocators, false); assert.equal(c.discovery.enabled, false); assert.equal(c.artifacts.enabled, false);
});
test('a config file is secure by default for TLS; env and explicit settings override', () => {
  assert.equal(cfg({}, { fileExists: true }).browser.ignoreHTTPSErrors, false);
  assert.equal(cfg({ browser: { ignoreHTTPSErrors: true } }, { fileExists: true }).browser.ignoreHTTPSErrors, true);
  assert.equal(cfg({}, { fileExists: true, env: { FASTQA_IGNORE_HTTPS_ERRORS: 'true' } }).browser.ignoreHTTPSErrors, true);
  assert.equal(cfg({}, { env: { FASTQA_IGNORE_HTTPS_ERRORS: 'false' } }).browser.ignoreHTTPSErrors, false);
});
test('presets: strict enforces, discovery collects, debug captures only with an allowlist', () => {
  assert.equal(cfg({ quality: { mode: 'strict' } }).enforce, true);
  assert.equal(cfg({ quality: { mode: 'discovery' } }).discovery.enabled, true);
  const dbg = cfg({ quality: { mode: 'debug' } });
  assert.equal(dbg.capture.payloads, 'off'); assert.match(dbg.warnings.join(' '), /allowedOrigins/);
  assert.equal(cfg({ quality: { mode: 'debug' }, capture: { allowedOrigins: ['https://shop.test'] } }).capture.payloads, 'json');
  assert.equal(cfg({ quality: { mode: 'debug' }, capture: { payloads: 'off', allowedOrigins: ['https://shop.test'] } }).capture.payloads, 'off', 'explicit off wins over the preset');
});
test('precedence: run option > env > file; the capture deny rule cannot be weakened', () => {
  assert.equal(cfg({ quality: { mode: 'observe' } }, { mode: 'strict' }).mode, 'strict');
  assert.equal(cfg({ quality: { mode: 'observe' } }, { env: { FASTQA_QUALITY: 'off' } }).mode, 'off');
  const denied = cfg({ capture: { payloads: 'json', allowedOrigins: ['https://shop.test'] } }, { env: { FASTQA_CAPTURE: 'off' } });
  assert.equal(denied.capture.payloads, 'off');
});
test('invalid configuration is a clear error, never a silent fallback', () => {
  assert.throws(() => cfg({ qualty: {} }), (e) => e instanceof ConfigError && /qualty/.test(e.message));
  assert.throws(() => cfg({ quality: { mode: 'paranoid' } }), ConfigError);
  assert.throws(() => cfg({ capture: { payloads: 'json' } }), /allowedOrigins/);
  assert.throws(() => cfg({ quality: { expectedResponses: [{ path: '/api/orders', statuses: [422] }] } }), /scope|reason/, 'expected errors need a scope and a reason');
  assert.throws(() => cfg({ quality: { businessRules: [{ id: 'X', path: '/a', jsonPointer: '/ok' }] } }), /equals|exists/);
  assert.throws(() => cfg({ quality: { firstPartyOrigins: ['https://shop.test/path'] } }), /origin/);
  assert.throws(() => cfg({}, { env: { FASTQA_QUALITY: 'loud' } }), ConfigError);
});
test('the documented example configuration is valid', async () => {
  const { readFileSync } = await import('node:fs');
  const c = cfg(JSON.parse(readFileSync(new URL('../docs/config.example.json', import.meta.url), 'utf8')), { fileExists: true });
  assert.equal(c.capture.payloads, 'json'); assert.equal(c.strictLocators, true); assert.equal(c.businessRules[0].id, 'ORDER-SUCCESS');
  assert.equal(c.browser.ignoreHTTPSErrors, false); assert.equal(c.warnings.length, 0);
});
test('hard caps cannot be raised by configuration', () => {
  const c = cfg({ capture: { maxEvents: 10_000_000, maxBodyBytes: 50_000_000 } });
  assert.equal(c.capture.maxEvents, CAPS.maxEvents); assert.equal(c.capture.maxBodyBytes, CAPS.maxBodyBytes);
  assert.equal(c.warnings.length, 2);
});

// ------------------------------------------------------------------ event store
const obsEvent = (i, text = '') => ({ sessionId: 'S-1', action: { confidence: 'unattributed', reason: '' }, at: new Date().toISOString(), elapsedMs: i, kind: 'console_error', data: { text } });
test('event store: bounded by count, eviction is counted and evicted ids say so', () => {
  const s = new EventStore(5, 1e9);
  for (let i = 0; i < 12; i++) s.add(obsEvent(i));
  assert.equal(s.size, 5); assert.equal(s.dropped, 7);
  assert.equal(s.availability('E-1'), 'evicted'); assert.equal(s.availability('E-12'), 'available'); assert.equal(s.availability('E-99'), 'unknown');
  assert.equal(s.get('E-8').sequence, 8);
});
test('event store: bounded by bytes', () => {
  const s = new EventStore(1e6, 4000);
  for (let i = 0; i < 50; i++) s.add(obsEvent(i, 'x'.repeat(500)));
  assert.ok(s.bytes <= 4000, `bytes ${s.bytes}`); assert.ok(s.dropped > 40);
});

// ------------------------------------------------------------------ correlation
function tracker(windowMs = 1500) { let now = 0; const t = new ActionTracker(windowMs, () => now); return { t, at: (ms) => { now = ms; } }; }
const req = (key = 'GET http://x/api') => ({ endpointKey: key, mainFrameNavigation: false });
test('a request that starts during an interactive action is inferred to it', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  const a = t.beginAction('click', 'click "Save"'); at(10);
  const assoc = t.associate(req());
  assert.equal(assoc.actionId, a.actionId); assert.equal(assoc.confidence, 'inferred'); assert.match(assoc.reason, /during the action/);
});
test('the association is fixed at request start: a later action does not take it over', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  const a = t.beginAction('click', 'click "Submit"'); at(5);
  const assoc = t.associate(req()); t.hold(assoc);
  at(50); t.endAction(a, true);
  const b = t.beginAction('expect_text', 'expect_text "Saved"'); at(400); // response arrives while B runs
  assert.equal(assoc.actionId, a.actionId, 'still the starter');
  assert.notEqual(assoc.actionId, b.actionId);
});
test('passive steps never own a request: it goes to the latest interactive action inside the window', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  const a = t.beginAction('click', 'click "Go"'); at(20); t.endAction(a, true);
  t.beginAction('expect_text', 'expect_text "x"'); at(300);
  const assoc = t.associate(req());
  assert.equal(assoc.actionId, a.actionId); assert.match(assoc.reason, /280ms after the action ended/);
});
test('outside the window nothing is blamed: unattributed, and repeated starts mark the endpoint as background', () => {
  const { t, at } = tracker(1000); t.beginBatch('act');
  const a = t.beginAction('click', 'click "Go"'); at(10); t.endAction(a, true);
  at(5000); assert.equal(t.associate(req('GET http://x/poll')).confidence, 'unattributed');
  at(6000); assert.equal(t.associate(req('GET http://x/poll')).confidence, 'unattributed');
  const b = t.beginAction('click', 'click "Other"'); at(6100); t.executed(b); at(6400); // in the settle phase of the click
  const during = t.associate(req('GET http://x/poll'));
  assert.equal(during.confidence, 'ambiguous'); assert.deepEqual(during.candidateActionIds, [b.actionId]); assert.match(during.reason, /background traffic/);
  assert.equal(t.associate(req('GET http://x/other')).confidence, 'inferred', 'other endpoints are unaffected');
});
test('overlap: an earlier action with a request still in flight makes the next start ambiguous', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  const a = t.beginAction('click', 'click "A"'); at(5); t.hold(t.associate(req('POST http://x/slow'))); at(100); t.endAction(a, true);
  const b = t.beginAction('click', 'click "B"'); at(150);
  const amb = t.associate(req('GET http://x/b'));
  assert.equal(amb.confidence, 'ambiguous'); assert.deepEqual(amb.candidateActionIds, [b.actionId, a.actionId]); assert.equal(amb.actionId, undefined);
  t.release({ actionId: a.actionId, confidence: 'inferred', reason: '' }); at(200);
  assert.equal(t.associate(req('GET http://x/b2')).confidence, 'inferred', 'once A has nothing in flight, B is unambiguous again');
});
test('periodic traffic: four starts at a steady rhythm stop being blamed on the running action', () => {
  const { t, at } = tracker(); t.beginBatch('act');
  const a = t.beginAction('click', 'click "Place order"'); at(10); t.executed(a); // the click returned; polls land in its settle phase
  const seen = [];
  for (let i = 0; i < 6; i++) { at(200 + i * 200); seen.push(t.associate(req('GET http://x/api/poll')).confidence); }
  assert.deepEqual(seen, ['inferred', 'inferred', 'inferred', 'ambiguous', 'ambiguous', 'ambiguous']);
  at(1400); const p = t.associate(req('GET http://x/api/poll'));
  assert.match(p.reason, /fires periodically \(about every 2\d\dms\)/); assert.deepEqual(p.candidateActionIds, [a.actionId]);
  // irregular repeats of a user-driven call are not periodic
  for (const ms of [2000, 2250, 3100, 3200]) { at(ms); assert.equal(t.associate(req('POST http://x/api/cart')).confidence, 'inferred'); }
});
test('direct is reserved for the navigation a goto asked for, once', () => {
  const { t, at } = tracker(); t.beginBatch('open');
  const g = t.beginAction('goto', 'goto "/x"'); at(1);
  const nav = t.associate({ endpointKey: 'GET http://x/x', mainFrameNavigation: true });
  assert.equal(nav.confidence, 'direct'); assert.equal(nav.actionId, g.actionId);
  assert.equal(t.associate({ endpointKey: 'GET http://x/y', mainFrameNavigation: true }).confidence, 'inferred', 'a second navigation is not claimed as direct');
  t.endAction(g, true);
  const c = t.beginAction('click', 'click "Link"');
  assert.equal(t.associate({ endpointKey: 'GET http://x/z', mainFrameNavigation: true }).confidence, 'inferred', 'a click that navigates is temporal, not direct');
  assert.equal(c.requests, 1);
});

// ------------------------------------------------------------------ paths
test('path normalization is conservative; explicit templates win', () => {
  assert.equal(normalizePath('/api/orders/123'), '/api/orders/{id}');
  assert.equal(normalizePath('/api/users/3f2b8c1e-9a4d-4e7b-8f1a-2b3c4d5e6f70/avatar'), '/api/users/{uuid}/avatar');
  assert.equal(normalizePath('/assets/app.9f8e7d6c5b4a39281706.js'), '/assets/app.9f8e7d6c5b4a39281706.js');
  assert.equal(normalizePath('/api/products/blue-shirt'), '/api/products/blue-shirt', 'a slug is not guessed to be an id');
  assert.equal(normalizePath('/api/products/blue-shirt', ['/api/products/{slug}']), '/api/products/{slug}');
  assert.ok(pathMatches('/api/orders/{id}', '/api/orders/77')); assert.ok(!pathMatches('/api/orders/{id}', '/api/orders/77/items'));
  assert.ok(pathMatches('/api/**', '/api/a/b/c')); assert.ok(endpointMatches({ method: 'post', path: '/api/orders' }, 'POST', '/api/orders'));
  assert.ok(!endpointMatches({ method: 'GET', path: '/api/orders' }, 'POST', '/api/orders'));
});
test('json pointer and shapes: shapes carry names and types, never values', () => {
  assert.deepEqual(jsonPointer({ a: { 'b/c': [1, null] } }, '/a/b~1c/1'), { found: true, value: null });
  assert.deepEqual(jsonPointer({ a: 1 }, '/missing'), { found: false });
  const shape = shapeOf({ id: 7, email: 'jane.canary@example.com', tags: ['x'], nested: { ok: true, none: null } });
  assert.deepEqual(shape, { id: 'number', email: 'string', tags: ['string'], nested: { ok: 'boolean', none: 'null' } });
  assert.ok(!JSON.stringify(shape).includes('canary'));
});

// ------------------------------------------------------------------ rules, deduplication and policy
let rid = 0;
const rec = (o = {}) => ({ id: `R-${++rid}`, method: 'POST', url: 'http://shop.test/api/orders', origin: 'http://shop.test', path: '/api/orders', route: '/api/orders', resourceType: 'fetch', firstParty: true, tracked: true, navigation: false, association: { actionId: 'A-1', confidence: 'inferred', reason: 'request started during the action' }, batchId: 'B-1', startedMs: 0, eventIds: [], done: false, ...o });
const engine = (raw = {}, scope = undefined, opts = {}) => new QualityEngine(cfg(raw, opts), { scopeOf: () => scope, currentBatchId: () => 'B-1', describeAction: () => '', isReported: () => false });
test('NET-5XX: high candidate; confidence follows the association; third-party traffic is not flagged', () => {
  const e = engine();
  e.onResponse(rec({ status: 500 }));
  e.onResponse(rec({ status: 503, association: { confidence: 'unattributed', reason: 'background' }, path: '/api/poll', route: '/api/poll' }));
  e.onResponse(rec({ status: 500, firstParty: false, origin: 'https://cdn.test' }));
  assert.equal(e.findings.length, 2);
  assert.deepEqual(e.findings.map((f) => [f.ruleId, f.severity, f.confidence, f.status]), [['NET-5XX', 'high', 'medium', 'candidate'], ['NET-5XX', 'high', 'low', 'candidate']]);
});
test('deduplication: same rule + endpoint + signature is one finding with a count; ids differ by status', () => {
  const e = engine();
  for (let i = 0; i < 5; i++) e.onResponse(rec({ status: 500, path: `/api/orders/${i}`, route: '/api/orders/{id}' }));
  e.onResponse(rec({ status: 502, path: '/api/orders/9', route: '/api/orders/{id}' }));
  assert.equal(e.findings.length, 2); assert.equal(e.findings[0].occurrences, 5); assert.equal(e.findings[0].requestIds.length, 5);
  const { fresh, recurring } = e.takeNew();
  assert.equal(fresh.length, 2); assert.equal(recurring.length, 0);
  const again = e.takeNew(); assert.equal(again.fresh.length + again.recurring.length, 0, 'nothing happened since: nothing is listed again');
});
test('NET-4XX: 401/403 informational, other 4xx low; favicon ignored', () => {
  const e = engine();
  e.onResponse(rec({ status: 401, path: '/api/me', route: '/api/me' })); e.onResponse(rec({ status: 422 })); e.onResponse(rec({ status: 404, path: '/favicon.ico', route: '/favicon.ico' }));
  assert.deepEqual(e.findings.map((f) => f.severity), ['info', 'low']);
});
test('expected responses need a matching scope; nothing is suppressed globally', () => {
  const policy = { quality: { expectedResponses: [{ method: 'POST', path: '/api/orders', statuses: [422], scope: 'invalid-order-test', reason: 'Negative validation test' }] } };
  const inScope = engine(policy, 'invalid-order-test'); inScope.onResponse(rec({ status: 422 }));
  assert.equal(inScope.findings[0].status, 'expected'); assert.match(inScope.findings[0].statusReason, /Negative validation test/);
  const other = engine(policy, 'checkout'); other.onResponse(rec({ status: 422 }));
  assert.equal(other.findings[0].status, 'candidate', 'the same response in another scope is still a candidate');
  const wrongStatus = engine(policy, 'invalid-order-test'); wrongStatus.onResponse(rec({ status: 500 }));
  assert.equal(wrongStatus.findings[0].status, 'candidate');
});
test('an explicit assertion marks one response expected; a second, unexpected one keeps the finding a candidate', () => {
  const e = engine();
  const a = rec({ status: 422 }); const b = rec({ status: 422 });
  e.onResponse(a); e.markExpected(a.id, 'explicit expect_request POST /api/orders 422');
  assert.equal(e.findings[0].status, 'expected');
  e.onResponse(b);
  assert.equal(e.findings[0].status, 'candidate'); assert.match(e.findings[0].statusReason, /1 expected of 2 occurrences/);
  e.markExpected(a.id, 'again'); assert.equal(e.findings[0].expectedOccurrences, 1, 'marking twice counts once');
});
test('suppressions name what they suppress, stay visible and expire', () => {
  const s = (expires) => ({ quality: { suppressions: [{ id: 'BUG-12', ruleId: 'NET-5XX', path: '/api/orders', reason: 'known, fix in progress', expires }] } });
  const live = engine(s('2999-01-01')); live.onResponse(rec({ status: 500 }));
  assert.equal(live.findings[0].status, 'suppressed'); assert.match(live.findings[0].statusReason, /BUG-12/);
  assert.equal(live.candidates().length, 0); assert.equal(live.findings.length, 1, 'the fact is kept');
  const expired = engine(s('2020-01-01')); expired.onResponse(rec({ status: 500 }));
  assert.equal(expired.findings[0].status, 'candidate');
  const vague = engine({ quality: { suppressions: [{ id: 'ALL', reason: 'hide everything' }] } }); vague.onResponse(rec({ status: 500 }));
  assert.equal(vague.findings[0].status, 'candidate', 'a suppression without a rule or a path suppresses nothing');
});
test('business rule: evaluated only with a captured body; otherwise recorded as not evaluated', () => {
  const rules = { quality: { businessRules: [{ id: 'ORDER-SUCCESS', method: 'POST', path: '/api/orders', status: 200, jsonPointer: '/success', equals: true }] } };
  const e = engine(rules);
  const bad = rec({ status: 200, body: { state: 'captured', bytes: 40, json: { success: false, error: 'OUT_OF_STOCK' } } });
  e.onBody(bad, { success: false, error: 'OUT_OF_STOCK' });
  assert.equal(e.findings[0].ruleId, 'BUSINESS-ERROR'); assert.equal(e.findings[0].severity, 'high'); assert.match(e.findings[0].title, /HTTP 200 but \/success = false/);
  e.onBody(rec({ status: 200, body: { state: 'captured' } }), { success: true }); assert.equal(e.findings.length, 1, 'a passing response is not a finding');
  e.onBody(rec({ status: 201, body: { state: 'captured' } }), { success: false }); assert.equal(e.findings.length, 1, 'the rule is scoped to its status');
  const off = engine(rules); off.onBody(rec({ status: 200, body: { state: 'skipped', reason: 'capture-off' } }));
  assert.equal(off.findings.length, 0); assert.match(off.notEvaluated.get('ORDER-SUCCESS').reason, /capture-off/);
});
test('transport failures, aborts, exceptions and console errors', () => {
  const e = engine();
  e.onFailed(rec({ failure: 'net::ERR_CONNECTION_RESET' })); e.onFailed(rec({ failure: 'net::ERR_ABORTED', aborted: true }));
  const ev = (kind, data) => ({ eventId: 'E-1', sequence: 1, at: '', batchId: 'B-1', kind, data, action: { actionId: 'A-1', confidence: 'inferred', reason: '' } });
  e.onPageError(ev('page_error', { message: 'x is not defined at line 12' })); e.onPageError(ev('page_error', { message: 'x is not defined at line 99' }));
  e.onConsoleError(ev('console_error', { text: 'Failed to load resource: 500' })); e.onConsoleError(ev('console_error', { text: 'boom' }));
  assert.deepEqual(e.findings.map((f) => [f.ruleId, f.severity, f.occurrences]), [['NET-FAIL', 'medium', 1], ['JS-EXCEPTION', 'medium', 2], ['CONSOLE-ERROR', 'low', 1]]);
});
test('performance rules are off until configured; thresholds and call limits then apply', () => {
  const none = engine(); none.onFinished(rec({ status: 200, endedMs: 9000 })); assert.equal(none.findings.length, 0);
  const e = engine({ quality: { performance: { slowMs: 500, endpoints: [{ path: '/api/slow', maxMs: 100 }], maxCalls: [{ path: '/api/prices', max: 2, per: 'action' }] } } });
  e.onFinished(rec({ status: 200, endedMs: 400 })); e.onFinished(rec({ status: 200, endedMs: 700 })); e.onFinished(rec({ status: 200, endedMs: 300, path: '/api/slow', route: '/api/slow' }));
  assert.deepEqual(e.findings.map((f) => f.title), ['POST /api/orders took 700ms (limit 500ms)', 'POST /api/slow took 300ms (limit 100ms)']);
  for (let i = 0; i < 4; i++) e.onRequestStart(rec({ path: '/api/prices', route: '/api/prices', method: 'GET' }));
  assert.equal(e.findings.filter((f) => f.ruleId === 'PERF-CALLS').length, 1); assert.match(e.findings.at(-1).title, /more than 2× in one action/);
});
test('policy: observe never enforces; strict fails on severity, on incomplete finalization, and is provisional while requests are pending', () => {
  const obs = engine(); obs.onResponse(rec({ status: 500 }));
  assert.equal(obs.policy({ pending: 0, dropped: 0, final: true }).outcome, 'not_enforced');
  const strict = engine({ quality: { mode: 'strict' } });
  assert.equal(strict.policy({ pending: 0, dropped: 0, final: true }).outcome, 'passed');
  assert.equal(strict.policy({ pending: 1, dropped: 0, final: false }).outcome, 'provisional');
  assert.equal(strict.policy({ pending: 1, dropped: 0, final: true }).outcome, 'failed', 'incomplete observation fails strict by default');
  strict.onResponse(rec({ status: 422 })); assert.equal(strict.policy({ pending: 0, dropped: 0, final: true }).outcome, 'passed', 'a low finding is below failOnSeverity high');
  strict.onResponse(rec({ status: 500 })); assert.equal(strict.policy({ pending: 0, dropped: 0, final: true }).outcome, 'failed');
  const lenient = engine({ quality: { mode: 'strict', onIncomplete: 'ignore', failOnSeverity: 'low' } });
  assert.equal(lenient.policy({ pending: 3, dropped: 0, final: true }).outcome, 'passed');
  lenient.onResponse(rec({ status: 422 })); assert.equal(lenient.policy({ pending: 0, dropped: 0, final: true }).outcome, 'failed');
});
test('mode off evaluates nothing', () => {
  const e = engine({}, undefined, { mode: 'off' }); e.onResponse(rec({ status: 500 }));
  assert.equal(e.findings.length, 0);
});

// ------------------------------------------------------------------ test tooling (platform independence, CI output)
test('baseline comparison ignores the platform path separator below the data directory', async () => {
  const { slashes } = await import('./capture-baseline.mjs');
  assert.equal(slashes('Saved 12 steps to <FASTQA_DIR>\\flows\\legacy-shop.json'), 'Saved 12 steps to <FASTQA_DIR>/flows/legacy-shop.json');
  assert.equal(slashes("open '<FASTQA_DIR>\\flows\\no-such-flow.json'"), "open '<FASTQA_DIR>/flows/no-such-flow.json'");
  assert.equal(slashes('report: <FASTQA_DIR>/reports/<stamp>.html'), 'report: <FASTQA_DIR>/reports/<stamp>.html', 'already forward slashes: unchanged');
  assert.equal(slashes('fill "Path" "C:\\temp\\x"'), 'fill "Path" "C:\\temp\\x"', 'other backslashes are content and stay');
});
test('CI annotations: each failed check becomes one error, with its detail, and the log tail is kept', async () => {
  const { failures, commands } = await import('./ci-annotate.mjs');
  const log = [
    'ok   first check', 'FAIL second check', '     --- 0.3.2 ---', '     a\\b', '     --- now ---', '     a/b', 'ok   third check',
    '', '=== FAIL login page (12ms, 40 chars)', 'title: 100% wrong', '', '=== OK   next call',
    'not ok 4 - a unit test', '  ---', "  error: 'boom'", '  ...', 'ok 5 - another', '', 'compat: 1 of 50 FAILED',
  ].join('\n');
  const f = failures(log);
  assert.equal(f.total, 4);
  assert.equal(f.blocks[0], 'FAIL second check\n     --- 0.3.2 ---\n     a\\b\n     --- now ---\n     a/b');
  assert.equal(f.blocks[1], '=== FAIL login page (12ms, 40 chars)\ntitle: 100% wrong');
  assert.match(f.blocks[2], /^not ok 4 - a unit test\n {2}---\n {2}error: 'boom'/);
  assert.equal(f.blocks[3], 'compat: 1 of 50 FAILED');
  const cmds = commands(log);
  assert.equal(cmds.length, 5, 'four errors and the tail');
  assert.equal(cmds[0], '::error title=FAIL second check::FAIL second check%0A     --- 0.3.2 ---%0A     a\\b%0A     --- now ---%0A     a/b');
  assert.ok(cmds[1].startsWith('::error title==== FAIL login page (12ms%2C 40 chars)::') && cmds[1].includes('100%25 wrong'), cmds[1]);
  assert.ok(cmds[4].startsWith('::notice title=Last lines of the test log::') && cmds[4].endsWith('%0Acompat: 1 of 50 FAILED'), cmds[4]);
  assert.ok(cmds.every((c) => !c.includes('\n')), 'one line per command');
  const many = commands(Array.from({ length: 14 }, (_, i) => `FAIL check ${i}`).join('\n'));
  assert.equal(many.filter((c) => c.startsWith('::error')).length, 9, 'GitHub shows ten errors per step at most');
  assert.ok(many.some((c) => c.startsWith('::warning title=5 earlier failure(s) not shown')) && many[0].includes('FAIL check 5'));
  assert.deepEqual(commands('ok   everything\nall 3 checks passed').map((c) => c.split('::')[1]), ['notice title=Last lines of the test log']);
  const quoted = failures(['=== OK   flow run with a wrong password', '0/1 flows passed', 'FAIL add-to-cart (5709ms)', '    5. ✗ expect_url "/account"', '', 'ALL CHECKS PASSED', 'FAIL a real check', '     why'].join('\n'));
  assert.deepEqual(quoted.blocks, ['FAIL a real check\n     why'], 'a failing flow quoted inside a passing check is not a failure');
});
