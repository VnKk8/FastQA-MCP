// Records the cashier journey through MCP, exports it, then runs the exported spec with @playwright/test.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';
const srv = await start(); const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'fqx-'));
const c = new Client({ name: 'x', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [path.resolve('dist/index.js')], env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' } }));
const call = (name, args) => c.callTool({ name, arguments: args }).then((r) => r.content[0].text);
await call('open', { url: base + '/login' });
console.log((await call('act', { steps: [
  { do: 'fill', target: 'Email', value: 'ivan@test.bg' }, { do: 'fill', target: 'Password', value: '{{password}}' },
  { do: 'click', target: 'Log in' }, { do: 'expect_url', value: '/lobby' },
  { do: 'goto', value: base + '/cashier' },
  { do: 'fill', target: 'Promo code', value: 'WELCOME50' }, { do: 'click', target: 'Apply code' },
  { do: 'expect_text', value: 'Promo applied' },
  { do: 'fill', target: 'Card holder', value: 'Ivan Test' }, { do: 'fill', target: 'Card number', value: '4111111111111111' },
  { do: 'select', target: 'Amount', value: '50 EUR' }, { do: 'click', target: 'Deposit' },
  { do: 'click', target: 'Confirm payment' }, { do: 'expect_text', value: 'Deposit successful: 50 EUR' },
  { do: 'expect_no_text', value: 'Unknown promo code' },
] })).split('\n')[0]);
await call('flow', { action: 'save', name: 'full' });
await call('flow', { action: 'export', name: 'full' });
await call('close', {}); await c.close();
writeFileSync(path.join(dir, 'playwright.config.mjs'), `export default { testDir: './tests', reporter: 'line', use: { launchOptions: { executablePath: ${JSON.stringify(process.env.FASTQA_CHROME || '')} || undefined } } };`);
try {
  const { stdout: out } = await promisify(exec)(`npx playwright test -c ${dir}/playwright.config.mjs`, { cwd: dir, env: { ...process.env, FASTQA_VAR_password: 'secret123', NODE_PATH: path.resolve('node_modules') } });
  console.log(out.trim().split('\n').slice(-3).join('\n'));
} catch (e) { console.log('EXPORTED SPEC FAILED\n' + e.stdout + e.stderr); process.exitCode = 1; }
srv.close();
