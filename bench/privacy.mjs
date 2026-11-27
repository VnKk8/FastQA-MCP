// Privacy and bounded capture (FQA-003). Synthetic canary secrets travel through a URL, a header, a JSON body, the console
// and the DOM. None of them may appear in tool results, evidence, flow files, reports, session bundles or logs.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { start, CANARY } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('privacy');
const ENV_PW = 'CANARY-ENV-PW-31q7';
const CANARIES = [CANARY.token, CANARY.bearer, CANARY.pw, ENV_PW, CANARY.email];
const clean = (name, text) => lacks(name, text, ...CANARIES);
const readTree = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? readTree(p) : [[p, readFileSync(p, 'utf8')]]; }) : []);
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];
const rule = { id: 'ORDER-SUCCESS', method: 'POST', path: '/api/orders', status: 200, jsonPointer: '/success', equals: true };

// ---------------------------------------------------------------- A. defaults: metadata only, artifacts streamed, structured content on
{
  const s = await connect({ prefix: 'fq-priv-a-', env: { FASTQA_VAR_password: ENV_PW, FASTQA_STRUCTURED: 'true' }, config: { artifacts: { enabled: true }, quality: { businessRules: [rule] }, browser: { ignoreHTTPSErrors: true } } });
  const seen = [];
  const call = async (name, args = {}) => { const r = await s.raw(name, args); const t = r.content.map((x) => x.text ?? '').join('\n'); seen.push(t, JSON.stringify(r.structuredContent ?? {})); return t; };

  await call('open', { url: `${base}/login?echo=1`, fresh: true });
  let out = await call('act', { steps: [
    { do: 'fill', target: 'Email', value: 'john@example.com' }, { do: 'fill', target: 'Password', value: '{{password}}' },
    { do: 'click', target: 'Log in' }, { do: 'expect_text', value: 'Invalid email or password' },
  ] });
  has('DOM echo of a bound secret is shown as its placeholder', out, 'you typed {{password}}');
  out = await call('snapshot', { mode: 'full' });
  has('snapshot: the echoed secret is a placeholder too', out, '{{password}}');

  await call('flow', { action: 'save', name: 'canary-login' });
  const loginFlow = readFileSync(path.join(s.dir, 'flows', 'canary-login.json'), 'utf8');
  clean('flow file holds no secret', loginFlow);
  has('flow file keeps the placeholder, so it stays replayable', loginFlow, '"value": "{{password}}"');

  await call('open', { url: `${base}/orders?canary=1&notify=500&order=business` });
  out = await call('act', { steps: place });
  has('the canary scenario still produces its finding', out, /^PASSED 2\/2/, 'NET-5XX POST /api/notifications returned 500');
  const fid = /(F-\d+) HIGH NET-5XX/.exec(out)?.[1] ?? 'F-001';
  await call('act', { steps: [{ do: 'wait', value: '300' }] });
  out = await call('evidence', { view: 'network', path: '/api/track', details: true });
  has('network URL: secret parameter masked, other values removed', out, '/api/track?token=•••&email=…&page=…');
  out = await call('evidence', { view: 'summary' });
  has('a rule that needs a payload is reported as not evaluated when capture is off', out, 'payloads: capture off', /not evaluated: ORDER-SUCCESS — response body not available \(capture-off\)/);
  await call('evidence', { view: 'findings', status: 'all', details: true });
  await call('evidence', { view: 'timeline', limit: 100 });
  await call('evidence', { view: 'network', details: true, limit: 100 });
  await call('evidence', { view: 'config' });
  await call('evidence');
  out = await call('flow', { action: 'save', name: 'canary' });
  out = await call('evidence', { finding: fid, report: true });
  has('bug draft: candidate, not a verdict, with the associated action and limits', out, '# [Candidate] POST /api/notifications returned 500', 'not a confirmed defect', '← associated action', 'Reproduction status: not attempted', 'temporal, not proof of cause');
  out = await call('evidence', { report: true });
  has('session bundle is written on request', out, 'Session bundle written', 'summary.json');
  out = await call('flow', { action: 'run', name: 'canary' });
  has('replay of the canary flow runs', out, /flows passed/);
  await call('flow', { action: 'export', name: 'canary' });
  await s.close();

  clean('tool results and structured content', seen.join('\n'));
  clean('server stderr', s.stderr.join(''));
  const reports = readTree(path.join(s.dir, 'reports'));
  check('reports were written', reports.length >= 4, reports.map(([p]) => p).join(', '));
  clean('HTML and JUnit reports', reports.map(([, t]) => t).join('\n'));
  const htmlReport = reports.find(([p]) => p.endsWith('latest.html'))[1];
  lacks('report: text from the page is escaped, never markup', htmlReport, '<img src=x');
  const bundles = readTree(path.join(s.dir, 'sessions'));
  check('bundles: interactive session and replay both left one', new Set(bundles.map(([p]) => path.relative(path.join(s.dir, 'sessions'), p).split(path.sep)[0])).size >= 2, bundles.map(([p]) => p).join('\n'));
  clean('session bundles (summary, actions, observations, findings, evidence)', bundles.map(([, t]) => t).join('\n'));
  has('bundle: observations were streamed and the manifest is complete', bundles.map(([p]) => path.basename(p)).join(','), 'observations.jsonl', 'actions.jsonl', 'findings.json', 'summary.json', 'finding.md', 'network.json');
  lacks('bundle: no absolute paths', bundles.map(([, t]) => t).join('\n'), s.dir, s.dir.split(path.sep).join('/'), s.dir.split(path.sep).join('\\\\'));
  clean('exported spec and flow files', [...readTree(path.join(s.dir, 'tests')), ...readTree(path.join(s.dir, 'flows'))].map(([, t]) => t).join('\n'));
}

