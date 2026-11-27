// QA intelligence end to end, over real MCP stdio and the CLI: safe targeting under ambiguity, feedback rules with
// negative controls, request identity, untrusted page text, QA communication, form and visual analysis, origin limits,
// role permissions, parallel isolation, behaviour baselines and discovery. Ends with a labelled detector matrix
// (synthetic fixtures: a regression check, not a claim about real-world precision).
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const { check, has, lacks, done } = suite('intelligence');
const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const matrix = [];
const newDir = (p) => mkdtempSync(path.join(tmpdir(), p));
const writeFlow = (dir, name, steps, extra = {}) => {
  mkdirSync(path.join(dir, 'flows'), { recursive: true });
  writeFileSync(path.join(dir, 'flows', `${name}.json`), JSON.stringify({ name, created: '2026-11-27T00:00:00.000Z', schema: 2, ...extra, steps }));
};

// ---------------------------------------------------------------- 1. targeting: rows, frames, re-rendered refs, export
{
  const s = await connect({ prefix: 'fq-intel-1-' });
  check('server instructions ask for evidence-driven QA communication', /evidence-driven QA engineer/.test(s.c.getInstructions() ?? ''), s.c.getInstructions());
  await s.call('open', { url: `${base}/intel/rows` });
  let out = await s.call('act', { steps: [{ do: 'click', target: 'Delete' }] });
  has('destructive and ambiguous: not executed, the candidates are listed with their rows', out, /^FAILED at step 1\/1/,
    'Not executed: "Delete" matches 2 elements and fastqa does not guess the target of a destructive action', /in "Invoice 1001/, /in "Invoice 1002/);
  lacks('destructive and ambiguous: no request was sent', out, '/api/intel/delete', 'Deleted');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1001' }, { do: 'expect_text', value: 'Deleted Invoice 1001' }] });
  has('within: the Delete of that row', out, /^PASSED 2\/2/, 'click "Delete" within "Invoice 1001"', 'POST /api/intel/delete/{id} 200');
  const net = await s.call('evidence', { view: 'network', path: '/api/intel/delete' });
  has('within: the request went to that row', net, '/api/intel/delete/1');
  lacks('within: never the other row', net, '/api/intel/delete/2');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1003' }] });
  has('within: a container that is not there is never widened', out, /^FAILED at step 1\/1/, 'within "Invoice 1003"', 'never widened');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Edit' }, { do: 'expect_text', value: 'Editing Invoice 1001' }] });
  has('an ambiguous label that is not destructive keeps the 0.3 behaviour (first match)', out, /^PASSED 2\/2/);
  out = await s.call('act', { steps: [{ do: 'click', target: 'Edit' }], strict: true });
  has('strict mode keeps its own wording', out, 'strict mode will not pick one');
  // record, replay and export a step with a container
  await s.call('flow', { action: 'start' });
  await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1002' }, { do: 'expect_text', value: 'Deleted Invoice 1002' }] });
  await s.call('flow', { action: 'save', name: 'del-summer' });
  out = await s.call('flow', { action: 'show', name: 'del-summer' });
  has('flow: the container is recorded with the step', out, 'click "Delete" within "Invoice 1002"');
  out = await s.call('flow', { action: 'run', name: 'del-summer' });
  has('replay: the same row, by the same container', out, /^1\/1 flows passed/);
  out = await s.call('flow', { action: 'export', name: 'del-summer' });
  has('export: the spec searches the same container', out, '.filter({ hasText: "Invoice 1002" })', `.getByRole('button', { name: "Delete", exact: true })`);

  // review findings: within never widens, works inside frames, is honoured by text checks, refused where it cannot be
  await s.call('open', { url: `${base}/intel/sectionrows` });
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1001', timeout: 1500 }] });
  has('within never widens to an outer section when the named row holds no match', out, /^FAILED at step 1\/1/, 'never widened');
  lacks('within: the other row was not touched', out, 'Deleted Summer');
  out = await s.call('act', { steps: [{ do: 'expect_text', value: 'archived', within: 'Invoice 1001' }] });
  has('expect_text within a row: text of that row', out, /^PASSED 1\/1/);
  out = await s.call('act', { steps: [{ do: 'expect_text', value: 'Summer', within: 'Invoice 1001', timeout: 800 }] });
  has('expect_text within a row: text of another row does not count', out, /^FAILED at step 1\/1/);
  out = await s.call('act', { steps: [{ do: 'expect_count', target: 'tr', value: '2', within: 'Invoice 1001' }] });
  has('a step that cannot honour within refuses it', out, /^FAILED at step 1\/1/, '"within" is not supported by "expect_count"');
  await s.call('open', { url: `${base}/intel/framerows` });
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1001' }, { do: 'expect_text', value: 'Deleted Invoice 1001' }] });
  has('within inside an iframe', out, /^PASSED 2\/2/);
  // a ref recorded by its position replays as a selector, checked by its identity
  out = await s.call('open', { url: `${base}/intel/rerender` });
  const ref3 = /(e\d+) button "Approve the quarterly/.exec(out)?.[1];
  await s.call('flow', { action: 'start' });
  await s.call('act', { steps: [{ do: 'click', target: ref3 }, { do: 'expect_text', value: 'clicked approve' }] });
  await s.call('flow', { action: 'save', name: 'approve' });
  out = await s.call('flow', { action: 'show', name: 'approve' });
  has('a positional ref is recorded as a css= selector', out, /click "css=[^"]+nth-of-type/);
  out = await s.call('flow', { action: 'run', name: 'approve' });
  has('and replays', out, /^1\/1 flows passed/);

  await s.call('open', { url: `${base}/intel/shadowrows` });
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete' }] });
  has('shadow DOM: the same guard for two Delete buttons in an open shadow root', out, /^FAILED/, 'Not executed: "Delete" matches 2 elements');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Delete', within: 'Invoice 1002' }, { do: 'expect_text', value: 'Deleted Invoice 1002' }] });
  has('shadow DOM: within finds the row inside the shadow root', out, /^PASSED 2\/2/);

  await s.call('open', { url: `${base}/intel/frames` });
  out = await s.call('act', { steps: [{ do: 'click', target: 'Remove' }] });
  has('the same destructive control in the page and in a frame: not executed', out, /^FAILED/, 'matches in 2 places');
  out = await s.call('act', { steps: [{ do: 'click', target: 'Remove', frame: 'inner' }] });
  has('with frame: executed in that frame only', out, /^PASSED 1\/1/);

  out = await s.call('open', { url: `${base}/intel/rerender` });
  const ref = /(e\d+) button "Approve the quarterly/.exec(out)?.[1];
  out = await s.call('act', { steps: [{ do: 'click', target: 'Re-render' }, { do: 'click', target: ref }, { do: 'expect_text', value: 'clicked approve' }] });
  has('a re-rendered ref acts on the same control (role and name), not on the one now in its old place', out, /^PASSED 3\/3/);
  out = await s.call('open', { url: `${base}/intel/rerender` });
  const ref2 = /(e\d+) button "Approve the quarterly/.exec(out)?.[1];
  out = await s.call('act', { steps: [{ do: 'click', target: 'Drop approve' }, { do: 'click', target: ref2 }] });
  has('a ref whose control is gone is refused', out, /^FAILED at step 2\/2/, `Stale ref ${ref2}`);
  lacks('a ref whose control is gone never clicks another control', out, 'clicked reject');
  await s.close();
}

