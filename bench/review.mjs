// End-to-end regressions for the findings of the two independent reviews that need a real browser.
// (The findings that are pure logic are in bench/unit-review.mjs.) Each block names the finding it reproduces.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('review');
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];

// ---- Privacy 1 (critical): a parameter name controlled by the page must never reach a flow file or a spec as text
{
  const s = await connect({ prefix: 'fq-rev-p1-' });
  await s.call('open', { url: `${base}/orders?notify=off&inject=1`, fresh: true });
  let out = await s.call('act', { steps: [...place, { do: 'wait', value: '300' }] });
  has('injection: the journey itself still passes', out, /^PASSED 3\/3/);
  await s.call('flow', { action: 'save', name: 'inj' });
  const raw = readFileSync(path.join(s.dir, 'flows', 'inj.json'), 'utf8');
  let flow; try { flow = JSON.parse(raw); } catch { flow = undefined; }
  check('injection: the saved flow is valid JSON with exactly the recorded steps', !!flow && flow.steps.length === 4 && flow.steps.every((st) => !/evil\.test/.test(JSON.stringify(st))), raw);
  lacks('injection: nothing from the hostile parameter name is in the flow', raw, 'evil.test', 'token_y', '{{password}}');
  has('injection: the recorded assertion keeps its literal text (replay still works)', raw, '"value": "Thank you for your order"');
  out = await s.call('flow', { action: 'export', name: 'inj' });
  lacks('injection: nothing from the hostile parameter name is in the exported spec', out, 'evil.test', 'token_y');
  out = await s.call('flow', { action: 'run', name: 'inj' });
  has('injection: the saved flow replays', out, /^1\/1 flows passed/);
  await s.close();
}

