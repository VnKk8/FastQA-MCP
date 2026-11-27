// Runs a fixed script of tool calls and CLI runs and returns the public contracts of the build under test:
// tool schemas, normalized responses, a saved flow, CLI exit codes.
//   node bench/capture-baseline.mjs <label>   writes bench/fixtures/legacy/* and docs/baseline/responses-<label>.txt
// It was run once against 0.3.2 before the evolution work. bench/compat.mjs runs the same script against the current
// build and compares the result with those files.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { start } from './demo-server.mjs';

export async function runContractScript() {
  const srv = await start();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'fq-cap-'));
  const env = { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' };
  const c = new Client({ name: 'capture', version: '0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: [path.resolve('dist/index.js')], env }));
  const norm = (s) => s.split(base).join('{{base}}').split(dir).join('<FASTQA_DIR>').replace(/\d+ms/g, 'Nms').replace(/fail-\d+/g, 'fail-N')
    .replace(/\d{4}-\d\d-\d\dT[\d-]+Z/g, '<stamp>').replace(/legacy-shop-[\w-]+\.jpg/g, 'legacy-shop-N.jpg');
  const log = [];
  const call = async (name, args) => {
    const out = (await c.callTool({ name, arguments: args })).content.map((x) => x.text ?? `[${x.type}]`).join('\n');
    log.push(`### ${name} ${JSON.stringify(args).split(base).join('{{base}}')}\n${norm(out)}\n`);
    return out;
  };

  const tools = (await c.listTools()).tools;
  await call('open', { url: base + '/login' });
  await call('act', { steps: [
    { do: 'fill', target: 'Email', value: 'john@example.com' },
    { do: 'fill', target: 'Password', value: '{{password}}' },
    { do: 'click', target: 'Log in' },
    { do: 'expect_url', value: '/account' },
    { do: 'check', target: 'css=#card-tshirt .tc' },
    { do: 'click', target: 'Add Blue T-shirt to cart' },
    { do: 'expect_request', target: 'POST /api/cart/tshirt', value: '2xx' },
    { do: 'expect_text', value: 'Added to cart: Blue T-shirt' },
    { do: 'select', target: 'Currency', value: 'GBP' },
    { do: 'expect_value', target: 'Currency', value: 'GBP' },
    { do: 'expect_no_errors' },
  ] });
  await call('flow', { action: 'save', name: 'legacy-shop' });
  await call('flow', { action: 'show', name: 'legacy-shop' });
  await call('act', { steps: [{ do: 'check', target: 'css=#card-hoodie .tc' }, { do: 'click', target: 'Add Grey hoodie to cart' }, { do: 'expect_text', value: 'Added to cart: Grey hoodie', timeout: 1500 }] });
  await call('evidence', {});
  await call('evidence', {});
  await call('snapshot', { mode: 'interactive' });
  await call('flow', { action: 'run', name: 'legacy-shop' });
  await call('flow', { action: 'run', name: 'legacy-shop', vars: { password: 'wrong' } });
  await call('flow', { action: 'list' });
  await call('close', {});
  await c.close();

  // the saved flow, made portable: the demo server port changes on every run
  const flow = readFileSync(path.join(dir, 'flows', 'legacy-shop.json'), 'utf8').split(base).join('{{base}}');
  writeFileSync(path.join(dir, 'flows', 'legacy-shop.json'), flow);

  const run = (a) => promisify(exec)(`node "${path.resolve('dist/index.js')}" ${a}`, { env }).then((r) => ({ code: 0, ...r }), (e) => e);
  for (const a of [`run legacy-shop --var=base=${base}`, `run legacy-shop --var=base=${base} --var=password=wrong`, 'run no-such-flow', '--version']) {
    const r = await run(a);
    const err = norm(String(r.stderr || '')).split('\n').filter((l) => l.trim() && !/^fastqa: /.test(l))[0];
    log.push(`### cli ${a.split(base).join('{{base}}')}\nexit=${r.code}\n${norm(r.stdout || '')}${err ? 'stderr: ' + err + '\n' : ''}`);
  }
  srv.close();
  return { tools, responses: log.join('\n'), flow, dir, base };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const label = process.argv[2] || 'baseline';
  const { tools, responses, flow } = await runContractScript();
  mkdirSync('bench/fixtures/legacy/flows', { recursive: true });
  mkdirSync('docs/baseline', { recursive: true });
  writeFileSync(`bench/fixtures/legacy/tools-${label}.json`, JSON.stringify(tools, null, 2) + '\n');
  writeFileSync('bench/fixtures/legacy/flows/legacy-shop.json', flow);
  writeFileSync(`docs/baseline/responses-${label}.txt`, responses);
  console.log(`captured ${tools.length} tool schemas -> bench/fixtures/legacy, docs/baseline/responses-${label}.txt`);
}