// ---------------------------------------------------------------- 2. feedback rules and request identity, with negative controls
{
  const s = await connect({ prefix: 'fq-intel-2-', env: { FASTQA_STRUCTURED: 'true' } });
  const run = async (page, steps) => { await s.call('open', { url: `${base}/intel/${page}` }); return s.call('act', { steps }); };
  const rule = async (page, button, ruleId, expectFinding, scenario) => {
    const out = await run(page, [{ do: 'click', target: button }]);
    const got = new RegExp(` ${ruleId} `).test(out);
    matrix.push({ ruleId, scenario, expectFinding, got });
    check(`${ruleId} ${expectFinding ? 'found' : 'not raised'}: ${scenario}`, got === expectFinding, out);
    return out;
  };
  let out = await rule('falsesuccess', 'Save profile', 'FALSE-SUCCESS', true, 'every submission failed, a success toast right after');
  has('FALSE-SUCCESS: explained, with a safe next check', out, /→ leads, not confirmed defects\. F-\d{3}: /, 'Next: ', 'without submitting it again');
  out = await rule('honest', 'Save profile', 'FALSE-SUCCESS', false, 'failed save with an error toast');
  lacks('an honest error message is not a silent failure either', out, 'SILENT-FAILURE');
  await rule('negated', 'Save profile', 'FALSE-SUCCESS', false, 'an honest "Changes not saved" (a success word under a negation)');
  await rule('falsefailure', 'Submit order', 'FALSE-FAILURE', true, 'HTTP 201 with an error alert');
  await rule('validation', 'Create account', 'FALSE-FAILURE', false, 'the browser blocked the form (validation)');
  out = await run('unrelated', [{ do: 'click', target: 'Save note' }, { do: 'click', target: 'Show tip' }]);
  matrix.push({ ruleId: 'FALSE-FAILURE', scenario: 'an error toast of a later action', expectFinding: false, got: / FALSE-FAILURE /.test(out) });
  lacks('FALSE-FAILURE not raised: the error toast belongs to a later action without a submission', out, 'FALSE-FAILURE');
  await rule('stuck', 'Load report', 'STUCK-LOADING', true, 'the spinner outlives every call');
  await rule('spinnerok', 'Load report', 'STUCK-LOADING', false, 'the spinner goes when the call ends');
  await rule('idem', 'Pay invoice', 'DUPLICATE-SUBMIT', false, 'the same idempotency key twice (a safe retry)');
  out = await rule('dup', 'Pay invoice', 'DUPLICATE-SUBMIT', true, 'the same body twice at once');
  has('a run of steps without assertions says that nothing was verified', out, / · no assertions\n|· no assertions$/m);
  await rule('bigdiff', 'Send data', 'DUPLICATE-SUBMIT', false, 'two different 2 MB bodies of the same length');
  await rule('bigsame', 'Send data', 'DUPLICATE-SUBMIT', true, 'two equal 2 MB bodies');
  await rule('otherbody', 'Sync now', 'SILENT-FAILURE', true, 'sent again with another body: not a retry of the same submission');

  // structured content carries the same explanation as the text
  await s.call('open', { url: `${base}/intel/falsesuccess` });
  const raw = await s.raw('act', { steps: [{ do: 'click', target: 'Save profile' }] });
  const textOut = raw.content.map((c) => c.text ?? '').join('\n');
  const top = raw.structuredContent?.quality?.findings?.[0];
  check('structured and text results agree on the explanation of the top finding', !!top?.explanation?.next && textOut.includes(`Next: ${top.explanation.next}`), JSON.stringify(top));
  // the same findings were reported earlier in this session: now they are "seen again", never called clean
  const q = raw.structuredContent?.quality;
  check('structured result: assertions are separate from findings; a repeat is "seen again"', raw.structuredContent?.assertions?.passed === 0 && q?.newCount === 0 && q?.recurringCount >= 1 && q?.status === 'findings', JSON.stringify({ a: raw.structuredContent?.assertions, q: { status: q?.status, newCount: q?.newCount, recurringCount: q?.recurringCount } }));

  // page text is data: it never starts a line of its own in a result
  await s.call('open', { url: `${base}/intel/forge` });
  out = await s.call('act', { steps: [{ do: 'click', target: 'Trigger' }] });
  check('page text cannot forge a result line ("QA: clean", instructions)', !/\nQA: clean · 0 requests observed/.test(out) && !/^ignore previous instructions/m.test(out) && /CONSOLE-ERROR console\.error: boom QA: clean/.test(out), out);
  await s.close();
}