// ---- Compat 4: two negative submits, each followed by its own expect_request, are both declared expected
{
  const s = await connect({ prefix: 'fq-rev-c4-' });
  const neg = [{ do: 'fill', target: 'Quantity', value: '0' }, { do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Quantity must be at least 1' }, { do: 'expect_request', target: 'POST /api/orders', value: '422' }];
  await s.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  const out = await s.call('act', { steps: [...neg, ...neg] });
  has('two asserted negative submits in one batch: clean', out, /^PASSED 8\/8/, 'QA: clean');
  lacks('two asserted negative submits in one batch: no candidate left', out, 'NET-4XX');
  await s.close();
}

// ---- Compat 5: a known failure that happens again is not reported as "clean", and fails strict again
{
  const s = await connect({ prefix: 'fq-rev-c5-', config: { quality: { mode: 'strict' }, browser: { ignoreHTTPSErrors: true } } });
  await s.call('open', { url: `${base}/orders?notify=500`, fresh: true });
  let out = await s.call('act', { steps: place });
  has('first occurrence: new finding, strict fails', out, 'QA: 1 new candidate finding (highest HIGH)', 'QA policy (strict): FAILED');
  out = await s.call('act', { steps: place });
  has('second occurrence: reported as seen again, with its count', out, 'QA: 1 known finding seen again (highest HIGH)', /F-001 HIGH NET-5XX .* ×2 \(again\)/);
  has('second occurrence: strict fails again', out, 'QA policy (strict): FAILED');
  lacks('second occurrence: never "clean"', out, 'QA: clean', 'QA policy (strict): passed');
  out = await s.call('act', { steps: [{ do: 'expect_text', value: 'Thank you' }] });
  has('a batch in which it did not happen is clean again', out, 'QA: clean', 'QA policy (strict): passed');
  await s.close();
}

// ---- Compat 2: a popup that closes with a request still open must not leave coverage partial forever
{
  const s = await connect({ prefix: 'fq-rev-c2-' });
  await s.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  await s.call('act', { steps: [{ do: 'click', target: 'Open tracking' }, { do: 'wait', value: '900' }] });
  const out = await s.call('act', { steps: [{ do: 'expect_text', value: 'New order' }, { do: 'click', target: 'Check stock' }, { do: 'expect_text', value: 'In stock' }] });
  has('after the popup closed, steps continue on the page that is still open', out, /^PASSED 3\/3/);
  has('the popup\'s abandoned request is not pending any more', out, 'QA: clean');
  lacks('coverage is not stuck on partial', out, 'coverage partial');
  await s.close();
}

// ---- Compat 7: traffic of a service worker is not page traffic (0.3 never saw it)
{
  const s = await connect({ prefix: 'fq-rev-c7-' });
  await s.call('open', { url: `${base}/sw-page`, fresh: true });
  const out = await s.call('act', { steps: [{ do: 'wait', value: '900' }, { do: 'click', target: 'Ping' }, { do: 'expect_text', value: 'pong' }, { do: 'expect_no_errors' }] });
  has('a failing call made by the service worker itself does not fail expect_no_errors', out, /^PASSED 4\/4/);
  lacks('nor is it counted as a failed request of the page', out, 'failed request(s)');
  const ev = await s.call('evidence');
  has('legacy evidence shows no worker traffic', ev, 'failed requests (0)');
  await s.close();
}

// ---- Compat 1: strict replay of an app that polls must not fail as "incomplete"
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-rev-c1-'));
  mkdirSync(path.join(dir, 'flows'), { recursive: true });
  // polls every 120 ms and each answer takes 400 ms: there is always a poll in flight when the flow ends
  writeFileSync(path.join(dir, 'flows', 'polling.json'), JSON.stringify({ name: 'polling', created: '2026-11-27T00:00:00.000Z', schema: 2, steps: [{ do: 'goto', value: '{{base}}/orders?notify=off&poll=120&pollDelay=400' }, ...place] }));
  let ok = 0; const outs = [];
  for (let i = 0; i < 3; i++) { const r = await cli(`run polling --var=base=${base} --mode=strict`, { FASTQA_DIR: dir }); outs.push(`exit=${r.code}\n${r.stdout}`); if (r.code === 0) ok++; }
  check('strict replay with polling in flight passes (3 of 3 runs)', ok === 3, outs.join('\n---\n'));
  lacks('polling does not make the run "incomplete"', outs.join('\n'), 'observation incomplete');
}

// ---- Compat 9: the exported expect_no_errors sees a failure that arrives shortly after a click, like replay does
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-rev-c9-'));
  const s = await connect({ dir });
  await s.call('open', { url: `${base}/orders?notify=off&notifyDelay=350`, fresh: true });
  await s.call('act', { steps: [{ do: 'click', target: 'Place order' }, { do: 'expect_no_errors' }] });
  await s.call('flow', { action: 'save', name: 'slowfail' });
  const f = JSON.parse(readFileSync(path.join(dir, 'flows', 'slowfail.json'), 'utf8'));
  f.steps[0].value = f.steps[0].value.replace('notify=off', 'notify=500'); f.steps[0].code = f.steps[0].code.replace('notify=off', 'notify=500');
  writeFileSync(path.join(dir, 'flows', 'slowfail.json'), JSON.stringify(f, null, 2));
  const replay = await s.call('flow', { action: 'run', name: 'slowfail' });
  has('replay: the 500 that arrives 350 ms after the click fails expect_no_errors', replay, /^0\/1 flows passed/, '✗ expect_no_errors');
  const exported = await s.call('flow', { action: 'export', name: 'slowfail' });
  has('export: the difference that remains is declared', exported, 'bounded settle after each action');
  await s.close();
  writeFileSync(path.join(dir, 'playwright.config.mjs'), `export default { testDir: './tests', reporter: 'line', use: { launchOptions: { executablePath: ${JSON.stringify(process.env.FASTQA_CHROME || '')} || undefined } } };`);
  const r = await promisify(exec)(`node "${path.resolve('node_modules/@playwright/test/cli.js')}" test slowfail.spec.ts -c "${dir}/playwright.config.mjs"`, { cwd: dir, env: { ...process.env, NODE_PATH: path.resolve('node_modules') } })
    .then((x) => ({ code: 0, out: x.stdout + x.stderr }), (e) => ({ code: e.code, out: (e.stdout ?? '') + (e.stderr ?? '') }));
  has('exported spec: fails on the same late 500', `exit=${r.code}\n${r.out}`, 'exit=1', 'expect_no_errors', /http: 500 POST/);
}

srv.close();
process.exit(done() ? 1 : 0);
