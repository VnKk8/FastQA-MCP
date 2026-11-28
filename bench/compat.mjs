// Backward compatibility with 0.3.2: tool schemas, response formats, flow files, CLI exit codes and reports.
// The same call script that produced docs/baseline/responses-0.3.2.txt runs against the current build.
// The only allowed differences in text output are additive: the "QA:" block, fact lines ("↳ …") and the field-rule
// tokens at the end of a snapshot line (type:, maxlength:, minlength:, min:, max:, step:, pattern:, invalid:"…").
// Everything else must be byte for byte what 0.3.2 printed.
import { readFileSync, mkdirSync, copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runContractScript, slashes } from './capture-baseline.mjs';
import { start } from './demo-server.mjs';
import { connect, suite, cli } from './lib.mjs';

const { check, has, done } = suite('compat');
const legacyTools = JSON.parse(readFileSync('bench/fixtures/legacy/tools-0.3.2.json', 'utf8'));
const baseline = slashes(readFileSync('docs/baseline/responses-0.3.2.txt', 'utf8').replace(/\r\n/g, '\n')).replace(/legacy-shop-[\w-]+\.jpg/g, 'legacy-shop-N.jpg');

// ---- 1. the 0.3.2 script, output compared section by section
const now = await runContractScript();
const QA = /^\s*(QA[: ]|F-\d{3} |→ leads|\+\d+ more$|session S-|↳ )/;
const RULES = / (type|maxlength|minlength|min|max|step|pattern|invalid):("(?:[^"\\]|\\.)*"|\S+)(?=( [a-z]+:| *$))/g;
const strip = (s) => s.split('\n').filter((l) => !QA.test(l)).map((l) => l.replace(RULES, '')).join('\n');
const sections = (s) => new Map(s.split(/^### /m).filter(Boolean).map((b) => { const i = b.indexOf('\n'); return [b.slice(0, i), b.slice(i + 1).trimEnd()]; }));
const want = sections(baseline); const got = sections(strip(now.responses));
check('same sections as the 0.3.2 script', [...want.keys()].join('|') === [...got.keys()].join('|'), `${[...want.keys()].join('\n')}\n--- vs ---\n${[...got.keys()].join('\n')}`);
for (const [key, expected] of want) {
  const actual = got.get(key) ?? '(missing)';
  const title = `identical to 0.3.2 apart from the QA block: ${key.length > 70 ? key.slice(0, 70) + '…' : key}`;
  if (key.startsWith('cli --version')) { has(title, actual, 'exit=0', /\d+\.\d+\.\d+/); continue; }
  check(title, actual === expected, `--- 0.3.2 ---\n${expected}\n--- now ---\n${actual}`);
}
has('the QA block is additive: one line on a clean batch', now.responses, /\nQA: clean · \d+ requests? observed\n/);

// ---- 2. tool schemas: same eight tools; every 0.3.2 input still accepted with the same type; nothing new is required
const tools = now.tools;
check('the same eight tools in the same order', tools.map((t) => t.name).join(',') === legacyTools.map((t) => t.name).join(','), tools.map((t) => t.name).join(','));
for (const old of legacyTools) {
  const cur = tools.find((t) => t.name === old.name);
  const oldProps = old.inputSchema.properties ?? {}; const curProps = cur?.inputSchema.properties ?? {};
  // "Still accepted with the same type": everything 0.3.2 declared is declared the same way now. Three things may differ,
  // because none of them rejects an input that 0.3.2 accepted: descriptions, more allowed values in an enum (a new step
  // kind), and more optional properties of an object.
  // Since zod 4 (1.0.4) the generated schema also omits `additionalProperties: false` on step objects and adds
  // `propertyNames: {type: string}` to records: the first accepts more, the second states what JSON keys always are.
  // Neither rejects an input that 0.3.2 accepted, so both are tolerated here.
  const same = (a, b, key) => {
    if (key === 'description') return true;
    if (key === 'additionalProperties' && a === false && b === undefined) return true;
    if (a && typeof a === 'object' && b && typeof b === 'object' && !Array.isArray(a)) {
      const { propertyNames, ...rest } = b;
      if (propertyNames && !('propertyNames' in a) && JSON.stringify(propertyNames) === '{"type":"string"}') b = rest;
      if (a.additionalProperties === false && !('additionalProperties' in b)) { const { additionalProperties, ...ra } = a; a = ra; }
    }
    if (key === 'enum') return Array.isArray(a) && Array.isArray(b) && a.every((v) => b.includes(v));
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
    if (a && typeof a === 'object') return !!b && typeof b === 'object' && Object.keys(a).every((k) => same(a[k], b[k], k)) && Object.keys(b).every((k) => k in a || k === 'description' || key === 'properties');
    return a === b;
  };
  const changed = Object.keys(oldProps).filter((k) => !curProps[k] || !same(oldProps[k], curProps[k]));
  check(`${old.name}: every 0.3.2 parameter keeps its name and type`, changed.length === 0, `changed or removed: ${changed.join(', ')}`);
  check(`${old.name}: no new required parameter`, JSON.stringify(cur?.inputSchema.required ?? []) === JSON.stringify(old.inputSchema.required ?? []), JSON.stringify(cur?.inputSchema.required));
  check(`${old.name}: the 0.3.2 description is still the start of the description`, (cur?.description ?? '').startsWith(old.description.slice(0, 60)), cur?.description);
}

// ---- 3. a flow file saved by 0.3.2 replays unchanged (MCP and CLI), with the 0.3.2 report files
const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'fq-compat-'));
mkdirSync(path.join(dir, 'flows'), { recursive: true });
copyFileSync('bench/fixtures/legacy/flows/legacy-shop.json', path.join(dir, 'flows', 'legacy-shop.json'));
const s = await connect({ dir });
let out = await s.call('flow', { action: 'run', name: 'legacy-shop', vars: { base } });
has('0.3.2 flow file replays through MCP', out, /^1\/1 flows passed\nPASS legacy-shop \(\d+ms\)/, /\nreport: .+\.html\njunit: .+\.junit\.xml$/);
out = await s.call('flow', { action: 'export', name: 'legacy-shop' });
has('0.3.2 flow file exports: comment-only QA steps become executable', out, 'await fq.expectRequest("POST /api/cart/tshirt", "2xx");', 'await fq.expectNoErrors("");');
await s.close();
const env = { FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' };
let r = await cli(`run legacy-shop --var=base=${base}`, env);
has('CLI: exit 0 and the 0.3.2 lines on success', `exit=${r.code}\n${r.stdout}`, 'exit=0', /PASS legacy-shop \(\d+ms\)\n/, '1/1 passed\nreport: ', '\njunit:  ');
r = await cli(`run legacy-shop --var=base=${base} --var=password=wrong`, env);
has('CLI: exit 1 when a step fails', `exit=${r.code}\n${r.stdout}`, 'exit=1', 'FAIL legacy-shop', '5. ✗ expect_url "/account"', '0/1 passed');
r = await cli('run no-such-flow', env);
check('CLI: exit 2 on a missing flow', r.code === 2, `exit=${r.code}`);
const reports = readdirSync(path.join(dir, 'reports'));
check('reports: timestamped files plus latest.html and latest.junit.xml', reports.includes('latest.html') && reports.includes('latest.junit.xml') && reports.some((f) => /^\d{4}-.*\.junit\.xml$/.test(f)), reports.join(', '));
const junit = readFileSync(path.join(dir, 'reports', 'latest.junit.xml'), 'utf8');
has('JUnit keeps the 0.3.2 structure', junit, '<testsuite name="fastqa" tests="1" failures="1"', '<testcase classname="fastqa.flows" name="legacy-shop"', '<failure message="');
has('HTML report keeps its title', readFileSync(path.join(dir, 'reports', 'latest.html'), 'utf8'), '<h1>fastqa test report</h1>');
srv.close();
process.exit(done() ? 1 : 0);