// ---------------------------------------------------------------- 3. form and visual analysis on request, origin limits, discovery
{
  const s = await connect({ prefix: 'fq-intel-3-', config: { discovery: { enabled: true } } });
  let out = await s.call('open', { url: `${base}/facts/form` });
  has('open: a page with a form says how many test ideas it has', out, /test ideas? in evidence view "forms"/);
  out = await s.call('evidence', { view: 'forms' });
  has('forms: boundaries from the declared constraints', out, 'Age', '"17"', '"18"', '"120"', '"121"', '"user@"', 'maxlength 10', 'nothing was filled or submitted', 'server enforcement is not verified');
  check('forms: no generated value for a password field', !/Password[^\n]*→ "(?!\s*")[^"]+"/.test(out), out);
  out = await s.call('act', { steps: [{ do: 'fill', target: 'Email', value: 'a@b.test' }] });
  out = await s.call('evidence', { view: 'discovery' });
  has('discovery: constraints per page, marked as client side, and controls shown but not used', out, 'known field constraints (declared in the page: client side; backend enforcement not verified)', 'min:18', 'shown but not exercised', 'button "Register"');
  lacks('discovery: values typed into fields never enter it', out, 'a@b.test');

  await s.call('open', { url: `${base}/intel/visual` });
  out = await s.call('evidence', { view: 'visual' });
  has('visual: overflow, clipped text, overlapping and covered controls', out, /overflow: div "wide banner"/, /clipped: button "A very long label/, /overlap: button "First" .*and button "Second"/, /obstructed: button "Hidden action"/);
  lacks('visual: an intentional ellipsis and a scroll container are not issues', out, 'Intentional ellipsis', 'a wide table');
  check('visual: page attributes cannot forge a result line', /forged role/i.test(out) && !/\nQA: clean · 0 requests observed/.test(out), out);
  has('visual: says what it did not inspect', out, 'Not inspected: iframes');
  await s.close();

  const o = await connect({ prefix: 'fq-intel-3o-', config: { browser: { allowedOrigins: [base] } } });
  await o.call('open', { url: `${base}/intel/offsite` });
  out = await o.call('act', { steps: [{ do: 'click', target: 'Partner site' }, { do: 'expect_text', value: 'never reached' }] });
  has('browser.allowedOrigins: a link to another origin fails its step and stops the batch', out, /^FAILED at step 1\/2/, 'outside browser.allowedOrigins', 'not a network sandbox');
  await o.close();
}

// ---------------------------------------------------------------- 4. permissions per role, in parallel, with a matrix
{
  const dir = newDir('fq-intel-4-');
  const flow = (name, role, as, expectations) => writeFlow(dir, name, [
    { do: 'goto', value: `{{base}}/intel/perm?role=${as}` }, { do: 'click', target: 'Create project' },
    ...expectations.map(([target, value]) => ({ do: 'expect_permission', target, value })),
  ], { role });
  flow('perm-admin', 'admin', 'admin', [['POST /api/intel/project', 'allowed'], ['Delete user', 'allowed']]);
  flow('perm-leaky', 'viewer', 'leaky', [['POST /api/intel/project', 'denied']]);
  flow('perm-viewer', 'viewer', 'viewer', [['POST /api/intel/project', 'denied'], ['Delete user', 'denied']]);
  const r = await cli(`run "*" --var=base=${base} --workers=3`, { FASTQA_DIR: dir });
  const out = `exit=${r.code}\n${r.stdout}`;
  has('permissions: a mismatch fails its flow (exit 1); the others pass', out, 'exit=1', 'PASS perm-admin', 'FAIL perm-leaky', 'PASS perm-viewer', 'permission mismatch for role "viewer": expected denied — HTTP 201 [backend]');
  has('permission matrix: expected vs observed with the kind of evidence', out, 'permissions: 5 checks, 1 not passed',
    'viewer · POST /api/intel/project · expect denied · HTTP 403 [backend] · PASS', 'viewer · Delete user · expect denied · control not shown [ui] · PASS',
    'admin · POST /api/intel/project · expect allowed · HTTP 201 [backend] · PASS', 'viewer · POST /api/intel/project · expect denied · HTTP 201 [backend] · MISMATCH');
  check('parallel results keep the order of the flows', out.indexOf('perm-admin (') < out.indexOf('perm-leaky (') && out.indexOf('perm-leaky (') < out.indexOf('perm-viewer ('), out);
  lacks('an expected denial is not a QA lead', out, 'NET-4XX');
}

// ---------------------------------------------------------------- 5. parallel replay: isolation, order, rows, time
{
  const dir = newDir('fq-intel-5-');
  for (const id of ['a', 'b', 'c', 'd']) writeFlow(dir, `iso-${id}`, [{ do: 'goto', value: `{{base}}/intel/iso?id=${id}` }, { do: 'expect_text', value: 'who: none cookie: none' }]);
  let t = Date.now();
  const serial = await cli(`run "*" --var=base=${base}`, { FASTQA_DIR: dir });
  const serialMs = Date.now() - t;
  t = Date.now();
  const par = await cli(`run "*" --var=base=${base} --workers=4`, { FASTQA_DIR: dir });
  const parMs = Date.now() - t;
  has('4 workers: every flow starts with empty storage and cookies (own context)', `exit=${par.code}\n${par.stdout}`, 'exit=0', '4/4 passed');
  check('4 workers: results in flow order', ['iso-a', 'iso-b', 'iso-c', 'iso-d'].map((n) => par.stdout.indexOf(`PASS ${n} `)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), par.stdout);
  check('1 worker: the same flows pass one after the other', serial.code === 0 && /4\/4 passed/.test(serial.stdout), serial.stdout);
  // a measurement, not a pass/fail check: wall time on a shared CI runner is too noisy to assert
  console.log(`     timing: 4 isolation flows, serial ${serialMs} ms (a browser per flow), 4 workers ${parMs} ms (one browser, 4 contexts)`);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'ids.csv'), 'id\nx\ny\nz\n');
  writeFlow(dir, 'iso-row', [{ do: 'goto', value: '{{base}}/intel/iso?id={{id}}' }, { do: 'expect_text', value: 'who: none' }]);
  const rows = await cli(`run iso-row --var=base=${base} --data=ids --workers=3`, { FASTQA_DIR: dir });
  has('dataset rows in parallel: each row isolated, results in row order', `exit=${rows.code}\n${rows.stdout}`, 'exit=0', /PASS iso-row \[row 1: x\][^\n]*\nPASS iso-row \[row 2: y\][^\n]*\nPASS iso-row \[row 3: z\]/);
  const bad = await cli(`run iso-a --workers=9`, { FASTQA_DIR: dir });
  check('--workers above the cap is refused (exit 2)', bad.code === 2, `${bad.code} ${bad.stderr}`);
}

