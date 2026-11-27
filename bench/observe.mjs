// Observation, correlation and continuous detection through real MCP stdio, against the fault fixtures of the demo shop.
// Every scenario is deterministic: behaviour is selected by query parameters of /orders (see demo-server.mjs).
import { start } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('observe');
const s = await connect({ prefix: 'fq-obs-' });
const { call } = s;
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];

// --- 1. First demo: the UI reports success, a fire-and-forget call fails. No assertion asked for it.
await call('open', { url: `${base}/orders?notify=500`, fresh: true });
let out = await call('act', { steps: place });
has('hidden 500: steps still pass (assertion semantics unchanged)', out, /^PASSED 2\/2 steps/);
has('hidden 500: candidate surfaced without an assertion', out, 'QA: 1 new candidate finding (highest HIGH)', /F-001 HIGH NET-5XX POST \/api\/notifications returned 500/);
has('hidden 500: tied to the action that started the request, uncertainty stated', out, /A-\d+ click "Place order" \(inferred\)/, /E-\d+/);
has('hidden 500: finding is a lead, not a verdict', out, 'leads, not confirmed defects');
out = await call('evidence', { view: 'findings', finding: 'F-001', details: true });
has('evidence drill-down: finding, association reason and events', out, 'F-001', 'NET-5XX', 'request started', '/api/notifications', /status.{1,4}500/);
out = await call('act', { steps: [{ do: 'expect_text', value: 'Thank you' }] });
has('a finding is reported once: the next batch is clean', out, 'QA: clean');
lacks('a finding is reported once: not repeated', out, 'F-001');

// --- 2. Healthy batch: no findings, one short line, legacy output intact.
await call('open', { url: `${base}/login`, fresh: true });
out = await call('act', { steps: [
  { do: 'fill', target: 'Email', value: 'john@example.com' }, { do: 'fill', target: 'Password', value: '{{password}}' },
  { do: 'click', target: 'Log in' }, { do: 'expect_text', value: 'Welcome back' },
  { do: 'check', target: 'css=#card-tshirt .tc' }, { do: 'click', target: 'Add Blue T-shirt to cart' },
  { do: 'expect_text', value: 'Added to cart: Blue T-shirt' }, { do: 'select', target: 'Currency', value: 'GBP' },
] });
has('healthy batch: passes with the 0.3 layout', out, /^PASSED 8\/8 steps in \d+ms\n✓ fill "Email" "john@example.com"/, '--- navigated, new page ---', '✓ fill "Password" "•••"');
// since 1.1 the clean line also says whether anything was verified (additive suffix): " · 2/2 assertions passed"
has('healthy batch: one compact clean line', out, /\nQA: clean · \d+ requests observed · 2\/2 assertions passed$/);
lacks('healthy batch: no findings, no history dump', out, 'F-0', 'candidate', 'E-1');

// --- 3. Delayed failure crossing an action: A starts the request, B runs, the 500 arrives during B.
await call('open', { url: `${base}/orders?notify=500&notifyDelay=2200`, fresh: true });
out = await call('act', { steps: [...place, { do: 'click', target: 'Check stock' }, { do: 'expect_text', value: 'In stock' }, { do: 'wait', value: '900' }] });
has('delayed failure: attributed to the action that started it, not the one running when it arrived', out, /NET-5XX POST \/api\/notifications returned 500 — A-\d+ click "Place order" \(inferred\)/);
lacks('delayed failure: never blamed on the later action', out, /notifications returned 500 — [^\n]*Check stock/);
out = await call('evidence', { view: 'network', path: '/api/stock' });
has('overlap: a request that starts while an earlier action still has one in flight is ambiguous', out, /GET \/api\/stock\b.*ambiguous/, /still had requests in flight/);

// --- 4. Delayed failure crossing a batch: surfaced later, under its original id, marked late; partial state explicit.
await call('open', { url: `${base}/orders?notify=500&notifyDelay=4200`, fresh: true });
out = await call('act', { steps: place });
has('late: batch returns before the response, coverage says so', out, /^PASSED 2\/2/, 'QA: no findings so far', /coverage partial \(1 pending\)/);
lacks('late: no finding yet', out, 'F-0');
out = await call('act', { steps: [{ do: 'wait', value: '2600' }] });
has('late: next result surfaces it, attributed to the original action', out, /F-001 HIGH NET-5XX POST \/api\/notifications returned 500 — late · A-\d+ click "Place order" \(inferred\)/);

