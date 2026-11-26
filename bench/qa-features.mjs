// QA features: network assertions, error guard, accessibility, device emulation, data-driven runs, HTML + JUnit reports, CLI.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'fqq-'));
const c = new Client({ name: 'qa', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [path.resolve('dist/index.js')], env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123', FASTQA_VAR_email: 'ivan@test.bg' } }));
let fails = 0;
const call = async (name, args, expect = []) => {
  const r = await c.callTool({ name, arguments: args });
  const out = r.content.map((x) => x.text ?? `[${x.type}]`).join('\n');
  const ok = expect.every((e) => (e instanceof RegExp ? e.test(out) : out.includes(e)));
  if (!ok) fails++;
  console.log(`\n=== ${ok ? 'OK  ' : 'FAIL'} ${name}\n${out.length > 1500 ? out.slice(0, 1500) + '…' : out}`);
  return out;
};

const login = [
  { do: 'fill', target: 'Email', value: 'ivan@test.bg' },
  { do: 'fill', target: 'Password', value: '{{password}}' },
  { do: 'click', target: 'Log in' },
  { do: 'expect_request', target: 'POST /api/login', value: '200' },
  { do: 'expect_url', value: '/lobby' },
];
await call('open', { url: base + '/login' });
await call('act', { steps: [...login,
  { do: 'check', target: 'css=#card-welcome .tc' },
  { do: 'click', target: 'Claim Welcome bonus' },
  { do: 'expect_request', target: 'POST /api/claim/welcome', value: '2xx' },
  { do: 'expect_text', value: 'Bonus activated' },
  { do: 'expect_no_errors' },
] }, ['PASSED 10/10', 'expect_request "POST /api/claim/welcome" "2xx"', 'expect_no_errors']);

// planted backend bug: the network assertion and the error guard both catch it
await call('act', { steps: [
  { do: 'check', target: 'css=#card-spins .tc' },
  { do: 'click', target: 'Claim Free spins' },
  { do: 'expect_request', target: 'POST /api/claim/spins', value: '2xx', timeout: 2000 },
] }, ['FAILED at step 3/3', 'status not 2xx: 500 POST', 'screenshot saved:']);
await call('act', { steps: [
  { do: 'click', target: 'Retry' },
  { do: 'expect_no_errors' },
] }, ['FAILED at step 2/2', 'http: 500 POST', 'console: claim failed 500']);

// accessibility
await call('audit', {}, ['image-alt', '[critical]']);
await call('act', { steps: [{ do: 'expect_accessible', value: 'critical' }] }, ['FAILED', 'image-alt']);

// mobile
await call('open', { url: base + '/login', device: 'iPhone 13' }, ['textbox "Email"']);
await call('act', { steps: [{ do: 'expect_text', value: 'Sign in' }], snapshot: 'none' }, ['PASSED']);
await call('open', { url: base + '/login', device: '' }, ['textbox "Email"']);

// data-driven: one flow, three users from a CSV
await call('open', { url: base + '/login', fresh: true });
await call('act', { steps: [
  { do: 'fill', target: 'Email', value: '{{email}}' },
  { do: 'fill', target: 'Password', value: '{{password}}' },
  { do: 'click', target: 'Log in' },
  { do: 'expect_url', value: '/lobby' },
] }, ['PASSED 4/4']);
await call('flow', { action: 'save', name: 'login' }, ['Saved']);
mkdirSync(path.join(dir, 'data'), { recursive: true });
writeFileSync(path.join(dir, 'data', 'users.csv'), 'email,password\nivan@test.bg,secret123\nmaria@test.bg,secret123\nlocked@test.bg,wrong\n');
const out = await call('flow', { action: 'run', name: 'login', dataset: 'users' }, ['2/3 flows passed', 'row 3: locked@test.bg', 'report:', 'junit:']);
const html = readFileSync(out.match(/report: (.+)/)[1].trim(), 'utf8');
const junit = readFileSync(out.match(/junit: (.+)/)[1].trim(), 'utf8');
const rep = html.includes('FAIL') && html.includes('data:image/jpeg') && junit.includes('failures="1"') && !html.includes('secret123');
console.log(`\n=== ${rep ? 'OK  ' : 'FAIL'} report files (html has failure screenshot, junit failures=1, no secrets)`); if (!rep) fails++;
await call('close', {});
await c.close();

// CLI for Jenkins: no model, exit code 1 on failure
const cli = await promisify(exec)(`node "${path.resolve('dist/index.js')}" run login --data=users`, { env: { ...process.env, FASTQA_DIR: dir } }).catch((e) => e);
const cliOk = cli.code === 1 && /2\/3 passed/.test(cli.stdout) && existsSync(path.join(dir, 'reports', 'latest.junit.xml'));
console.log(`\n=== ${cliOk ? 'OK  ' : 'FAIL'} CLI exit=${cli.code}\n${cli.stdout}`); if (!cliOk) fails++;
writeFileSync(path.join(tmpdir(), 'fastqa-sample-report.html'), html);
srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL QA FEATURE CHECKS PASSED');
process.exit(fails ? 1 : 0);
