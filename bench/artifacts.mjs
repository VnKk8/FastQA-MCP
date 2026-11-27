// Evidence and reproduction (FQA-007/008) and observed discovery (FQA-009):
// session bundle contents, candidate bug drafts, replay as reproduction, executable export parity, the discovery graph.
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('artifacts');
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];
const json = (...p) => JSON.parse(readFileSync(path.join(...p), 'utf8'));
const jsonl = (...p) => readFileSync(path.join(...p), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- 1. investigate a finding, save a reproduction, replay it without a model
{
  const s = await connect({ prefix: 'fq-art-1-' });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=500`, fresh: true });
  let out = await call('act', { steps: place });
  has('the finding to investigate', out, 'F-001 HIGH NET-5XX');
  out = await call('evidence', { finding: 'F-001', details: true });
  has('targeted evidence: only this finding, its events and its request', out, /^findings 1–1 of 1/, 'association: A-2 click "Place order" (inferred)', /E-\d+ response R-\d+ status 500/, /request R-\d+ POST \/api\/notifications\?status=…&delay=… → 500/);
  out = await call('evidence', { view: 'network', finding: 'F-001' });
  check('network view filtered by finding: one row', (out.match(/^R-\d+ /gm) ?? []).length === 1, out);
  out = await call('evidence', { view: 'network', path: '/api/orders' });
  has('a trace id sent by the server is kept for log correlation', out, /POST \/api\/orders → 201 .* trace req-demo-123/);
  out = await call('evidence', { view: 'timeline', action: 'A-2' });
  has('timeline filtered by action', out, 'A-2 click "Place order" ✓', /E-\d+ request POST/);
  lacks('timeline filtered by action: nothing else', out, 'A-1 goto');
  out = await call('evidence', { view: 'timeline', limit: 3 });
  const cursor = /next: cursor=(\S+)/.exec(out)?.[1];
  has('paging: a page and a cursor', out, /^timeline 1–3 of \d+ · next: cursor=/);
  const page2 = await call('evidence', { view: 'timeline', limit: 3, cursor });
  has('paging: the cursor continues where the page ended', page2, /^timeline 4–6 of \d+/);
  check('paging is read-only: asking again returns the same page', (await call('evidence', { view: 'timeline', limit: 3 })) === out);
  out = await call('evidence', { finding: 'F-001', report: true });
  has('bug draft follows the template', out, '# [Candidate] POST /api/notifications returned 500', '- Environment/build/browser: browser chromium', '- Minimal observed reproduction steps (as executed; not minimized):',
    /1\. goto "http:\/\/127\.0\.0\.1:\d+\/orders\?notify=500"/, '2. click "Place order"  ← associated action', '- Expected: no server error', '- Actual: HTTP 500',
    '- UI outcome / assertion result: all executed steps and explicit assertions passed', '- Reproduction status: not attempted', '- Known issue / suppression: none', 'Rule: NET-5XX v1 · finding F-001');
  const draft = /Wrote (.+finding\.md)/.exec(out)[1];
  check('bug draft is written inside the session directory', draft.startsWith(path.join(s.dir, 'sessions')) && existsSync(draft) && existsSync(path.join(path.dirname(draft), 'network.json')), draft);
  out = await call('evidence', { finding: '../../x', report: true });
  has('a finding id cannot be used to write elsewhere', out, 'No finding ../../x');

  // save the journey as a reproduction candidate and replay it: reproduction is verified separately, by running it
  out = await call('flow', { action: 'save', name: 'repro-notification-500' });
  has('reproduction flow saved', out, 'Saved 3 steps');
  out = await call('flow', { action: 'run', name: 'repro-notification-500' });
  has('replay without a model reproduces the same candidate', out, /^1\/1 flows passed/, 'F-001 HIGH NET-5XX POST /api/notifications returned 500');
  out = await call('evidence', { report: true });
  const dir = /Session bundle written: (.+)/.exec(out)[1].trim();
  const sum = json(dir, 'summary.json');
  check('summary.json: ids, outcomes and counts', sum.schemaVersion === 1 && /^S-/.test(sum.sessionId) && sum.outcomes.execution.status === 'passed' && sum.outcomes.policy.outcome === 'not_enforced' &&
    sum.quality.candidates === 1 && sum.quality.bySeverity.high === 1 && sum.quality.byRule['NET-5XX'] === 1 && sum.coverage.state === 'complete' && sum.reproduction.status === 'not attempted', JSON.stringify(sum, null, 1));
  has('summary.json: says what it does not cover', sum.coverage.note, 'not a coverage measure');
  check('summary.json: effective policy without secrets, relative artifact references', sum.policy.mode === 'observe' && sum.artifacts.actions === 'actions.jsonl' && sum.artifacts.bugDrafts[0] === 'evidence/F-001/finding.md' && sum.environment.fastqa && /chromium/.test(sum.environment.browser), JSON.stringify(sum.artifacts));
  const acts = jsonl(dir, 'actions.jsonl');
  check('actions.jsonl: the sanitized action ledger', acts.length === 3 && acts[1].label === 'click "Place order"' && acts[1].batchKind === 'act' && acts[1].ok === true && acts[1].requests >= 2, JSON.stringify(acts));
  const obsv = jsonl(dir, 'observations.jsonl');
  check('observations.jsonl: schema-versioned events with ids, sequence and association', obsv.length > 5 && obsv.every((e) => e.schemaVersion === 1 && /^E-\d+$/.test(e.eventId) && e.sessionId === sum.sessionId && e.action?.confidence) && obsv.some((e) => e.kind === 'response' && e.data.status === 500), `${obsv.length} events`);
  const fnd = json(dir, 'findings.json');
  check('findings.json: canonical records, evidence ids resolve in observations.jsonl', fnd.findings.length === 1 && fnd.findings[0].ruleId === 'NET-5XX' && fnd.findings[0].evidenceIds.every((id) => obsv.some((e) => e.eventId === id)), JSON.stringify(fnd.findings[0]));
  await s.close();
}

// ---------------------------------------------------------------- 2. CLI --bundle: the replay leaves a bundle that points at its flow
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-art-2-'));
  const s = await connect({ dir });
  await s.call('open', { url: `${base}/orders?notify=500`, fresh: true });
  await s.call('act', { steps: [...place, { do: 'expect_request', target: 'POST /api/orders', value: '201' }] });
  await s.call('flow', { action: 'save', name: 'order' });
  await s.close();
  check('no bundle unless asked: artifacts are opt-in', !existsSync(path.join(dir, 'sessions')));
  const r = await cli('run order --bundle', { FASTQA_DIR: dir });
  has('CLI --bundle: prints the bundle directory, relative', r.stdout, /bundle: sessions\/\d{8}T\d{6}Z-[0-9a-f]{8}\n/);
  const b = path.join(dir, /bundle: (\S+)/.exec(r.stdout)[1]);
  const sum = json(b, 'summary.json');
  check('replay bundle: flow reference, execution outcome, step count', sum.reproduction.flow === 'flows/order.json' && sum.outcomes.execution.status === 'passed' && sum.outcomes.execution.steps === 4 && sum.quality.candidates === 1, JSON.stringify(sum.outcomes));
  has('HTML report names the bundle', readFileSync(path.join(dir, 'reports', 'latest.html'), 'utf8'), /bundle <code>sessions\/\d{8}T/);
}

// ---------------------------------------------------------------- 3. export parity: QA assertions are executable in the Playwright spec
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-art-3-'));
  const s = await connect({ dir });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  await call('act', { steps: [...place, { do: 'expect_request', target: 'POST /api/orders', value: '201' }, { do: 'expect_no_errors' }, { do: 'expect_hidden', target: '#nope' }, { do: 'expect_hidden', target: 'Ghost button' }] });
  await call('flow', { action: 'save', name: 'parity-ok' });
  let out = await call('flow', { action: 'export', name: 'parity-ok' });
  has('export: network and error assertions are code, not comments', out, 'const fq = fastqa(page);', 'await fq.expectRequest("POST /api/orders", "201");', 'await fq.expectNoErrors("");', 'await expect(page.locator("#nope")).toBeHidden();');
  has('export: what cannot be exported faithfully is named, never silently dropped', out, '1 step(s) not exported (fastqa replay still enforces them): step 7 expect_hidden', '// fastqa:unsupported step 7: expect_hidden "Ghost button"');
  const parity = json(dir, 'tests', 'parity-ok.parity.json');
  check('export: machine-readable parity file', parity.executable === 6 && parity.unsupported.length === 1 && parity.unsupported[0].step === 7 && parity.notExported.length === 2 && parity.spec === 'tests/parity-ok.spec.ts', JSON.stringify(parity));
  out = await call('flow', { action: 'export', name: 'parity-ok', mode: 'strict' });
  has('export strict: refused when a step cannot be exported faithfully', out, /^Export refused \(strict\): 1 step\(s\) cannot be exported faithfully — step 7 expect_hidden/);

  // the same assertions must pass and fail in the exported spec exactly like in fastqa replay
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  await call('act', { steps: [...place, { do: 'expect_request', target: 'POST /api/orders', value: '201' }, { do: 'expect_no_errors' }] });
  await call('flow', { action: 'save', name: 'parity' });
  await call('flow', { action: 'export', name: 'parity', mode: 'strict' });
  // a faulty variant of the same flow: the hidden 500 must fail expect_no_errors in both worlds
  const flow = json(dir, 'flows', 'parity.json');
  flow.name = 'parity-fault'; flow.steps[0].value = flow.steps[0].value.replace('notify=off', 'notify=500'); flow.steps[0].code = flow.steps[0].code.replace('notify=off', 'notify=500');
  writeFileSync(path.join(dir, 'flows', 'parity-fault.json'), JSON.stringify(flow, null, 2));
  await call('flow', { action: 'export', name: 'parity-fault' });
  const ok = await call('flow', { action: 'run', name: 'parity' });
  const bad = await call('flow', { action: 'run', name: 'parity-fault' });
  has('fastqa replay: success fixture passes', ok, /^1\/1 flows passed/);
  has('fastqa replay: fault fixture fails on expect_no_errors', bad, /^0\/1 flows passed/, '✗ expect_no_errors — 1 error(s): http: 500 POST');
  await s.close();
  writeFileSync(path.join(dir, 'playwright.config.mjs'), `export default { testDir: './tests', reporter: 'line', use: { launchOptions: { executablePath: ${JSON.stringify(process.env.FASTQA_CHROME || '')} || undefined } } };`);
  const pw = (spec) => promisify(exec)(`node "${path.resolve('node_modules/@playwright/test/cli.js')}" test ${spec} -c "${dir}/playwright.config.mjs"`, { cwd: dir, env: { ...process.env, NODE_PATH: path.resolve('node_modules') } })
    .then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: (e.stdout ?? '') + (e.stderr ?? '') }));
  let r = await pw('parity.spec.ts');
  has('exported spec: success fixture passes under @playwright/test', `exit=${r.code}\n${r.out}`, 'exit=0', '1 passed');
  r = await pw('parity-fault.spec.ts');
  has('exported spec: fault fixture fails on the same assertion', `exit=${r.code}\n${r.out}`, 'exit=1', 'expect_no_errors', /http: 500 POST/);
}

// ---------------------------------------------------------------- 4. observed discovery: bounded graph of what was actually seen
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-art-4-'));
  const s = await connect({ dir, config: { quality: { mode: 'discovery' }, artifacts: { enabled: true }, browser: { ignoreHTTPSErrors: true } } });
  const { call } = s;
  const journey = async () => {
    await call('open', { url: `${base}/login` });
    await call('act', { scope: 'login-and-order', steps: [{ do: 'fill', target: 'Email', value: 'john@example.com' }, { do: 'fill', target: 'Password', value: '{{password}}' }, { do: 'click', target: 'Log in' }, { do: 'expect_url', value: '/account' }] });
    await call('open', { url: `${base}/orders?notify=500&poll=150` });
    return call('act', { scope: 'login-and-order', steps: [...place, { do: 'wait', value: '900' }] });
  };
  let out = await journey();
  has('discovery mode does not change results', out, /^PASSED 3\/3/, 'NET-5XX');
  const first = await call('evidence', { view: 'discovery' });
  has('discovery view: observed routes, endpoints and edges, with its limits stated', first, '/login', '/account', '/orders', 'POST /api/login', 'POST /api/orders', 'POST /api/notifications', /observed/i);
  lacks('discovery view: no query values, no coverage claim', first, 'john@example.com', 'secret123', '%');
  await journey();
  out = await call('evidence', { report: true });
  const b = /Session bundle written: (.+)/.exec(out)[1].trim();
  const g = json(b, 'discovery', 'endpoints.json');
  const ep = (m, p) => g.endpoints.find((e) => e.method === m && e.path === p);
  check('graph: repeating the journey raises counts instead of duplicating nodes', g.routes.filter((r) => r.path === '/login').length === 1 && g.routes.find((r) => r.path === '/login').count === 2 && ep('POST', '/api/orders')?.count === 2 && g.endpoints.filter((e) => e.path === '/api/orders').length === 1, JSON.stringify(g.endpoints.map((e) => `${e.method} ${e.path} ×${e.count}`)));
  check('graph: endpoint statuses are what was observed', ep('POST', '/api/notifications')?.statuses.join() === '500' && ep('POST', '/api/orders')?.statuses.join() === '201', JSON.stringify(ep('POST', '/api/notifications')));
  const edge = (rel, to) => g.edges.filter((e) => e.relation === rel && e.to === to);
  check('graph: action → endpoint edges carry confidence and evidence ids', edge('triggers', ep('POST', '/api/orders').id).length === 1 && edge('triggers', ep('POST', '/api/orders').id)[0].confidence === 'inferred' && edge('triggers', ep('POST', '/api/orders').id)[0].evidenceIds.length > 0, JSON.stringify(g.edges.slice(0, 6)));
  check('graph: polling is background, mostly not attributed to an action', ep('GET', '/api/poll')?.background >= ep('GET', '/api/poll')?.count / 2, JSON.stringify(ep('GET', '/api/poll')));
  check('graph: stable edges (no duplicates)', new Set(g.edges.map((e) => `${e.from}>${e.to}>${e.relation}`)).size === g.edges.length);
  has('graph: states that it lists observed activity only', g.limits, /observed/i);
  const j = json(b, 'discovery', 'journeys.json');
  check('journeys: per batch, with the agent-supplied scope label', j.journeys.some((x) => x.scope === 'login-and-order' && x.steps.some((st) => /click "Place order"/.test(st.action) && st.endpoints.includes('POST /api/orders'))), JSON.stringify(j.journeys.slice(0, 3)));
  await s.close();

  // a second, separate session; then an explicit merge of the sanitized exports
  const t = await connect({ dir });
  await t.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  await t.call('act', { steps: [{ do: 'click', target: 'Check stock' }, { do: 'expect_text', value: 'In stock' }] });
  out = await t.call('evidence', { view: 'discovery' });
  lacks('sessions do not share discovery data', out, '/api/login', '/account');
  await t.close();
  const r = await cli('discovery', { FASTQA_DIR: dir });
  has('CLI discovery: explicit merge of saved exports, with the no-coverage statement', r.stdout, /Merged \d+ session exports into .*discovery\.json/, 'not a coverage measure');
  const merged = json(dir, 'discovery.json');
  check('merged export: both sessions, traceable evidence ids', merged.sessions.length >= 2 && merged.endpoints.some((e) => e.path === '/api/stock/v2') && merged.endpoints.some((e) => e.path === '/api/login') && merged.endpoints.every((e) => e.evidenceIds.every((id) => /^S-\w+:E-\d+$/.test(id))), JSON.stringify(merged.sessions));

  const off = await connect({ prefix: 'fq-art-4o-' });
  await off.call('open', { url: `${base}/login`, fresh: true });
  has('discovery is off by default', await off.call('evidence', { view: 'discovery' }), 'Discovery is off for this session');
  await off.close();
}

srv.close();
process.exit(done() ? 1 : 0);
