// Policy and profiles (FQA-005/006), contract, performance and state rules (FQA-010/011), through MCP and the CLI.
import { readFileSync, mkdirSync, writeFileSync, copyFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('policy');
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];
const negative = [{ do: 'fill', target: 'Quantity', value: '0' }, { do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Quantity must be at least 1' }];
const flowFile = (dir, name, query, extra = []) => {
  mkdirSync(path.join(dir, 'flows'), { recursive: true });
  writeFileSync(path.join(dir, 'flows', `${name}.json`), JSON.stringify({ name, created: '2026-11-27T00:00:00.000Z', schema: 2, steps: [{ do: 'goto', value: `{{base}}/orders?${query}` }, ...place, ...extra] }, null, 2));
};
const newDir = (p) => mkdtempSync(path.join(tmpdir(), p));

// ---------------------------------------------------------------- 1. expected errors are explicit and scoped; suppressions stay visible
{
  const s = await connect({ prefix: 'fq-pol-1-', config: { quality: {
    expectedResponses: [{ method: 'POST', path: '/api/orders', statuses: [422], scope: 'invalid-order-test', reason: 'Negative validation test' }],
    suppressions: [{ id: 'BUG-12', ruleId: 'NET-5XX', path: '/api/notifications', reason: 'known: notification service is being replaced', expires: '2999-01-01' }],
  } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  let out = await call('act', { steps: negative, scope: 'invalid-order-test' });
  has('expected 422 inside its scope: clean, steps pass', out, /^PASSED 3\/3/, 'QA: clean');
  out = await call('evidence', { view: 'findings', status: 'expected' });
  has('the expected response is kept with its reason', out, 'NET-4XX expected (policy (invalid-order-test): Negative validation test)');
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  out = await call('act', { steps: negative });
  has('the same 422 outside the scope is still a candidate', out, /LOW NET-4XX POST \/api\/orders returned 422/);
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  out = await call('act', { steps: [...negative, { do: 'expect_request', target: 'POST /api/orders', value: '2xx', timeout: 300 }], scope: 'invalid-order-test' });
  has('a policy never overrides a conflicting explicit assertion', out, /^FAILED at step 4\/4/, 'status not 2xx');
  await call('open', { url: `${base}/orders?notify=500`, fresh: true });
  out = await call('act', { steps: place });
  has('suppressed known issue: not a candidate', out, 'QA: clean');
  out = await call('evidence', { view: 'summary' });
  has('suppressed known issue: counted, not erased', out, /findings: 0 candidate · 0 expected · 1 suppressed/);
  out = await call('evidence', { view: 'findings', status: 'suppressed' });
  has('suppressed known issue: visible with its id and reason', out, 'NET-5XX suppressed (known issue BUG-12: known: notification service is being replaced)');
  await s.close();
}

// ---------------------------------------------------------------- 2. strict mode in an interactive session
{
  const s = await connect({ prefix: 'fq-pol-2-', config: { quality: { mode: 'strict' } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=500`, fresh: true });
  let out = await call('act', { steps: place });
  has('strict act: steps keep their own result, the policy outcome is separate', out, /^PASSED 2\/2 steps/, 'QA policy (strict): FAILED — 1 finding(s) at or above "high"');
  out = await call('act', { steps: [{ do: 'expect_text', value: 'Thank you' }] });
  has('strict act: a clean batch passes the policy', out, 'QA: clean', 'QA policy (strict): passed');
  await call('open', { url: `${base}/orders?notify=500&notifyDelay=4200`, fresh: true });
  out = await call('act', { steps: place });
  has('strict act: provisional while a request is still pending (no retroactive verdict)', out, /QA policy \(strict\): provisional — 1 request\(s\) still pending/);
  out = await call('act', { steps: [{ do: 'wait', value: '2600' }] });
  has('strict act: the late failure fails the policy at the next call', out, 'late · ', 'QA policy (strict): FAILED');
  await s.close();
}

// ---------------------------------------------------------------- 3. replay: observe never changes results; strict fails the run, same in MCP and CLI
{
  const dir = newDir('fq-pol-3-');
  flowFile(dir, 'hidden', 'notify=500');
  flowFile(dir, 'healthy', 'notify=200');
  flowFile(dir, 'late', 'notify=500&notifyDelay=1200');
  flowFile(dir, 'hanging', 'hang=1&notify=off');
  const env = { FASTQA_DIR: dir };
  const s = await connect({ dir });
  let out = await s.call('flow', { action: 'run', name: 'hidden', vars: { base } });
  has('MCP replay, observe: the flow passes and the finding is reported', out, /^1\/1 flows passed\nPASS hidden/, /F-001 HIGH NET-5XX POST \/api\/notifications returned 500 — A-\d+ click "Place order" \(inferred\)/, /session S-\w+/);
  const sid = /session (S-\w+)/.exec(out)?.[1];
  const mcpLine = /F-001 HIGH NET-5XX[^—]+/.exec(out)?.[0];
  out = await s.call('evidence', { view: 'findings', session: sid, details: true });
  has('a finished replay can be inspected by its session id', out, 'F-001', '/api/notifications', 'request started');
  out = await s.call('flow', { action: 'run', name: 'hidden', vars: { base }, mode: 'strict' });
  has('MCP replay, strict: the flow fails on the policy, steps stay green', out, /^0\/1 flows passed\nFAIL hidden/, '✓ click "Place order"', '✗ QA policy (strict) — 1 finding(s) at or above "high"');
  out = await s.call('flow', { action: 'run', name: 'healthy', vars: { base }, mode: 'strict' });
  has('MCP replay, strict: a healthy flow passes', out, /^1\/1 flows passed/);
  await s.close();

  let r = await cli(`run hidden --var=base=${base}`, env);
  has('CLI observe: exit 0, finding printed', `exit=${r.code}\n${r.stdout}`, 'exit=0', 'PASS hidden', 'F-001 HIGH NET-5XX POST /api/notifications returned 500', '1/1 passed');
  check('CLI and MCP report the same finding', !!mcpLine && r.stdout.includes(mcpLine), `${mcpLine}\n---\n${r.stdout}`);
  let junit = readFileSync(path.join(dir, 'reports', 'latest.junit.xml'), 'utf8');
  has('JUnit observe: no failure, findings in system-out', junit, 'failures="0"', '<system-out>qa: 1 candidate finding(s)', 'NET-5XX POST /api/notifications returned 500');
  lacks('JUnit observe: legacy pass semantics kept', junit, '<failure');
  r = await cli(`run hidden --var=base=${base} --mode=strict`, env);
  has('CLI strict: exit 1 with the policy reason', `exit=${r.code}\n${r.stdout}`, 'exit=1', 'FAIL hidden', '✗ QA policy (strict) — 1 finding(s) at or above "high"', '0/1 passed');
  junit = readFileSync(path.join(dir, 'reports', 'latest.junit.xml'), 'utf8');
  has('JUnit strict: a policy failure is its own failure type', junit, 'failures="1"', '<failure message="QA policy (strict): 1 finding(s) at or above &quot;high&quot;" type="fastqa.policy">');
  const html = readFileSync(path.join(dir, 'reports', 'latest.html'), 'utf8');
  has('HTML: steps and QA findings are separate sections', html, 'Steps and assertions <span class="ms">all passed</span>', 'QA findings', 'leads to verify, not confirmed defects', 'QA policy (strict): FAILED');
  r = await cli(`run hidden --var=base=${base} --mode=off`, env);
  has('CLI off: exit 0', `exit=${r.code}`, 'exit=0');
  lacks('CLI off: nothing is evaluated', r.stdout, 'QA', 'F-001');
  r = await cli(`run late --var=base=${base} --mode=strict`, env);
  has('strict finalization: a failure that arrives after the last step still fails the run', `exit=${r.code}\n${r.stdout}`, 'exit=1', 'NET-5XX POST /api/notifications returned 500');
  r = await cli(`run late --var=base=${base}`, env);
  has('observe never waits for late responses and never fails on them', `exit=${r.code}`, 'exit=0');

  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quality: { finalizeTimeoutMs: 700 }, browser: { ignoreHTTPSErrors: true } }));
  const t0 = Date.now();
  r = await cli(`run hanging --var=base=${base} --mode=strict`, env);
  has('strict + a request that never completes: fails as incomplete, with the reason', `exit=${r.code}\n${r.stdout}`, 'exit=1', 'observation incomplete: 1 request(s) still pending at finalization');
  check('strict finalization is bounded (no network-idle wait)', Date.now() - t0 < 12000, `${Date.now() - t0}ms`);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quality: { finalizeTimeoutMs: 700, onIncomplete: 'ignore' }, browser: { ignoreHTTPSErrors: true } }));
  r = await cli(`run hanging --var=base=${base} --mode=strict`, env);
  has('onIncomplete: ignore lets an incomplete strict run pass, still marked partial', `exit=${r.code}\n${r.stdout}`, 'exit=0', 'coverage partial');

  // ---- configuration errors stop a run before the browser starts
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quality: { mode: 'strict', failOnSeverty: 'low' } }));
  r = await cli(`run healthy --var=base=${base}`, env);
  has('CLI: invalid config is exit 2 with the offending key', `exit=${r.code}\n${r.stderr}`, 'exit=2', 'Configuration error', 'failOnSeverty');
  r = await cli('config', env);
  has('`fastqa-mcp config` validates too', `exit=${r.code}\n${r.stderr}`, 'exit=2', 'failOnSeverty');
  const bad = await connect({ dir });
  out = await bad.call('open', { url: `${base}/login` });
  has('MCP: invalid config is a clear tool result, not a crash', out, /^Configuration error: Invalid .*config\.json/, 'failOnSeverty');
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quality: { mode: 'strict' } }));
  out = await bad.call('open', { url: `${base}/login` });
  has('MCP: works again once the file is fixed', out, 'title: Login');
  await bad.close();
  r = await cli('config', env);
  has('`fastqa-mcp config` prints the effective configuration', r.stdout, '"mode": "strict"', '"enforce": true', '"payloads": "off"', '"ignoreHTTPSErrors": false');
}

// ---------------------------------------------------------------- 4. contract, performance and state rules: all opt-in
{
  const dir = newDir('fq-pol-4-');
  mkdirSync(path.join(dir, 'contracts'), { recursive: true });
  copyFileSync('bench/fixtures/openapi-shop.json', path.join(dir, 'contracts', 'shop.json'));
  const quality = {
    contracts: [{ spec: 'contracts/shop.json' }, { spec: 'contracts/missing.json' }],
    performance: { endpoints: [{ path: '/api/slow', maxMs: 300 }], maxCalls: [{ path: '/api/prices', max: 1, per: 'action' }] },
    stateRules: [{ id: 'ORDER-ROW', after: { method: 'POST', path: '/api/orders', status: 201 }, expectText: 'Order ORD-1001', withinMs: 600 }],
  };
  const s = await connect({ dir, config: { quality, capture: { payloads: 'json', allowedOrigins: [base] } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  let out = await call('act', { steps: place });
  has('contract: a documented response that matches is clean', out, 'QA: clean');
  check('contract: an unusable document is a warning, the session goes on', /contract "contracts\/missing\.json"/.test(s.stderr.join('')), s.stderr.join(''));
  await call('open', { url: `${base}/orders?notify=off&order=contract`, fresh: true });
  out = await call('act', { steps: place });
  has('contract: schema mismatch is a candidate that names paths and types, not values', out, /MEDIUM CONTRACT-SCHEMA POST \/api\/orders: response body does not match the schema: .*\/orderId must be string/, '/total must be number');
  lacks('contract: no response value in the finding', out.split('\n').find((l) => l.includes('CONTRACT-SCHEMA')) ?? '', '1001', '19.99');
  await call('open', { url: `${base}/orders?notify=off&order=undoc`, fresh: true });
  out = await call('act', { steps: place });
  has('contract: an undocumented status is a candidate', out, /MEDIUM CONTRACT-STATUS POST \/api\/orders: .*202/);
  await call('open', { url: `${base}/orders?notify=500`, fresh: true });
  out = await call('act', { steps: place });
  has('contract: a server error is reported once, as NET-5XX', out, 'QA: 1 new candidate finding', 'NET-5XX');
  lacks('contract: no duplicate "undocumented 500"', out, 'CONTRACT-STATUS');
  await call('open', { url: `${base}/orders?notify=off&ghost=1`, fresh: true });
  out = await call('act', { steps: place });
  has('state rule: success response but the expected row never appears', out, /MEDIUM STATE-INVARIANT ORDER-ROW: after POST \/api\/orders → 201, text "Order ORD-1001" did not appear within 600ms/);
  await call('open', { url: `${base}/orders?notify=off&slow=700`, fresh: true });
  out = await call('act', { steps: [{ do: 'click', target: 'Load history' }, { do: 'expect_text', value: 'History loaded' }] });
  has('performance: a response over its configured limit is a low candidate with the measured time', out, /LOW PERF-SLOW GET \/api\/slow took \d{3,4}ms \(limit 300ms\)/);
  out = await call('act', { steps: [{ do: 'click', target: 'Refresh prices' }, { do: 'expect_text', value: 'Prices updated' }] });
  has('performance: more calls than the configured limit in one action', out, /LOW PERF-CALLS GET \/api\/prices called more than 1× in one action/);
  await s.close();

  // without capture the schema check is not evaluated (and says so); status checks still work
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ quality: { contracts: [{ spec: 'contracts/shop.json' }] }, browser: { ignoreHTTPSErrors: true } }));
  const n = await connect({ dir });
  await n.call('open', { url: `${base}/orders?notify=off&order=contract`, fresh: true });
  out = await n.call('act', { steps: place });
  lacks('contract without capture: no schema finding is invented', out, 'CONTRACT-SCHEMA');
  out = await n.call('evidence', { view: 'summary' });
  has('contract without capture: recorded as not evaluated', out, /not evaluated: CONTRACT-SCHEMA — response body not available \(capture-off\)/);
  await n.close();

  // defaults: none of these rules exist until configured
  const d = await connect({ prefix: 'fq-pol-4d-' });
  await d.call('open', { url: `${base}/orders?notify=off&ghost=1&slow=700&order=contract`, fresh: true });
  out = await d.call('act', { steps: [...place, { do: 'click', target: 'Load history' }, { do: 'expect_text', value: 'History loaded' }] });
  has('defaults: slow, contract and state rules are off', out, 'QA: clean');
  await d.close();
}

// ---------------------------------------------------------------- 5. baselines: recorded explicitly, compared only with enough samples
{
  const dir = newDir('fq-pol-5-');
  mkdirSync(path.join(dir, 'flows'), { recursive: true });
  writeFileSync(path.join(dir, 'flows', 'history.json'), JSON.stringify({ name: 'history', created: '2026-11-27T00:00:00.000Z', schema: 2, steps: [
    { do: 'goto', value: '{{base}}/orders?notify=off&slow={{slow}}' }, { do: 'click', target: 'Load history' }, { do: 'expect_text', value: 'History loaded' }] }));
  const env = { FASTQA_DIR: dir };
  let r = await cli(`run history --var=base=${base} --var=slow=60 --baseline=record --repeat=2`, env);
  has('baseline: too few samples are not recorded', r.stdout, /baseline: recorded 0 endpoints/, /skipped \(fewer than 5 samples; use --repeat\): GET \/api\/slow \(2\)/);
  r = await cli(`run history --var=base=${base} --var=slow=60 --baseline=record --repeat=5`, env);
  // since 1.1 a baseline is scoped: origin, environment label, device, role label (schema 2)
  const scope = `${base} | env unknown | desktop | role unknown`;
  has('baseline: recorded from 5 runs, for its scope', `exit=${r.code}\n${r.stdout}`, 'exit=0', `baseline: recorded 1 endpoint for ${scope} to`, '5/5 passed');
  const file = JSON.parse(readFileSync(path.join(dir, 'baselines', 'perf.json'), 'utf8'));
  const e = file.scopes?.[scope]?.entries['GET /api/slow'];
  check('baseline file: median and p95 per endpoint, per scope, with the machine', file.schemaVersion === 2 && e?.samples === 5 && e.medianMs >= 50 && /node/.test(file.scopes[scope].machine), JSON.stringify(file));
  r = await cli(`run history --var=base=${base} --var=slow=60 --baseline=check`, env);
  lacks('baseline check: a normal run is clean', r.stdout, 'PERF-BASELINE');
  r = await cli(`run history --var=base=${base} --var=slow=900 --baseline=check`, env);
  has('baseline check: a much slower response is a low candidate with both numbers', r.stdout, /LOW PERF-BASELINE GET \/api\/slow took \d+ms, baseline median \d+ms/);
  r = await cli(`run history --var=base=${base} --var=slow=900 --baseline=check --env=prod`, env);
  lacks('baseline check: another environment label is another scope, never compared', r.stdout, 'PERF-BASELINE');
  r = await cli(`run history --var=base=${base} --var=slow=900`, env);
  lacks('baseline is only compared when asked', r.stdout, 'PERF-BASELINE');
  // migration: a 1.0 file (schema 1, no scope) is still compared, with a warning; recording keeps it as "legacy"
  writeFileSync(path.join(dir, 'baselines', 'perf.json'), JSON.stringify({ schemaVersion: 1, recordedAt: '2026-11-01T00:00:00.000Z', environment: 'win32 x64 node v24', note: 'old', entries: { 'GET /api/slow': { samples: 5, medianMs: 60, p95Ms: 70 } } }));
  r = await cli(`run history --var=base=${base} --var=slow=900 --baseline=check`, env);
  has('legacy 1.0 baseline: still compared, with a warning that it has no scope', `${r.stdout}\n${r.stderr}`, /PERF-BASELINE GET \/api\/slow/, /recorded by 1\.0 without a scope/);
  r = await cli(`run history --var=base=${base} --var=slow=60 --baseline=record --repeat=5`, env);
  const migrated = JSON.parse(readFileSync(path.join(dir, 'baselines', 'perf.json'), 'utf8'));
  check('legacy 1.0 baseline: kept as legacy, never assigned to an environment', migrated.schemaVersion === 2 && migrated.legacy?.entries['GET /api/slow']?.medianMs === 60 && !!migrated.scopes[scope], JSON.stringify(migrated));
}

// ---------------------------------------------------------------- 6. structured content is opt-in; mode off removes the QA line
{
  const s = await connect({ prefix: 'fq-pol-6-', env: { FASTQA_STRUCTURED: 'true' } });
  await s.call('open', { url: `${base}/orders?notify=500`, fresh: true });
  const r = await s.raw('act', { steps: place });
  const sc = r.structuredContent;
  check('structured content: execution, assertions, policy and coverage are separate fields', sc?.execution?.status === 'passed' && sc.assertions?.passed === 1 && sc.assertions.failed === 0 &&
    sc.quality?.status === 'findings' && sc.quality.policyOutcome === 'not_enforced' && sc.quality.coverage === 'complete' && sc.quality.newCount === 1 &&
    sc.quality.findings[0].ruleId === 'NET-5XX' && sc.quality.findings[0].association.confidence === 'inferred' && sc.quality.findings[0].evidenceIds.length > 0, JSON.stringify(sc));
  has('structured content: the text result is still complete', r.content[0].text, /^PASSED 2\/2/, 'F-001 HIGH NET-5XX');
  await s.close();
  const p = await connect({ prefix: 'fq-pol-6b-' });
  await p.call('open', { url: `${base}/orders?notify=500`, fresh: true });
  check('structured content is absent unless asked for', (await p.raw('act', { steps: place })).structuredContent === undefined);
  await p.close();
  const off = await connect({ prefix: 'fq-pol-6c-', env: { FASTQA_QUALITY: 'off' } });
  await off.call('open', { url: `${base}/orders?notify=500`, fresh: true });
  const out = await off.call('act', { steps: place });
  lacks('FASTQA_QUALITY=off: the 0.3 output, no QA line', out, 'QA', 'F-001');
  has('FASTQA_QUALITY=off: the legacy error line still works', out, '⚠ 1 JS error(s), 1 failed request(s) so far');
  await off.close();
}

srv.close();
process.exit(done() ? 1 : 0);
