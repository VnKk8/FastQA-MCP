// Shared helpers for the MCP stdio tests: one real client per server process, the same way agents connect.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The build under test. FASTQA_TEST_DIST points the suites at another build (used to show a regression test failing on an older one). */
export const DIST = path.resolve(process.env.FASTQA_TEST_DIST || 'dist/index.js');

/** Starts a fastqa server with its own FASTQA_DIR. `config` is written to <dir>/config.json before the server starts. */
export async function connect({ env = {}, config, dir, prefix = 'fq-' } = {}) {
  dir ??= mkdtempSync(path.join(tmpdir(), prefix));
  if (config) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2)); }
  const transport = new StdioClientTransport({ command: 'node', args: [DIST], env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123', ...env }, stderr: 'pipe' });
  const stderr = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(transport);
  const raw = (name, args = {}) => c.callTool({ name, arguments: args });
  const call = async (name, args = {}) => (await raw(name, args)).content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n');
  return { c, call, raw, dir, stderr, transport, close: async () => { await call('close').catch(() => {}); await c.close(); } };
}

export function suite(title) {
  let fails = 0; let n = 0;
  const check = (name, cond, detail = '') => {
    n++;
    if (!cond) fails++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : `\n     ${String(detail).split('\n').join('\n     ')}`}`);
    return !!cond;
  };
  /** every expectation must be found in `out` (string = substring, RegExp = match) */
  const has = (name, out, ...expect) => {
    const missing = expect.filter((e) => !(e instanceof RegExp ? e.test(out) : out.includes(e)));
    return check(name, missing.length === 0, `missing: ${missing.map(String).join(' | ')}\n--- got ---\n${out}`);
  };
  const lacks = (name, out, ...forbid) => {
    const found = forbid.filter((e) => (e instanceof RegExp ? e.test(out) : out.includes(e)));
    return check(name, found.length === 0, `must not contain: ${found.map(String).join(' | ')}\n--- got ---\n${out}`);
  };
  const done = () => { console.log(`\n${title}: ${fails ? `${fails} of ${n} FAILED` : `all ${n} checks passed`}`); return fails; };
  return { check, has, lacks, done };
}

/** Runs the CLI and resolves with { code, stdout, stderr } (never rejects). */
export const cli = (args, env = {}) =>
  promisify(exec)(`node "${DIST}" ${args}`, { env: { ...process.env, ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
