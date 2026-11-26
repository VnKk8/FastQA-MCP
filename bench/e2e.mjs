// End-to-end check through a real MCP client over stdio, the same way Claude Code / OpenCode talk to it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from './demo-server.mjs';

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(path.join(tmpdir(), 'fastqa-'));
const transport = new StdioClientTransport({
  command: 'node',
  args: [path.resolve('dist/index.js')],
  env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' },
});
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(transport);

let fails = 0;
const call = async (name, args, expect) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.data?.length} b64]`)).join('\n');
  const ok = !expect || expect.every((e) => (e instanceof RegExp ? e.test(out) : out.includes(e)));
  if (!ok) fails++;
  console.log(`\n=== ${ok ? 'OK  ' : 'FAIL'} ${name} (${Date.now() - t}ms, ${out.length} chars)\n${out}`);
  return out;
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

await call('open', { url: base + '/login' }, ['textbox "Email"', 'button "Log in"', 'h1 "Sign in"']);

// wrong password -> error alert shows up in the diff
await call('act', { steps: [
  { do: 'fill', target: 'Email', value: 'john@example.com' },
  { do: 'fill', target: 'Password', value: 'nope' },
  { do: 'click', target: 'Log in' },
  { do: 'expect_text', value: 'Invalid email or password' },
] }, ['PASSED 4/4', '+ alert "Invalid email or password"']);

// secret from env, never typed by the model; whole journey in one call
await call('flow', { action: 'start' }, ['Recording']);
await call('act', { steps: [
  { do: 'fill', target: 'Email', value: 'john@example.com' },
  { do: 'fill', target: 'Password', value: '{{password}}' },
  { do: 'click', target: 'Log in' },
  { do: 'expect_url', value: '/account' },
  { do: 'expect_text', value: 'Welcome back' },
  { do: 'expect_disabled', target: 'Add Blue T-shirt to cart' },
  { do: 'check', target: 'css=#card-tshirt .tc' },
  { do: 'click', target: 'Add Blue T-shirt to cart' },
  { do: 'expect_text', value: 'Added to cart: Blue T-shirt' },
  { do: 'select', target: 'Currency', value: 'GBP' },
  { do: 'expect_value', target: 'Currency', value: 'GBP' },
] }, ['PASSED 11/11', 'navigated, new page', 'Added to cart', /^(?![\s\S]*secret123)/]);
await call('flow', { action: 'save', name: 'add-to-cart' }, ['Saved']);

// planted bug: adding the hoodie returns 500
await call('act', { steps: [
  { do: 'check', target: 'css=#card-hoodie .tc' },
  { do: 'click', target: 'Add Grey hoodie to cart' },
  { do: 'expect_text', value: 'Added to cart: Grey hoodie', timeout: 2000 },
] }, ['FAILED at step 3/3', '--- page now ---', 'failed request']);
await call('evidence', {}, ['500 POST', 'add to cart failed']);

// stale ref / unknown target is a clean failure, not a crash
await call('act', { steps: [{ do: 'click', target: 'Nonexistent button', timeout: 500 }] }, ['FAILED at step 1/1', 'No visible element']);

await call('snapshot', { mode: 'full', root: '#card-tshirt' }, ['Blue T-shirt']);
await call('screenshot', {}, ['image']);

// replay with no model + export
await call('flow', { action: 'run', name: 'add-to-cart' }, ['1/1 flows passed']);
await call('flow', { action: 'run', name: 'add-to-cart', vars: { password: 'wrong' } }, ['0/1 flows passed', 'FAIL']);
await call('flow', { action: 'export', name: 'add-to-cart' }, ['getByLabel', 'process.env.FASTQA_VAR_password', 'toHaveURL(new RegExp("/account"))']);
// ---------- shadow DOM + iframes (cross-origin, nested) ----------
await call('open', { url: base + '/checkout', fresh: true }, [
  'textbox "Coupon code"', 'button "Apply coupon"',            // inside open shadow root
  'frame "Payment"', '  e', 'textbox "Card holder"',        // cross-origin iframe block
  'textbox "Card number"',                                  // shadow root inside the iframe
]);
await call('act', { steps: [
  { do: 'fill', target: 'Coupon code', value: 'SAVE10' },
  { do: 'click', target: 'Apply coupon' },
  { do: 'expect_text', value: 'Coupon applied: 10% off' },
  { do: 'fill', target: 'Card holder', value: 'John Smith' },
  { do: 'fill', target: 'Card number', value: '4111111111111111' },
  { do: 'select', target: 'Shipping', value: 'Express' },
  { do: 'click', target: 'Pay now', frame: 'Payment' },
  { do: 'click', target: 'Confirm payment' },                // nested 3DS iframe that appeared mid-batch
  { do: 'expect_text', value: 'Thank you for your order: Express shipping' },
] }, ['PASSED 9/9', '+ status "Thank you for your order: Express shipping"', 'frame "3-D Secure"']);
await call('flow', { action: 'save', name: 'checkout' }, ['Saved']);
await call('flow', { action: 'show', name: 'checkout' }, ['Card number']);
await call('flow', { action: 'run', name: 'checkout' }, ['1/1 flows passed']);
await call('flow', { action: 'export', name: 'checkout' }, ['frameLocator("iframe[title=\\"Payment\\"]").frameLocator("iframe[title=\\"3-D Secure\\"]")', 'getByLabel("Card number"']);
await call('snapshot', { mode: 'full' }, ['frame "3-D Secure"', 'Bank verification']);

await call('close', {});
await client.close();
srv.close();
console.log(`\n${fails ? fails + ' FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(fails ? 1 : 0);
