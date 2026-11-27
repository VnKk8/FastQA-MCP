// What fastqa tells the agent so it can reason without extra calls: field rules, the effect of each action, why a step
// failed, page facts on open; and the QA rules that find bugs nobody asked about (silent failures, double submits,
// dead clicks, broken images). Fixtures: bench/facts-pages.mjs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite } from './lib.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const { has, lacks, check, done } = suite('facts');

const s = await connect({ prefix: 'fq-facts-' });
const open = (p) => s.call('open', { url: `${base}${p}`, fresh: true });
const act = (steps, extra = {}) => s.call('act', { steps, ...extra });

// ---------------------------------------------------------------- 1. field rules and validation in the snapshot
let out = await open('/facts/form');
has('snapshot: the rules a field enforces are on its line', out,
  /textbox "Email" \[required\] type:email/, /textbox "Mobile" \[required\] type:tel maxlength:10 pattern:\\d\{10\}/,
  /textbox "Age" type:number min:18 max:120/, /textbox "Nickname" minlength:2/);
lacks('snapshot: a password field does not get a type token', out, 'type:password');
lacks('snapshot: untouched required fields are not called invalid yet', out, '[invalid', 'invalid:"');
has('open: one line of page facts', out, /↳ page: 1 form, 5 fields \(2 required\)/);

// ---------------------------------------------------------------- 6, 7. what the field holds, and a submit the browser blocked
out = await act([{ do: 'click', target: 'Register' }]);
has('a submit the browser blocked: said, with the fields and their messages', out,
  /↳ nothing sent: the browser blocked the form\. Invalid: "Email" \(Please fill (out|in) this field\.\), "Mobile"/);