// --- 5. Negative test: an expected 422 is not a misleading candidate once the agent asserts it.
await call('open', { url: `${base}/orders?notify=off`, fresh: true });
const negative = [{ do: 'fill', target: 'Quantity', value: '0' }, { do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Quantity must be at least 1' }];
out = await call('act', { steps: negative });
has('negative test without a declaration: low candidate, steps pass', out, /^PASSED 3\/3/, /LOW NET-4XX POST \/api\/orders returned 422/);
await call('open', { url: `${base}/orders?notify=off`, fresh: true });
out = await call('act', { steps: [...negative, { do: 'expect_request', target: 'POST /api/orders', value: '422' }] });
has('negative test with expect_request 422: clean', out, /^PASSED 4\/4/, 'QA: clean');
lacks('negative test with expect_request 422: no candidate', out, 'NET-4XX');
out = await call('evidence', { view: 'findings', status: 'all' });
has('negative test: the fact is kept, classified as expected', out, 'NET-4XX', 'expected', 'explicit expect_request');
await call('open', { url: `${base}/orders?notify=off`, fresh: true });
out = await call('act', { steps: [...negative, { do: 'expect_request', target: 'POST /api/orders', value: '2xx', timeout: 300 }] });
has('an explicit assertion that conflicts with the response still fails', out, /^FAILED at step 4\/4/, 'status not 2xx');

// --- 6. Background polling is not blamed on actions.
await call('open', { url: `${base}/orders?poll=250&notify=off`, fresh: true });
await call('act', { steps: [{ do: 'wait', value: '2300' }] });
await call('act', { steps: [{ do: 'click', target: 'css=#list li:nth-of-type(1) .det' }, { do: 'wait', value: '400' }] });
out = await call('evidence', { view: 'network', path: '/api/poll', limit: 50 });
has('polling: starts without an action are unattributed', out, /GET \/api\/poll\b.*unattributed/);
has('polling: a start during a later action is ambiguous, not blamed on it', out, /GET \/api\/poll\b.*ambiguous/, 'background traffic');

// --- 7. Redirect chain, transport failure, same-URL concurrency, uncaught exception, popup.
await call('open', { url: `${base}/orders?stock=fail&notify=off`, fresh: true });
out = await call('act', { steps: [{ do: 'click', target: 'Check stock' }, { do: 'expect_text', value: 'Stock unknown' }] });
has('redirect: the final hop keeps the association of the request that started the chain', out, /NET-5XX GET \/api\/stock\/v2 returned 500 — A-\d+ click "Check stock" \(inferred\)/);
out = await call('evidence', { view: 'network', path: '/api/stock' });
has('redirect: hops are linked', out, /302/, /redirect of R-\d+/);
out = await call('act', { steps: [{ do: 'click', target: 'Sync' }, { do: 'wait', value: '300' }] });
has('transport failure: reported as NET-FAIL, separate from HTTP errors', out, /MEDIUM NET-FAIL GET \/api\/drop failed: ERR_/, /click "Sync" \(inferred\)/);
out = await call('act', { steps: [{ do: 'click', target: 'Refresh prices' }, { do: 'expect_text', value: 'Prices updated' }] });
has('same-URL concurrency: only the failing request is reported', out, /NET-5XX GET \/api\/prices returned 500/);
out = await call('evidence', { view: 'network', path: '/api/prices' });
check('same-URL concurrency: two distinct request records', (out.match(/R-\d+ .*GET \/api\/prices/g) ?? []).length === 2 && /\b200\b/.test(out) && /\b500\b/.test(out), out);
out = await call('act', { steps: [{ do: 'click', target: 'Print' }, { do: 'wait', value: '200' }] });
has('uncaught exception: candidate tied to the click', out, /MEDIUM JS-EXCEPTION Uncaught exception: printer is not defined — A-\d+ click "Print" \(inferred\)/);
out = await call('act', { steps: [{ do: 'click', target: 'Open receipt' }, { do: 'expect_text', value: 'Total 19.99 EUR' }] });
has('popup: steps continue on the new page', out, /^PASSED 2\/2/);
out = await call('evidence', { view: 'network', path: '/api/receipt' });
has('popup: its requests are tracked under their own page id and tied to the click', out, /GET \/api\/receipt\b.*\b200\b.*P-2.*click "Open receipt" \(inferred\)/);

// --- 8. A request that never completes stays visible as partial coverage; nothing waits for it forever.
await call('open', { url: `${base}/orders?hang=1&notify=off`, fresh: true });
const t0 = Date.now();
out = await call('act', { steps: place });
has('hanging request: partial coverage is explicit', out, /^PASSED 2\/2/, /coverage partial \(1 pending\)/);
check('hanging request: the batch stays bounded', Date.now() - t0 < 6000, `${Date.now() - t0}ms`);

// --- 9. Session isolation and evidence lifecycle.
out = await call('evidence', { view: 'summary' });
const sid1 = /session (S-\w+)/.exec(out)?.[1];
await call('open', { url: `${base}/login`, fresh: true });
out = await call('evidence', { view: 'summary' });
const sid2 = /session (S-\w+)/.exec(out)?.[1];
check('fresh context = new session', !!sid1 && !!sid2 && sid1 !== sid2, `${sid1} vs ${sid2}`);
has('fresh context: no findings or requests leak from the previous session', out, /findings: 0\b/);
lacks('fresh context: no earlier traffic', out, '/api/hang', '/api/orders');
await call('open', { url: `${base}/orders?notify=500`, fresh: true });
await call('act', { steps: place });
await call('close');
out = await call('evidence', { view: 'findings' });
has('after close: evidence of the last session is still readable', out, 'F-001', 'NET-5XX');
out = await call('evidence');
has('legacy evidence (no arguments) keeps its 0.3 format', out, /^page errors \(\d+\)\n/, /\nconsole \(\d+\)/, /\nfailed requests \(\d+\)/);

await s.close();
srv.close();
process.exit(done() ? 1 : 0);
