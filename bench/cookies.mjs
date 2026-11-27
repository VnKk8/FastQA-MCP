// Cookie banners: open {cookies}, the cookies step in act, the FASTQA_COOKIES default, record / replay / export.
// Fixtures: bench/cookie-pages.mjs (each page shows "consent: none | accepted | rejected").
import { writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('cookies');

// ---------------------------------------------------------------- 1. open {cookies}
{
  const s = await connect({ prefix: 'fq-cookie-1-' });
  const open = (page, cookies) => s.call('open', { url: `${base}${page}`, fresh: true, ...(cookies ? { cookies } : {}) });

  let out = await open('/cookies/onetrust', 'accept');
  has('known consent tool: accept clicks its accept button', out, 'consent: accepted', '✓ cookies "accept" — clicked "Tout autoriser"');
  lacks('known consent tool: the banner is gone from the snapshot', out, 'button "Tout autoriser"', 'button "Cookies Settings"');
  out = await open('/cookies/onetrust', 'reject');
  has('known consent tool: reject clicks its reject button', out, 'consent: rejected', 'clicked "Refuser"');

  out = await open('/cookies/generic', 'accept');
  has('unknown banner: accept finds the button by its words', out, 'consent: accepted', 'clicked "Accept all"');
  has('unknown banner: an "Accept" button outside the banner is left alone', out, 'invitation: open');
  out = await open('/cookies/generic', 'reject');
  has('unknown banner: reject picks "Only necessary", not the settings button', out, 'consent: rejected', 'clicked "Only necessary"');

  out = await open('/cookies/bg', 'accept');
  has('Bulgarian banner: accept', out, 'consent: accepted', 'clicked "Приемам всички"');
  out = await open('/cookies/bg', 'reject');
  has('Bulgarian banner: reject', out, 'consent: rejected', 'clicked "Отхвърлям"');

  out = await open('/cookies/frame', 'accept');
  has('banner inside an iframe: accept', out, 'consent: accepted', 'clicked "I agree"');
  out = await open('/cookies/frame', 'reject');
  has('banner inside an iframe: reject', out, 'consent: rejected', 'clicked "Reject all"');

  out = await open('/cookies/shadow', 'accept');
  has('banner inside shadow DOM: accept', out, 'consent: accepted', 'clicked "Accept All"');
  out = await open('/cookies/shadow', 'reject');
  has('banner inside shadow DOM: reject', out, 'consent: rejected', 'clicked "Deny"');

  out = await open('/cookies/overlay', 'accept');
  has('a nearly transparent input over a label: accept, reported with the label people see', out, 'consent: accepted', 'clicked "Akzeptieren"');
  out = await open('/cookies/overlay', 'reject');
  has('a nearly transparent input over a label: reject', out, 'consent: rejected', 'clicked "Ablehnen"');
  out = await open('/cookies/paywall', 'reject');
  has('"Reject all and subscribe" is a paywall, not a reject button', out, 'it has no reject button', 'consent: none');
  has('the buttons it saw are listed one by one', out, '(saw "Reject all and subscribe", "Accept all")');
  out = await open('/cookies/paywall', 'accept');
  has('pay or accept: accept still works', out, 'consent: accepted', 'clicked "Accept all"');

  out = await open('/cookies/bg-consent', 'accept');
  has('a consent request that never says "cookie" (Bulgarian wording)', out, 'consent: accepted', 'clicked "Съгласен съм"');
  out = await open('/cookies/reload', 'accept');
  has('a site that loads a slow new page after the answer: the result shows that page', out, 'clicked "Accept all"', 'title: Cookies reloaded', 'consent: accepted');
  lacks('a site that loads a slow new page after the answer: no internal error', out, 'TypeError', 'Cannot read');

  out = await open('/consent', 'reject');
  has('a consent page in front of the site: answered, then the site opens', out, 'title: Cookies none', 'consent: rejected', 'clicked "Reject all"');

  const t0 = Date.now();
  out = await open('/cookies/none', 'accept');
  has('no banner: says so and clicks nothing', out, '✓ cookies "accept" — no cookie banner found', 'consent: none', 'invitation: open');
  // speed: a page that has stopped fetching is not waited on for the full 2.5 s
  check('no banner on a quiet page: answered without the full wait', Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  out = await open('/cookies/generic?delay=600', 'accept');
  has('a banner that shows 0.6 s after a quiet page loaded is still caught', out, 'consent: accepted', 'clicked "Accept all"');
  out = await open('/cookies/generic?delay=1800&busy=1', 'accept');
  has('a page that is still fetching is waited for: its banner shows after 1.8 s', out, 'consent: accepted', 'clicked "Accept all"');
  out = await open('/cookies/signin', 'accept');
  has('a sign-in pop-up that mentions the cookie policy: nothing in it counts as accepting', out, 'consent: none', 'it has no accept button');
  lacks('a sign-in pop-up that mentions the cookie policy: "Continue" is not clicked', out, 'clicked "');
  out = await open('/cookies/patient', 'accept');
  has('a consent dialog of the application itself (not about cookies) is left alone', out, 'consent: none', 'no cookie banner found');
  out = await open('/cookies/patient', 'reject');
  has('a consent dialog of the application itself is not declined either', out, 'consent: none', 'no cookie banner found');
  out = await open('/cookies/bg-free', 'accept');
  has('Bulgarian "accept and read for free" is an accept button; the paid option is not', out, 'consent: accepted', 'clicked "Приемам и чета безплатно"');
  out = await open('/cookies/newsletter', 'accept');
  has('a pop-up that is not about cookies is left alone', out, 'no cookie banner found', 'consent: none');

  out = await open('/cookies/accept-only', 'reject');
  has('nothing to reject with: names the buttons it saw and leaves the banner', out, 'it has no reject button', 'Got it!', 'consent: none');
  out = await open('/cookies/accept-only', 'accept');
  has('a single "Got it!" button counts as accept', out, 'consent: accepted', 'clicked "Got it!"');

  out = await open('/cookies/generic?delay=0');
  has('default: the banner is left alone', out, 'button "Accept all"', 'consent: none');
  lacks('default: no cookies line in the result', out, 'cookies "');

  // ---------------------------------------------------------------- 2. the step, on its own and in flows
  out = await s.call('act', { steps: [{ do: 'cookies', value: 'reject' }, { do: 'expect_text', value: 'consent: rejected' }, { do: 'click', target: 'Load more' }, { do: 'expect_text', value: 'more loaded' }] });
  has('act: the cookies step works between other steps', out, /^PASSED 4\/4/, '✓ cookies "reject" — clicked "Only necessary"');
  out = await s.call('act', { steps: [{ do: 'cookies', value: 'accept' }] });
  has('act: asking again when the banner is gone is harmless', out, /^PASSED 1\/1/, 'no cookie banner found');
  out = await s.call('act', { steps: [{ do: 'cookies', value: 'maybe' }] });
  has('act: an unknown choice is an error that names the valid ones', out, /^FAILED at step 1\/1/, '"accept" or "reject"');

  await open('/cookies/generic', 'accept');
  await s.call('act', { steps: [{ do: 'click', target: 'Load more' }, { do: 'expect_text', value: 'more loaded' }, { do: 'expect_text', value: 'consent: accepted' }] });
  await s.call('flow', { action: 'save', name: 'news' });
  out = await s.call('flow', { action: 'show', name: 'news' });
  has('flow: open {cookies} is recorded as a step', out, /^1\. goto /m, '2. cookies "accept"', /^3\. click /m);
  out = await s.call('flow', { action: 'run', name: 'news' });
  has('flow: the replay (fresh context, banner is back) dismisses it again', out, '1/1 flows passed');
  out = await s.call('flow', { action: 'export', name: 'news' });
  has('flow: the exported spec carries the cookie step as code', out, 'await fq.cookies("accept");', 'function findConsentButton');
  lacks('flow: nothing is left unsupported', out, 'fastqa:unsupported');
  await s.close();

  writeFileSync(path.join(s.dir, 'playwright.config.mjs'), `export default { testDir: './tests', reporter: 'line', use: { launchOptions: { executablePath: ${JSON.stringify(process.env.FASTQA_CHROME || '')} || undefined } } };`);
  let spec = '';
  try {
    const r = await promisify(exec)(`node "${path.resolve('node_modules/@playwright/test/cli.js')}" test -c "${s.dir}/playwright.config.mjs"`, { cwd: s.dir, env: { ...process.env, NODE_PATH: path.resolve('node_modules') } });
    spec = r.stdout;
  } catch (e) { spec = `EXPORTED SPEC FAILED\n${e.stdout}${e.stderr}`; }
  has('flow: the exported spec passes with @playwright/test', spec, /1 passed/);
}

// ---------------------------------------------------------------- 3. the FASTQA_COOKIES default
{
  const e = await connect({ prefix: 'fq-cookie-3-', env: { FASTQA_COOKIES: 'reject' } });
  let out = await e.call('open', { url: `${base}/cookies/generic`, fresh: true });
  has('FASTQA_COOKIES=reject: every open rejects', out, 'consent: rejected', 'clicked "Only necessary"');
  const t0 = Date.now();
  out = await e.call('open', { url: `${base}/cookies/generic` });
  const ms = Date.now() - t0;
  has('same site again: the site remembers, there is nothing to do', out, 'no cookie banner found', 'consent: rejected');
  // the full wait for a banner alone is 2.5 s; a later page of the same site gets 0.8 s
  check('same site again: only the short wait for a banner', ms < 2400, `${ms}ms`);
  out = await e.call('open', { url: `${base}/cookies/bg?delay=500` });
  has('same site, another page whose banner shows half a second late: still answered', out, 'consent: rejected', 'clicked "Отхвърлям"');
  out = await e.call('open', { url: `${base}/cookies/bg?delay=0`, cookies: 'keep', fresh: true });
  has('cookies "keep" leaves the banner although the default says reject', out, 'consent: none', 'button "Приемам всички"');
  await e.close();

  const bad = await connect({ prefix: 'fq-cookie-3b-', env: { FASTQA_COOKIES: 'maybe' } });
  out = await bad.call('open', { url: `${base}/cookies/generic?delay=0`, fresh: true });
  has('FASTQA_COOKIES with an unknown value: ignored, the banner stays', out, 'consent: none', 'button "Accept all"');
  has('FASTQA_COOKIES with an unknown value: a warning says which values exist', bad.stderr.join(''), 'FASTQA_COOKIES', 'accept', 'reject');
  await bad.close();
}

srv.close();
process.exit(done() ? 1 : 0);
