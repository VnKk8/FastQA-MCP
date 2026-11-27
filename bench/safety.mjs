// Locator and session safety (FQA-004), load and isolation: strict locators, stale refs, queued calls,
// independent workers, artifact collisions, repeated open/close, origin restriction.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('safety');
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];

// ---------------------------------------------------------------- 1. strict locators
{
  const s = await connect({ prefix: 'fq-safe-1-' });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  let out = await call('act', { steps: [{ do: 'click', target: 'Details' }, { do: 'expect_text', value: 'Details of Order #1001' }] });
  has('default (0.3 behaviour): a duplicate label resolves to the first visible match', out, /^PASSED 2\/2/);
  out = await call('act', { steps: [{ do: 'click', target: 'Details' }], strict: true });
  has('strict: a duplicate label fails instead of picking one', out, /^FAILED at step 1\/1/, '"Details" matches 2 elements and strict mode will not pick one');
  has('strict: the error lists refs with their context', out, /Use a ref: (e\d+) button "Details" in "Order #1001 Details" \| (e\d+) button "Details" in "Order #1002 Details"/);
  const refs = /Use a ref: (e\d+) .*? \| (e\d+) /.exec(out);
  out = await call('act', { steps: [{ do: 'click', target: refs[2] }, { do: 'expect_text', value: 'Details of Order #1002' }], strict: true });
  has('strict: the chosen ref hits exactly that element', out, /^PASSED 2\/2/);
  out = await call('act', { steps: [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you' }], strict: true });
  has('strict: an unambiguous target works as before', out, /^PASSED 2\/2/);
  out = await call('act', { steps: [{ do: 'click', target: 'css=.det' }], strict: true });
  has('strict: an ambiguous raw selector is rejected too', out, /^FAILED at step 1\/1/, 'matches 2 elements');
  out = await call('act', { steps: [{ do: 'expect_visible', target: 'Details' }], strict: true });
  has('strict: an ambiguous assertion target fails fast with the same explanation', out, /^FAILED/, 'strict mode will not pick one');

  // stale refs: issued on one document, used on another
  out = await call('snapshot');
  const stale = /(e\d+) button "Place order"/.exec(out)[1];
  await call('open', { url: `${base}/login` });
  out = await call('act', { steps: [{ do: 'click', target: stale }], strict: true });
  has('strict: a ref from a previous document is rejected as stale', out, /^FAILED/, `Stale ref ${stale}: the page navigated after it was issued`);
  await s.close();

  const c = await connect({ prefix: 'fq-safe-1c-', config: { locator: { strict: true }, browser: { ignoreHTTPSErrors: true } } });
  await c.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  out = await c.call('act', { steps: [{ do: 'click', target: 'Details' }] });
  has('locator.strict in the config makes strict the default', out, /^FAILED at step 1\/1/, 'strict mode will not pick one');
  out = await c.call('act', { steps: [{ do: 'click', target: 'Sync' }, { do: 'click', target: 'Details' }] });
  lacks('a failed step is never retried on another element', out, '✓ click "Details"');
  await c.close();
}

// ---------------------------------------------------------------- 2. one context, one caller at a time
{
  const s = await connect({ prefix: 'fq-safe-2-' });
  const { call } = s;
  await call('open', { url: `${base}/orders?notify=off`, fresh: true });
  const [a, b, snap] = await Promise.all([
    call('act', { steps: [{ do: 'fill', target: 'Quantity', value: '3' }, { do: 'wait', value: '400' }, { do: 'expect_value', target: 'Quantity', value: '3' }] }),
    call('act', { steps: [{ do: 'fill', target: 'Quantity', value: '7' }, { do: 'wait', value: '100' }, { do: 'expect_value', target: 'Quantity', value: '7' }] }),
    call('snapshot'),
  ]);
  has('concurrent calls are queued: the first batch sees only its own value', a, /^PASSED 3\/3/);
  has('concurrent calls are queued: the second batch runs after it', b, /^PASSED 3\/3/);
  has('concurrent calls are queued: the snapshot sees one consistent final value', snap, /textbox "Quantity" ="(3|7)"/);
  let out = await call('evidence', { view: 'timeline', limit: 100 });
  const order = [...out.matchAll(/(A-\d+) (fill|wait|expect_value)/g)].map((m) => m[2]).join(',');
  check('concurrent calls are queued: actions of the two batches never interleave (whichever ran first)', order.endsWith('fill,wait,expect_value,fill,wait,expect_value'), order);
  await s.close();
}

// ---------------------------------------------------------------- 3. independent workers share nothing
{
  const shared = mkdtempSync(path.join(tmpdir(), 'fq-safe-3-'));
  mkdirSync(path.join(shared, 'flows'), { recursive: true });
  writeFileSync(path.join(shared, 'config.json'), JSON.stringify({ artifacts: { enabled: true }, browser: { ignoreHTTPSErrors: true } }));
  writeFileSync(path.join(shared, 'flows', 'order.json'), JSON.stringify({ name: 'order', created: '2026-11-27T00:00:00.000Z', schema: 2, steps: [{ do: 'goto', value: '{{base}}/orders?notify={{notify}}' }, ...place] }));
  const [w1, w2] = await Promise.all([connect({ dir: shared }), connect({ dir: shared })]);
  // same FASTQA_DIR on purpose: worst case for collisions
  const [o1, o2] = await Promise.all([
    (async () => { await w1.call('open', { url: `${base}/login`, fresh: true }); await w1.call('act', { steps: [{ do: 'fill', target: 'Email', value: 'john@example.com' }, { do: 'fill', target: 'Password', value: '{{password}}' }, { do: 'click', target: 'Log in' }, { do: 'expect_url', value: '/account' }] }); return w1.call('evidence', { view: 'summary' }); })(),
    (async () => { await w2.call('open', { url: `${base}/orders?notify=500`, fresh: true }); await w2.call('act', { steps: place }); return w2.call('evidence', { view: 'summary' }); })(),
  ]);
  const id = (t) => /session (S-\w+)/.exec(t)?.[1];
  check('two workers: different sessions', id(o1) && id(o2) && id(o1) !== id(o2), `${id(o1)} ${id(o2)}`);
  has('two workers: the clean worker sees none of the other one\'s findings', o1, /findings: 0 candidate/);
  has('two workers: the failing worker keeps its own finding', o2, /findings: 1 candidate \(1 high\)/);
  const cookies = await Promise.all([w1.call('evidence', { view: 'network', path: '/api/' }), w2.call('evidence', { view: 'network', path: '/api/' })]);
  lacks('two workers: no requests leak between them (worker 1)', cookies[0], '/api/notifications', '/api/orders');
  lacks('two workers: no requests leak between them (worker 2)', cookies[1], '/api/login');
  // replays from both workers into the same directory at the same time
  const runs = await Promise.all([w1.call('flow', { action: 'run', name: 'order', vars: { base, notify: '200' } }), w2.call('flow', { action: 'run', name: 'order', vars: { base, notify: '500' } })]);
  has('parallel replays into one directory: both complete', runs.join('\n'), /1\/1 flows passed[\s\S]*1\/1 flows passed/);
  await Promise.all([w1.close(), w2.close()]);
  const sessions = readdirSync(path.join(shared, 'sessions'));
  check('parallel runs: one bundle per session, no overwrites', sessions.length === 4 && sessions.every((d) => existsSync(path.join(shared, 'sessions', d, 'summary.json'))), sessions.join(', '));
  const reports = readdirSync(path.join(shared, 'reports')).filter((f) => /^\d{4}.*\.html$/.test(f));
  check('parallel runs: each replay kept its own timestamped report', reports.length === 2, reports.join(', '));
  check('parallel runs: latest.html is a complete file (atomic replace)', /<\/html>\s*$/.test(readFileSync(path.join(shared, 'reports', 'latest.html'), 'utf8')));
  check('parallel runs: no temporary files left behind', !readdirSync(path.join(shared, 'reports')).some((f) => f.endsWith('.tmp')));
  const sums = sessions.map((d) => JSON.parse(readFileSync(path.join(shared, 'sessions', d, 'summary.json'), 'utf8')));
  check('bundles: each summary belongs to its own session id', new Set(sums.map((x) => x.sessionId)).size === 4 && sums.every((x) => x.schemaVersion === 1 && x.runId));
}

// ---------------------------------------------------------------- 4. bounded lifetime: repeated open/close, retention, origin restriction
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-safe-4-'));
  const s = await connect({ dir, config: { artifacts: { enabled: true, maxRuns: 3 }, browser: { ignoreHTTPSErrors: true } } });
  const { call } = s;
  for (let i = 0; i < 6; i++) {
    await call('open', { url: `${base}/orders?notify=${i % 2 ? 500 : 200}`, fresh: true });
    await call('act', { steps: place });
    if (i === 2) await call('close');
  }
  let out = await call('evidence', { view: 'summary' });
  has('repeated open/close: the current session only knows its own traffic', out, /requests: [1-9] observed/, /findings: 1 candidate/);
  await s.close();
  const kept = readdirSync(path.join(dir, 'sessions'));
  check('retention: only the newest artifacts.maxRuns bundles are kept', kept.length === 3, `${kept.length}: ${kept.join(', ')}`);
  mkdirSync(path.join(dir, 'sessions', 'my-notes'), { recursive: true });
  writeFileSync(path.join(dir, 'sessions', 'my-notes', 'keep.txt'), 'user file');
  // an old complete bundle (past retentionDays) and a recent interrupted one (no summary.json yet)
  const expired = path.join(dir, 'sessions', '20200101T000000Z-deadbeef');
  mkdirSync(expired, { recursive: true }); writeFileSync(path.join(expired, 'summary.json'), '{}');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const interrupted = path.join(dir, 'sessions', `${today}T000000Z-0badc0de`);
  mkdirSync(interrupted, { recursive: true }); writeFileSync(path.join(interrupted, 'observations.jsonl'), '');
  const r = await connect({ dir });
  await r.call('open', { url: `${base}/orders?notify=200`, fresh: true });
  await r.close();
  check('retention never touches anything that is not a fastqa run directory', existsSync(path.join(dir, 'sessions', 'my-notes', 'keep.txt')));
  check('retention removes a bundle older than artifacts.retentionDays', !existsSync(expired));
  check('retention keeps a recent bundle that is still being written', existsSync(interrupted));

  // failure screenshots are bounded too
  const shots = mkdtempSync(path.join(tmpdir(), 'fq-safe-4s-'));
  mkdirSync(path.join(shots, 'artifacts'), { recursive: true });
  writeFileSync(path.join(shots, 'artifacts', 'my-design.jpg'), 'user file');
  const p = await connect({ dir: shots, config: { artifacts: { maxScreenshots: 2 }, browser: { ignoreHTTPSErrors: true } } });
  await p.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  for (let i = 0; i < 5; i++) await p.call('act', { steps: [{ do: 'click', target: `No such button ${i}`, timeout: 200 }] });
  await p.close();
  const jpgs = readdirSync(path.join(shots, 'artifacts'));
  check('failure screenshots: only the newest artifacts.maxScreenshots are kept, user files are left alone', jpgs.filter((f) => /^fail-\d+\.jpg$/.test(f)).length === 2 && jpgs.includes('my-design.jpg'), jpgs.join(', '));

  const o = await connect({ prefix: 'fq-safe-4o-', config: { browser: { allowedOrigins: [base], ignoreHTTPSErrors: true } } });
  out = await o.call('open', { url: 'http://localhost:1/elsewhere' });
  has('browser.allowedOrigins: other origins are refused before navigating', out, 'origin http://localhost:1 is not in browser.allowedOrigins');
  out = await o.call('open', { url: `${base}/login` });
  has('browser.allowedOrigins: the allowed origin opens', out, 'title: Login');
  await o.close();

  let res = await cli('run ../../etc/passwd', { FASTQA_DIR: dir });
  check('CLI: a flow name cannot leave the flows directory', res.code === 2 && !/root:/.test(res.stdout + res.stderr), `${res.code} ${res.stderr.slice(0, 200)}`);
}

srv.close();
process.exit(done() ? 1 : 0);
