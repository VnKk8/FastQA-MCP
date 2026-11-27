// Unit tests of the fact helpers (no browser): closest names for a missing target, the page line, the error reason.
// Run with: node --test bench/unit-facts.mjs   (after npm run build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { closest, pageLine, reasonOf, effectLine, eventText } from '../dist/facts.js';
import { deadClick, duplicates, feedback, silentFailures } from '../dist/quality/effects.js';

const snap = ['url: x', 'h1 "Welcome"', 'e12 button "Login"', 'e13 link "Sign in with email"', 'e14 button "Help"', 'e15 textbox "Email" [required] type:email', '  e16 button "Log out"'];

test('closest: a differently written name comes first, unrelated ones are left out', () => {
  assert.deepEqual(closest('Log in', snap), ['button "Login" e12', 'button "Log out" e16']);
  assert.deepEqual(closest('Sign in', snap)[0], 'link "Sign in with email" e13');
  assert.deepEqual(closest('Checkout', snap), []);
  assert.deepEqual(closest('', snap), []);
});

test('page line: forms and fields, a captcha, a bot check instead of the site', () => {
  assert.equal(pageLine({ forms: 1, fields: 5, required: 2, captcha: false }), '\n↳ page: 1 form, 5 fields (2 required)');
  assert.equal(pageLine({ forms: 2, fields: 1, required: 0, captcha: true }), '\n↳ page: 2 forms, 1 field (0 required) · a captcha is shown (fastqa does not solve it)');
  assert.equal(pageLine({ forms: 0, fields: 0, required: 0, captcha: false }), '');
  assert.match(pageLine({ forms: 0, fields: 0, required: 0, captcha: false, botCheck: 'Just a moment...' }), /bot check: this is not the site's own page \("Just a moment\.\.\."\)/);
  assert.equal(pageLine(undefined), '');
});

test('error reason: only a short error field of a captured body, nothing when the body was not captured', () => {
  const rec = (body) => ({ body });
  assert.equal(reasonOf(rec({ state: 'captured', json: { error: 'inventory timeout', detail: 'jane@example.com' } })), 'inventory timeout');
  assert.equal(reasonOf(rec({ state: 'captured', json: { error: { message: 'Card declined' } } })), 'Card declined');
  assert.equal(reasonOf(rec({ state: 'captured', json: { detail: 'only detail' } })), undefined, 'other fields are never shown');
  assert.equal(reasonOf(rec({ state: 'skipped', reason: 'capture-off' })), undefined);
  assert.equal(reasonOf(rec(undefined)), undefined);
});

const action = (doKind = 'click') => ({ actionId: 'A-1', batchId: 'B-1', index: 1, do: doKind, label: `${doKind} "X"`, interactive: true, startedMs: 0, inflight: 0, requests: 0 });
const probe = (o = {}) => ({ mutations: 0, texts: [], messages: [], gone: [], invalid: [], marked: 0, changed: false, click: { tag: 'button', role: '', type: 'button', href: '', download: false }, scrolled: false, images: [], ...o });
const req = (o = {}) => ({ id: 'R-1', method: 'POST', route: '/api/x', path: '/api/x', status: 200, startedMs: 0, responseMs: 5, navigation: false, association: { confidence: 'inferred', reason: '' }, ...o });
const eff = (o = {}) => ({ action: action(), requests: [], bodyKey: () => 'k', newPage: false, events: [], probe: probe(), watchedMs: 150, ...o });
const link = (href, download = false) => probe({ click: { tag: 'a', role: '', type: '', href, download } });

test('dead click: only a control, only when nothing at all happened while it was watched', () => {
  assert.equal(deadClick(eff()), true);
  assert.equal(deadClick(eff({ probe: probe({ mutations: 1 }) })), false, 'a class toggle is an effect');
  assert.equal(deadClick(eff({ probe: probe({ changed: true }) })), false, 'a value, checkbox or popover change is an effect');
  assert.equal(deadClick(eff({ gap: probe({ mutations: 2 }) })), false, 'an effect right after the action counts');
  assert.equal(deadClick(eff({ requests: [req()] })), false);
  assert.equal(deadClick(eff({ events: [{ kind: 'download', text: 'a.csv' }] })), false, 'a download');
  assert.equal(deadClick(eff({ events: [{ kind: 'picker', text: '' }] })), false, 'a file picker');
  for (const href of ['#top', 'mailto:a@b.c', 'tel:123', 'blob:x']) assert.equal(deadClick(eff({ probe: link(href) })), false, href);
  assert.equal(deadClick(eff({ probe: link('/report', true) })), false, 'a download link');
  assert.equal(deadClick(eff({ probe: link('/page') })), true, 'a real link that did nothing');
  assert.equal(deadClick(eff({ probe: probe({ click: { tag: 'input', role: '', type: 'checkbox', href: '', download: false } }) })), false, 'not a button');
  assert.equal(deadClick(eff({ probe: undefined })), false, 'no probe, no judgement');
  assert.equal(deadClick(eff({ action: action('press') })), false);
});

test('silent failure: a failed submission the person was not told about; not reads, not retries', () => {
  const bad = req({ status: 500 });
  assert.deepEqual(silentFailures(eff({ requests: [bad] }), [bad]).map((r) => r.id), ['R-1']);
  assert.equal(silentFailures(eff({ requests: [bad], after: probe({ texts: ['Could not save'] }) }), [bad]).length, 0, 'told later in the batch');
  assert.equal(silentFailures(eff({ requests: [bad], probe: probe({ invalid: [{ name: 'u', message: 'taken' }] }) }), [bad]).length, 0, 'reportValidity');
  const read = req({ method: 'GET', status: 503 });
  assert.equal(silentFailures(eff({ requests: [read] }), [read]).length, 0, 'reads are retried by pages');
  const retry = req({ id: 'R-2', startedMs: 10 });
  assert.equal(silentFailures(eff({ requests: [bad] }), [bad, retry]).length, 0, 'sent again: a retry in progress');
  assert.equal(silentFailures(eff({ requests: [bad], probe: undefined }), [bad]).length, 0, 'no probe, no judgement');
});

test('events read as facts', () => {
  assert.equal(eventText({ kind: 'dialog', type: 'confirm', text: 'Sure?' }), 'confirm "Sure?" was dismissed');
  assert.equal(eventText({ kind: 'dialog', type: 'beforeunload', text: '' }), 'the page asked before leaving (beforeunload); accepted');
  assert.equal(eventText({ kind: 'download', text: 'r.csv' }), 'download "r.csv" started');
  assert.equal(eventText({ kind: 'picker', text: '' }), 'a file picker opened (use the upload step)');
});

test('duplicates: same method and key (URL and body); never GETs; never when one failed', () => {
  assert.equal(duplicates(eff({ requests: [req({ id: 'R-1' }), req({ id: 'R-2' })] })).length, 1);
  assert.equal(duplicates(eff({ requests: [req({ id: 'R-1' }), req({ id: 'R-2' })], bodyKey: (r) => r.id })).length, 0, 'different bodies');
  assert.equal(duplicates(eff({ requests: [req({ method: 'GET' }), req({ method: 'GET', id: 'R-2' })] })).length, 0);
  assert.equal(duplicates(eff({ requests: [req({ status: 500 }), req({ id: 'R-2' })] })).length, 0, 'a retry after a failure');
});

test('feedback: unknown without a probe, true for any message, text, field change, event or navigation', () => {
  assert.equal(feedback(eff({ probe: undefined })), undefined);
  assert.equal(feedback(eff()), false);
  assert.equal(feedback(eff({ probe: probe({ texts: ['Saved'] }) })), true);
  assert.equal(feedback(eff({ probe: probe({ marked: 1 }) })), true);
  assert.equal(feedback(eff({ after: probe({ messages: [{ id: 'f:1', kind: 'alert', text: 'Oops' }] }) })), true);
  assert.equal(feedback(eff({ events: [{ kind: 'dialog', type: 'alert', text: 'Oops' }] })), true);
  assert.equal(feedback(eff({ navigatedTo: '/x' })), true);
});

test('effect line: failed calls first, at most three groups, nothing to say means no line', () => {
  assert.equal(effectLine(eff({ probe: probe({ mutations: 3 }) }), [], new Set()), undefined);
  const many = ['a', 'b', 'c', 'd'].map((x, i) => req({ id: `R-${i}`, route: `/api/${x}`, status: x === 'd' ? 500 : 200 }));
  assert.match(effectLine(eff({ requests: many, probe: probe({ mutations: 1 }) }), [], new Set()), /^ {2}↳ POST \/api\/d 500 5ms · POST \/api\/a 200 5ms · POST \/api\/b 200 5ms · \+1 more calls$/);
  assert.match(effectLine(eff({ requests: [req(), req({ id: 'R-2' })], probe: probe({ mutations: 1 }) }), [], new Set()), /POST \/api\/x 200 ×2$/);
  const msg = { id: 'f:1', kind: 'status', text: 'Saved' };
  assert.match(effectLine(eff({ probe: probe({ mutations: 2, messages: [msg] }) }), [], new Set(['f:1'])), /status "Saved" came and went/);
  assert.equal(effectLine(eff({ probe: probe({ mutations: 2, messages: [msg] }) }), [], new Set()), undefined, 'still visible: in the snapshot already');
  assert.match(effectLine(eff(), [], new Set()), /no effect within 150ms: no request, no page change$/);
  assert.match(effectLine(eff({ probe: probe({ mutations: 1 }) }), [{ kind: 'download', text: 'r.csv' }], new Set()), /download "r\.csv" started$/);
});
