// Locator and session safety (FQA-004), load and isolation: strict locators, stale refs, queued calls,
// independent workers, artifact collisions, repeated open/close, origin restriction.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, rawServer, suite, cli } from './lib.mjs';

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
  // 1.0.4 (FQA-04): the same label in different rows is a different record each time, so it is no longer guessed
  has('default: a duplicate label in different rows is refused, with the rows', out, /^FAILED at step 1\/2/, 'in different rows or cards', 'Order #1001', 'Order #1002');
  out = await call('act', { steps: [{ do: 'click', target: 'Details', within: 'Order #1001' }, { do: 'expect_text', value: 'Details of Order #1001' }] });
  has('default: within picks the row', out, /^PASSED 2\/2/);
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
  has('concurrent calls are queued: the snapshot, sent last, sees the value of the second batch', snap, 'textbox "Quantity" ="7"');
  let out = await call('evidence', { view: 'timeline', limit: 100 });
  const order = [...out.matchAll(/(A-\d+) (fill|wait|expect_value)/g)].map((m) => m[2]).join(',');
  check('concurrent calls are queued: actions of the two batches never interleave (whichever ran first)', order.endsWith('fill,wait,expect_value,fill,wait,expect_value'), order);
  await s.close();
}

// ---------------------------------------------------------------- 2b. requests that arrive in one read run in arrival order
// The SDK validates arguments asynchronously, so a call with a small schema used to overtake calls read before it.
// Seen on a CI runner: the snapshot ran before both batches. One write makes that deterministic.
{
  const r = await rawServer({ prefix: 'fq-safe-2b-' });
  let p = r.answer(1); r.write(r.tool(1, 'open', { url: `${base}/orders?notify=off`, fresh: true })); await p;
  const all = Promise.all([11, 12, 13, 14].map(r.answer));
  r.write(
    r.tool(11, 'act', { steps: [{ do: 'fill', target: 'Quantity', value: '3' }, { do: 'wait', value: '300' }, { do: 'expect_value', target: 'Quantity', value: '3' }] }) +
    r.tool(12, 'act', { steps: [{ do: 'fill', target: 'Quantity', value: '7' }, { do: 'wait', value: '100' }, { do: 'expect_value', target: 'Quantity', value: '7' }] }) +
    r.tool(13, 'snapshot') +
    r.tool(14, 'act', { steps: [{ do: 'expect_value', target: 'Quantity', value: '7' }] }),
  );
  const [a, b, snap, c] = (await all).map(r.textOf);
  check('one read, four calls: answered in arrival order', r.order.filter((id) => typeof id === 'number' && id > 10).join(',') === '11,12,13,14', r.order.join(','));
  has('one read, four calls: each batch passes with its own value', `${a}\n---\n${b}\n---\n${c}`, /^PASSED 3\/3/, /\n---\nPASSED 3\/3/, /\n---\nPASSED 1\/1/);
  has('one read, four calls: the snapshot sent third sees the value of the second batch', snap, 'textbox "Quantity" ="7"');
  // a call cancelled while it waits never runs; one cancelled while it runs gives up its turn, and nothing interleaves
  const rest = Promise.all([21, 23].map(r.answer));
  r.write(
    r.tool(21, 'act', { steps: [{ do: 'fill', target: 'Quantity', value: '21' }, { do: 'wait', value: '300' }, { do: 'expect_value', target: 'Quantity', value: '21' }] }) +
    r.tool(22, 'act', { steps: [{ do: 'fill', target: 'Quantity', value: '22' }] }) +
    r.notify('notifications/cancelled', { requestId: 22, reason: 'test' }) +
    r.tool(23, 'snapshot'),
  );
  const [first, last] = (await rest).map(r.textOf);
  has('a call cancelled while waiting: the call before it completes', first, /^PASSED 3\/3/);
  has('a call cancelled while waiting never runs: the next call sees the value before it', last, 'textbox "Quantity" ="21"');
  check('a call cancelled while waiting gets no answer', !r.order.includes(22), r.order.join(','));
  await r.close();
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

// ---------------------------------------------------------------- 5. close answers when the browser is gone
// Playwright deletes the browser's temporary profile folder as the last part of browser.close(). On Windows that waits for
// as long as another program (antivirus, indexer) holds a file in the folder, long after the browser has exited: the
// close call used to hang for that whole time and clients gave up on it. Only Windows refuses to delete an open file.
if (process.platform === 'win32') {
  const profiles = () => readdirSync(tmpdir()).filter((n) => n.startsWith('playwright_chromiumdev_profile-'));
  const before = new Set(profiles());
  const s = await connect({ prefix: 'fq-safe-5-' });
  await s.call('open', { url: `${base}/login` });
  const mine = profiles().filter((n) => !before.has(n)).map((n) => path.join(tmpdir(), n));
  // "another program": a second process opens a file in the profile without sharing it, and keeps it open for 8 seconds
  const HOLD_MS = 8000;
  const locks = mine.map((dir) => {
    const f = path.join(existsSync(path.join(dir, 'Default')) ? path.join(dir, 'Default') : dir, 'held-by-another-program.tmp');
    writeFileSync(f, 'x');
    return spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${f}','Open','ReadWrite','None'); 'locked'; Start-Sleep -Milliseconds ${HOLD_MS}; $f.Close()`], { stdio: ['ignore', 'pipe', 'ignore'] });
  });
  await Promise.all(locks.map((p) => new Promise((r) => p.stdout.once('data', r))));
  const released = Promise.all(locks.map((p) => new Promise((r) => p.once('exit', r))));
  const t0 = Date.now();
  let out = await s.call('close');
  const ms = Date.now() - t0;
  check('close: answers although another program still holds a file in the browser profile', mine.length > 0 && out === 'closed' && ms < HOLD_MS - 2000, `${mine.length} profile folder(s), answered ${JSON.stringify(out)} after ${ms}ms (the file is held for ${HOLD_MS}ms)`);
  out = await s.call('open', { url: `${base}/login` });
  has('close: the next open works while the old profile is still being cleaned up', out, 'title: Login');
  await s.call('close');
  await released;
  const end = Date.now() + 15000;
  while (mine.some((d) => existsSync(d)) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  check('close: the profile folder is removed once the other program lets go', !mine.some((d) => existsSync(d)), mine.filter((d) => existsSync(d)).join(', '));
  await s.c.close();
} else {
  console.log('skip close: the locked-profile check needs Windows (other systems delete open files)');
}

srv.close();
process.exit(done() ? 1 : 0);
