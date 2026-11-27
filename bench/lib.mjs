// Shared helpers for the MCP stdio tests: one real client per server process, the same way agents connect.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { exec, spawn } from 'node:child_process';
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

/**
 * A fastqa server spoken to in raw JSON-RPC, for tests that must control how requests reach it
 * (several requests in one write, cancellations). `order` lists the ids in the order they were answered.
 */
export async function rawServer({ env = {}, prefix = 'fq-raw-' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const child = spawn('node', [DIST], { env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = new Map(); const order = []; let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && ('result' in m || 'error' in m)) { order.push(m.id); waiters.get(m.id)?.(m); }
    }
  });
  const frame = (m) => `${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`;
  /** resolves with the response to request `id` */
  const answer = (id) => new Promise((resolve) => waiters.set(id, resolve));
  /** the text of one tools/call request, to be written alone or joined with others */
  const tool = (id, name, args = {}) => frame({ id, method: 'tools/call', params: { name, arguments: args } });
  const notify = (method, params) => frame({ method, params });
  const write = (text) => child.stdin.write(text);
  const textOf = (m) => (m.result?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n') || JSON.stringify(m.error);
  const ready = answer('init');
  write(frame({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } } }));
  await ready;
  write(notify('notifications/initialized'));
  const close = async () => { const p = answer('close'); write(tool('close', 'close')); await p; child.stdin.end(); };
  return { dir, order, answer, tool, notify, write, textOf, close };
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