// ---------------------------------------------------------------- B. opt-in capture: allowlisted first-party JSON only, sanitized, bounded
{
  const s = await connect({ prefix: 'fq-priv-b-', config: { capture: { payloads: 'json', allowedOrigins: [base] }, privacy: { keepQueryParams: ['page'] }, quality: { businessRules: [rule] } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?order=business&notify=off&canary=1`, fresh: true });
  const t0 = Date.now();
  let out = await call('act', { steps: place });
  has('HTTP 200 with success:false is a candidate once the payload may be read', out, /^PASSED 2\/2/, /HIGH BUSINESS-ERROR ORDER-SUCCESS: POST \/api\/orders → HTTP 200 but \/success = false/);
  check('capture never blocks the interaction', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
  await call('act', { steps: [{ do: 'wait', value: '300' }] });
  out = await call('evidence', { view: 'network', path: '/api/profile', details: true });
  has('captured JSON is sanitized before it is kept', out, 'body: captured', '"password":"•••"', '"token":"•••"', '"plan":"pro"');
  clean('captured JSON holds no canary', out);
  out = await call('evidence', { view: 'network', path: '/api/track' });
  has('allowlisted query parameter keeps its value', out, 'page=2', 'token=•••');
  out = await call('evidence', { view: 'findings', details: true });
  has('request fields are names and types, never values', out, 'request fields: {"product":"string","qty":"number"}');
  await call('open', { url: `${base}/login` });
  await call('act', { steps: [{ do: 'fill', target: 'Email', value: 'john@example.com' }, { do: 'fill', target: 'Password', value: '{{password}}' }, { do: 'click', target: 'Log in' }, { do: 'check', target: 'css=#card-tshirt .tc' }, { do: 'click', target: 'Add Blue T-shirt to cart' }, { do: 'expect_text', value: 'Added to cart' }] });
  out = await call('evidence', { view: 'network', path: '/api/login', details: true });
  lacks('auth endpoints are never captured unless listed explicitly', out, 'body: captured');
  out = await call('evidence', { view: 'network', path: '/api/cart', details: true });
  has('a response of unknown size is skipped, not buffered', out, 'body: skipped (unknown-size)');
  await s.close();
}

// ---------------------------------------------------------------- C. size limits and the explicit unknown-length opt-in
{
  const s = await connect({ prefix: 'fq-priv-c-', config: { capture: { payloads: 'json', allowedOrigins: [base], maxBodyBytes: 30, allowUnknownLength: true }, quality: { businessRules: [rule] } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?order=business&notify=off`, fresh: true });
  let out = await call('act', { steps: place });
  lacks('oversized body: the rule is not evaluated, so no finding is invented', out, 'BUSINESS-ERROR');
  has('oversized body: the QA line says a rule was not evaluated', out, '1 rule not evaluated');
  out = await call('evidence', { view: 'summary' });
  has('oversized body: the reason is explicit', out, /ORDER-SUCCESS — response body not available \(oversized\)/);
  await s.close();
}

// ---------------------------------------------------------------- D. the deny rule wins over configuration
{
  const s = await connect({ prefix: 'fq-priv-d-', env: { FASTQA_CAPTURE: 'off' }, config: { capture: { payloads: 'json', allowedOrigins: [base] }, quality: { businessRules: [rule] } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?order=business&notify=off`, fresh: true });
  let out = await call('act', { steps: place });
  lacks('FASTQA_CAPTURE=off: nothing is captured', out, 'BUSINESS-ERROR');
  out = await call('evidence', { view: 'config' });
  has('FASTQA_CAPTURE=off: effective configuration shows capture off', out, '"payloads": "off"');
  await s.close();
}

// ---------------------------------------------------------------- E. event budget: eviction is counted and visible, never silent
{
  const s = await connect({ prefix: 'fq-priv-e-', config: { capture: { maxEvents: 25 } } });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=500&poll=50`, fresh: true });
  let out = await call('act', { steps: place });
  has('budget: the finding is reported first', out, 'F-001 HIGH NET-5XX');
  out = await call('act', { steps: [{ do: 'wait', value: '1500' }] });
  has('budget: dropped events make coverage partial in the QA line', out, /coverage partial \(.*\d+ events dropped\)/);
  out = await call('evidence', { finding: 'F-001' });
  has('budget: evicted evidence is said to be evicted', out, /E-\d+ \(evicted: over the retention budget\)/);
  out = await call('evidence', { view: 'summary' });
  has('budget: summary counts retained and dropped events', out, /events: 25 retained, \d+ dropped/);
  await s.close();
}

srv.close();
process.exit(done() ? 1 : 0);
