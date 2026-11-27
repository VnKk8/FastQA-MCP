// Repeatable performance harness: cold + N warm samples of the standard journey over real MCP stdio.
// Measures browser-side tool time, response sizes, tool schema size, replay time and server RSS.
// Usage: node bench/perf.mjs [--samples=30] [--warmup=3] [--replays=10] [--json=out.json] [--dist=dist/index.js]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));
const SAMPLES = Number(args.samples || 30);
const WARMUP = Number(args.warmup || 3);
const REPLAYS = Number(args.replays || 10);

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'fq-perf-'));
const transport = new StdioClientTransport({
  command: 'node', args: [path.resolve(args.dist || 'dist/index.js')],
  env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' },
});
const c = new Client({ name: 'perf', version: '0' });
await c.connect(transport);
const tools = await c.listTools();
const schemaBytes = JSON.stringify(tools.tools).length;
const call = async (name, a) => (await c.callTool({ name, arguments: a })).content.map((x) => x.text ?? '').join('\n');

const journey = async () => {
  const a = performance.now();
  const o = await call('open', { url: base + '/login', fresh: true });
  const b = performance.now();
  const r = await call('act', { steps: [
    { do: 'fill', target: 'Email', value: 'john@example.com' },
    { do: 'fill', target: 'Password', value: '{{password}}' },
    { do: 'click', target: 'Log in' },
    { do: 'expect_text', value: 'Welcome back' },
    { do: 'check', target: 'css=#card-tshirt .tc' },
    { do: 'click', target: 'Add Blue T-shirt to cart' },
    { do: 'expect_text', value: 'Added to cart: Blue T-shirt' },
    { do: 'select', target: 'Currency', value: 'GBP' },
    { do: 'expect_value', target: 'Currency', value: 'GBP' },
  ] });
  const e = performance.now();
  if (!r.startsWith('PASSED')) throw new Error(r);
  return { openMs: b - a, actMs: e - b, totalMs: e - a, openChars: o.length, actChars: r.length };
};

const stat = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
function rssKb(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
      const m = /"([\d.,\s ]+) K"/.exec(out); return m ? Number(m[1].replace(/[^\d]/g, '')) : null;
    }
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) : null;
  } catch { return null; }
}

const cold = await journey(); // includes browser launch
for (let i = 0; i < WARMUP; i++) await journey();
const samples = [];
for (let i = 0; i < SAMPLES; i++) samples.push(await journey());
await call('flow', { action: 'save', name: 'perf' });
const replays = [];
for (let i = 0; i < REPLAYS; i++) {
  const t = performance.now();
  const out = await call('flow', { action: 'run', name: 'perf' });
  if (!out.startsWith('1/1 flows passed')) throw new Error(out);
  replays.push(performance.now() - t);
}
const rss = rssKb(transport.pid);
await call('close', {});
await c.close();
srv.close();

const result = {
  when: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
  samples: SAMPLES, warmup: WARMUP,
  toolCallsPerJourney: 2, toolCount: tools.tools.length, schemaBytes, schemaTokensApprox: Math.round(schemaBytes / 4),
  coldTotalMs: +cold.totalMs.toFixed(1),
  warm: { totalMs: stat(samples.map((s) => s.totalMs)), openMs: stat(samples.map((s) => s.openMs)), actMs: stat(samples.map((s) => s.actMs)) },
  responseChars: { open: stat(samples.map((s) => s.openChars)).median, act: stat(samples.map((s) => s.actChars)).median },
  replayMs: stat(replays),
  serverRssKb: rss,
};
console.log(JSON.stringify(result, null, 2));
if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2) + '\n');
