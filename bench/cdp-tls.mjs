// Two environment-dependent checks that are not part of `npm test`:
//   1. FASTQA_CDP_URL: attaching to a running Chromium that also has a tab fastqa does not drive.
//   2. TLS: invalid certificates with and without a config file (needs `openssl` on PATH to make a throwaway certificate;
//      skipped with a notice when it is missing).
// Usage: node bench/cdp-tls.mjs      (after npm run build)
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const { has, lacks, check, done } = suite('cdp-tls');
const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const place = [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }];

// ---------------------------------------------------------------- 1. attached browser (CDP)
{
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'fq-cdp-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, args: [`--remote-debugging-port=${port}`], executablePath: process.env.FASTQA_CHROME || undefined });
  // two tabs exist before fastqa attaches; which one it drives is up to the browser's page order
  const tabA = ctx.pages()[0] ?? await ctx.newPage();
  const tabB = await ctx.newPage();
  await tabA.goto('about:blank'); await tabB.goto('about:blank');
  const s = await connect({ prefix: 'fq-cdp-', env: { FASTQA_CDP_URL: `http://127.0.0.1:${port}` } });
  let out = await s.call('open', { url: `${base}/orders?notify=off` });
  has('CDP: attaches and opens the page in one of the existing tabs', out, 'title: Orders', 'button "Place order"');
  // the tab fastqa did not take belongs to someone else: it starts polling an endpoint that fails
  const other = tabA.url().includes('/orders') ? tabB : tabA;
  check('CDP: exactly one tab was taken', tabA.url().includes('/orders') !== tabB.url().includes('/orders'), `${tabA.url()} | ${tabB.url()}`);
  await other.goto(`${base}/orders?poll=120&pollStatus=500&notify=off`);
  out = await s.call('act', { steps: [...place, { do: 'wait', value: '600' }, { do: 'expect_no_errors' }] });
  has('CDP: errors of a tab fastqa does not drive do not fail expect_no_errors', out, /^PASSED 4\/4/);
  lacks('CDP: the other tab\'s failing polls are not findings or failed requests here', out, '/api/poll', 'failed request(s)', 'NET-5XX');
  out = await s.call('evidence', { view: 'network', path: '/api/poll' });
  check('CDP: no request of the other tab is recorded', !/^R-\d+ /m.test(out), out);
  // a fresh cycle on an attached browser keeps the context: page listeners must be bound again
  out = await s.call('open', { url: `${base}/orders?notify=off`, fresh: true });
  const ref = /(e\d+) button "Place order"/.exec(out)?.[1];
  await s.call('open', { url: `${base}/login` });
  out = await s.call('act', { steps: [{ do: 'click', target: ref }], strict: true });
  has('CDP: after `open fresh`, navigation is still tracked (stale refs are rejected)', out, /^FAILED/, `Stale ref ${ref}: the page navigated after it was issued`);
  await s.call('open', { url: `${base}/orders?notify=500` });
  out = await s.call('act', { steps: place });
  has('CDP: observation of the driven tab works as usual', out, /^PASSED 2\/2/, 'NET-5XX POST /api/notifications returned 500');
  await s.close();
  check('CDP: closing fastqa leaves the attached browser and its other tab alone', !other.isClosed());
  await ctx.close();
}

// ---------------------------------------------------------------- 2. TLS defaults
{
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-tls-'));
  let made = false;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    made = existsSync(path.join(dir, 'cert.pem'));
  } catch { /* no openssl */ }
  if (!made) {
    console.log('skip TLS checks: `openssl` is not available to create a throwaway certificate');
  } else {
    const tls = https.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Secure shop</title><h1>Self-signed</h1>'); });
    await new Promise((r) => tls.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${tls.address().port}/`;

    const legacy = await connect({ prefix: 'fq-tls-a-' });
    let out = await legacy.call('open', { url });
    has('no config file: an invalid certificate is accepted (0.3 behaviour)', out, 'title: Secure shop');
    await legacy.close();
    has('no config file: a warning says so on stderr, once', legacy.stderr.join(''), 'invalid HTTPS certificates are accepted (0.3 default)');
    check('no config file: the warning is printed once', legacy.stderr.join('').split('invalid HTTPS certificates').length === 2);

    const secure = await connect({ prefix: 'fq-tls-b-', config: { schemaVersion: 1 } });
    out = await secure.call('open', { url });
    has('with a config file: an invalid certificate is rejected, and the message says how to allow it', out, /ERR_CERT/, 'browser.ignoreHTTPSErrors: true');
    await secure.close();
    lacks('with a config file: no legacy warning', secure.stderr.join(''), '0.3 default');

    const allowed = await connect({ prefix: 'fq-tls-c-', config: { browser: { ignoreHTTPSErrors: true } } });
    has('browser.ignoreHTTPSErrors: true accepts it', await allowed.call('open', { url }), 'title: Secure shop');
    await allowed.close();

    const env = await connect({ prefix: 'fq-tls-d-', env: { FASTQA_IGNORE_HTTPS_ERRORS: 'false' } });
    has('FASTQA_IGNORE_HTTPS_ERRORS=false rejects it even without a config file', await env.call('open', { url }), /ERR_CERT/);
    await env.close();
    tls.close();
  }
}

srv.close();
process.exit(done() ? 1 : 0);