// ---------------------------------------------------------------- 6. behaviour baselines: record, same, deviations, other scope
{
  const dir = newDir('fq-intel-6-');
  writeFlow(dir, 'settings', [{ do: 'goto', value: '{{base}}/intel/settings?audit={{audit}}' }, { do: 'click', target: 'Save settings' }, { do: 'expect_text', value: 'Settings saved' }]);
  const env = { FASTQA_DIR: dir };
  let r = await cli(`run settings --var=base=${base} --var=audit=ok --baseline=record --repeat=5 --env=test`, env);
  has('behaviour: a reference recorded from 5 runs, for its scope', r.stdout, `behaviour: recorded the reference of flow settings (5 samples) for ${base} | env test | desktop | role unknown`);
  const before = readFileSync(path.join(dir, 'baselines', 'behaviour.json'), 'utf8');
  r = await cli(`run settings --var=base=${base} --var=audit=ok --baseline=check --env=test`, env);
  has('behaviour: the same journey is the same', r.stdout, 'behaviour: same as the reference (5 samples');
  r = await cli(`run settings --var=base=${base} --var=audit=fail --baseline=check --env=test`, env);
  has('behaviour: a changed call is a deviation to investigate, with the reference counts', `exit=${r.code}\n${r.stdout}`, 'exit=0', 'PASS settings',
    'observable deviation', 'POST /api/intel/audit → 5xx (reference: 2xx in 5/5)', 'not defects; the reference is unchanged');
  r = await cli(`run settings --var=base=${base} --var=audit=ok --baseline=check --env=prod`, env);
  has('behaviour: another environment label is never compared', r.stdout, 'behaviour: no reference for flow settings', 'different scopes are never compared');
  check('behaviour: checks never write the reference', readFileSync(path.join(dir, 'baselines', 'behaviour.json'), 'utf8') === before);
}

// ---------------------------------------------------------------- detector matrix (synthetic fixtures)
const rules = [...new Set(matrix.map((m) => m.ruleId))];
console.log('\n     detector matrix on these fixtures (TP/FP/FN/TN; synthetic, not a real-world precision claim):');
for (const id of rules) {
  const m = matrix.filter((x) => x.ruleId === id);
  const tp = m.filter((x) => x.expectFinding && x.got).length; const fn = m.filter((x) => x.expectFinding && !x.got).length;
  const fp = m.filter((x) => !x.expectFinding && x.got).length; const tn = m.filter((x) => !x.expectFinding && !x.got).length;
  console.log(`     ${id.padEnd(17)} TP ${tp} · FP ${fp} · FN ${fn} · TN ${tn}`);
}

srv.close();
process.exit(done() ? 1 : 0);