has('after a blocked submit, the snapshot shows the validation messages', await s.call('snapshot', {}), /textbox "Email" \[required\] type:email invalid:"Please fill (out|in) this field\."/);
out = await act([{ do: 'fill', target: 'Mobile', value: '12345678901' }, { do: 'fill', target: 'Email', value: 'abc' }, { do: 'fill', target: 'Password', value: 'secret-pass-1' }]);
has('fill: a field that holds something else than was typed says so', out, '↳ field holds "1234567890" (maxlength 10)');
check('fill: a field that holds what was typed adds no line', (out.match(/field holds/g) ?? []).length === 1, out);
has('the snapshot shows the browser\'s message for an invalid email', out, /textbox "Email" ="abc" \[required\] type:email invalid:"Please include an '@'/);
has('…and a field that became valid loses it', out, /\+ e\d+ textbox "Mobile" ="1234567890" \[required\] type:tel/);
out = await act([{ do: 'fill', target: 'Mobile', value: '0123456789' }, { do: 'fill', target: 'Email', value: 'a@b.co' }, { do: 'click', target: 'Register' }, { do: 'expect_text', value: 'Registered' }]);
has('an action that sends a request: its effect is one line', out, /✓ click "Register" \(\d+ms\)\n  ↳ POST \/api\/facts\/ok 200 \d+ms/);

await open('/facts/radios');
out = await act([{ do: 'click', target: 'Continue' }]);
has('a required radio group is reported once, by its legend', out, '↳ nothing sent: the browser blocked the form. Invalid: "Plan" (Please select one of these options.)');
lacks('…not once per option', out, '"Free" (', '"Pro" (');

// ---------------------------------------------------------------- 4, 5. effects: vanishing messages, native dialogs
await open('/facts/toast');
out = await act([{ do: 'click', target: 'Save profile' }, { do: 'wait', value: '700' }]);
has('a message that came and went before the result is reported on its action', out, /✓ click "Save profile" \(\d+ms\)\n  ↳ POST \/api\/facts\/ok 200 \d+ms · status "Profile saved" came and went/);
lacks('…and it is really gone from the page', out, '+ status "Profile saved"');
await open('/facts/confirm');
out = await act([{ do: 'click', target: 'Delete item' }, { do: 'expect_text', value: 'item: kept' }]);
has('a native confirm dialog is reported, and dismissed as before', out, '↳ confirm "Delete this item?" was dismissed', '✓ expect_text "item: kept"');

// ---------------------------------------------------------------- 3. why a step failed
await open('/facts/near');
out = await act([{ do: 'click', target: 'Log in', timeout: 500 }]);
has('a target that is not there: the closest names are listed with refs', out, /✗ click "Log in" — No visible element matches "Log in".*\n  ↳ closest: button "Login" e\d+/);
await open('/facts/blocked');
out = await act([{ do: 'click', target: 'Pay now', timeout: 1000 }]);
has('a covered button: what covers it (as Playwright prints the element)', out, '↳ "Pay now" is covered by <div id="overlay" class="cookie-banner">');
out = await act([{ do: 'click', target: 'Submit payment', timeout: 1000 }]);
has('a disabled submit: the empty required fields', out, '↳ "Submit payment" stayed disabled. Empty required fields: "Card holder", "Card number"');

// ---------------------------------------------------------------- 2. QA rules: silent failure, double submit, dead click, broken image
await open('/facts/silent');
out = await act([{ do: 'click', target: 'Save loudly' }, { do: 'expect_text', value: 'Could not save' }]);
lacks('a failed save that shows an error is not silent', out, 'SILENT-FAILURE');
out = await act([{ do: 'click', target: 'Save quietly' }]);
has('a failed save that shows nothing is a silent failure', out, /SILENT-FAILURE .*POST \/api\/facts\/fail returned 500 and the page showed nothing/);
has('the effect line shows the failed call', out, /↳ POST \/api\/facts\/fail 500 \d+ms/);
lacks('without payload capture, the server\'s message is not shown (privacy default)', out, 'inventory timeout', 'CANARY-FACT-DETAIL');

await open('/facts/double');
out = await act([{ do: 'click', target: 'Place order once' }, { do: 'expect_text', value: 'Ordered once' }]);
lacks('one order per click is fine', out, 'DUPLICATE-SUBMIT');
out = await act([{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Ordered' }]);
has('one click that sends the same order twice', out, /DUPLICATE-SUBMIT .*POST \/api\/facts\/order sent 2× by one click/, /↳ POST \/api\/facts\/order 200 ×2/);

await open('/facts/dead');
out = await act([{ do: 'click', target: 'Show details' }, { do: 'click', target: 'Back to top' }]);
lacks('buttons that do something, and same-page links, are not dead', out, 'DEAD-CLICK', 'no effect');
out = await act([{ do: 'click', target: 'Does nothing' }]);
has('a button that does nothing at all', out, /↳ no effect within \d+ms: no request, no page change/, /DEAD-CLICK .*click "Does nothing" had no visible effect/);

out = await open('/facts/images');
has('an image that arrived but cannot be shown', out, /BROKEN-IMAGE .*\/img\/corrupt\.png/);
lacks('a 404 image stays a network finding only', out, /BROKEN-IMAGE .*missing\.png/);
has('…which it already is', out, /NET-4XX .*\/img\/missing\.png/);

// ---------------------------------------------------------------- 9. page facts: a bot check instead of the site
out = await open('/facts/botcheck');
has('a bot check page is named as such', out, '↳ bot check: this is not the site\'s own page');

// ---------------------------------------------------------------- review cases: no false alarms, no false facts
await open('/facts/guard');
out = await act([{ do: 'click', target: 'Name' }, { do: 'fill', target: 'Name', value: 'draft' }, { do: 'click', target: 'Leave' }, { do: 'expect_url', value: '/facts/form' }]);
has('an unsaved-changes guard does not stop leaving (accepted, as Playwright does)', out, '✓ expect_url "/facts/form"', /↳ .*the page asked before leaving \(beforeunload\); accepted/);

for (const [page, button] of [['animtoast', 'Save animated'], ['hiddenerr', 'Save shown'], ['customval', 'Check name'], ['retry', 'Load more']]) {
  await open(`/facts/${page}`);
  out = await act([{ do: 'click', target: button }]);
  lacks(`an error the page does show, or a read it retries, is not a silent failure: ${page}`, out, 'SILENT-FAILURE');
}

for (const [page, steps] of [
  ['props', [{ do: 'click', target: 'Increase' }, { do: 'click', target: 'Select all' }]],
  ['debounce', [{ do: 'click', target: 'Save later' }]],
  ['popover', [{ do: 'click', target: 'Open menu' }]],
  ['links', [{ do: 'click', target: 'Export report' }, { do: 'click', target: 'Email us' }, { do: 'click', target: 'Choose photo' }]],
]) {
  await open(`/facts/${page}`);
  out = await act(steps);
  lacks(`a click whose effect the DOM tree does not record is not dead: ${page}`, out, 'DEAD-CLICK', 'no effect within');
  if (page === 'links') has('a download and a file picker are facts of their click', out, '↳ download "report.json" started', '↳ a file picker opened (use the upload step)');
}

await open('/facts/bulk');
out = await act([{ do: 'click', target: 'Delete selected' }, { do: 'expect_text', value: 'Deleted' }, { do: 'click', target: 'Upload both' }, { do: 'expect_text', value: 'Uploaded' }]);
lacks('different resources, and one request per file, are not duplicate submits', out, 'DUPLICATE-SUBMIT');

await open('/facts/many');
out = await act([{ do: 'click', target: 'Save after many' }, { do: 'wait', value: '600' }]);
has('after hundreds of message elements, facts still work', out, 'status "Saved after many" came and went');

await open('/facts/rerender');
out = await act([{ do: 'click', target: 'Save cart' }, { do: 'wait', value: '300' }]);
lacks('a message re-rendered with the same text did not go', out, 'came and went');
await open('/facts/modal');
out = await act([{ do: 'click', target: 'Delete thing' }, { do: 'click', target: 'Keep it' }]);
lacks('a dialog the agent closed itself did not "come and go"', out, 'came and went');

await open('/facts/latealert');
out = await act([{ do: 'click', target: 'Save now' }, { do: 'wait', value: '700' }, { do: 'click', target: 'Does nothing' }]);
has('a dialog is a fact of the step during which it opened', out, /✓ wait "700" \(\d+ms\)\n  ↳ alert "Saved late" was dismissed/);
has('…and does not hide the next click being dead', out, /DEAD-CLICK .*click "Does nothing"/);
lacks('…nor make the earlier click look dead', out, /DEAD-CLICK .*click "Save now"/);
out = await open('/facts/alertload');
has('a dialog while a page opens is in the open result', out, '↳ alert "Welcome back" was dismissed');

out = await open('/facts/redirimg');
lacks('a redirected image that ends in a 404 is not also a broken image', out, 'BROKEN-IMAGE');
for (const page of ['denied', 'seccheck']) {
  out = await open(`/facts/${page}`);
  lacks(`the site's own page is not a bot check: ${page}`, out, 'bot check');
}
out = await open('/facts/invisiblecaptcha');
lacks('an invisible captcha badge is not "a captcha is shown"', out, 'captcha is shown');

await open('/facts/manycalls');
out = await act([{ do: 'click', target: 'Refresh all' }]);
has('a failed call is listed first, never hidden behind "+N more"', out, /↳ POST \/api\/facts\/fail 500 \d+ms · GET/);

out = await open('/facts/ariainv');
has('aria-invalid keeps its 0.3.2 form on an untouched field', out, /textbox "Code" \[required\] \[invalid\]\n/);
lacks('…with no browser message yet', out, 'invalid:"');

// ---------------------------------------------------------------- replay: rules run, fact lines stay out of reports
await open('/facts/silent');
await act([{ do: 'click', target: 'Save quietly' }]);
await s.call('flow', { action: 'save', name: 'quiet' });
out = await s.call('flow', { action: 'run', name: 'quiet' });
has('replay: the silent failure is found again', out, 'SILENT-FAILURE');
lacks('replay: no fact lines in the run output', out, '↳');
await s.close();

// ---------------------------------------------------------------- 8. the server's reason, when payload capture allows it
{
  // the demo server sends bodies without a length, which capture reads only when allowUnknownLength is set
  const c = await connect({ prefix: 'fq-facts-cap-', config: { capture: { payloads: 'json', allowedOrigins: [base], allowUnknownLength: true } } });
  await c.call('open', { url: `${base}/facts/silent` });
  out = await c.call('act', { steps: [{ do: 'click', target: 'Save quietly' }] });
  has('with payload capture on, the effect line gives the server\'s error message', out, /↳ POST \/api\/facts\/fail 500 "inventory timeout" \d+ms/);
  lacks('only the short error field is shown, never other fields', out, 'CANARY-FACT-DETAIL', 'jane.facts@example.com');
  await c.close();
}

// ---------------------------------------------------------------- cost: an action's facts are cheap
{
  const c = await connect({ prefix: 'fq-facts-speed-' });
  await c.call('open', { url: `${base}/facts/dead` });
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await c.call('act', { steps: [{ do: 'click', target: 'Show details' }], snapshot: 'none' });
  const per = (Date.now() - t0) / 5;
  check('a click with its facts still answers quickly (under 700 ms per act call on a quiet page)', per < 700, `${per}ms per call`);
  await c.close();
}

srv.close();
process.exit(done() ? 1 : 0);
