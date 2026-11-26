// Same QA journey through @playwright/mcp and fastqa, both over real MCP stdio.
// Measures: model round trips (tool calls), characters returned to the model, and tool-side wall time.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { start } from './demo-server.mjs';

const CHROME = process.env.FASTQA_CHROME;
const LLM_TURN_S = Number(process.env.LLM_TURN_S || 3); // assumed seconds per model turn (think + emit tool call)

const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;

async function connect(command, args, env = {}) {
  const c = new Client({ name: 'bench', version: '0' });
  await c.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
  const tools = await c.listTools();
  const toolChars = JSON.stringify(tools.tools).length; // tool definitions sit in the prompt every turn
  const stats = { calls: 0, chars: 0, ms: 0, toolChars, toolCount: tools.tools.length };
  const call = async (name, args) => {
    const t = Date.now();
    const r = await c.callTool({ name, arguments: args });
    stats.ms += Date.now() - t; stats.calls++;
    const out = r.content.map((x) => x.text ?? '').join('\n');
    stats.chars += out.length;
    if (r.isError) throw new Error(`${name}: ${out.slice(0, 300)}`);
    return out;
  };
  return { c, call, stats };
}

// ---------- Playwright MCP: one action per call, refs come from the previous snapshot ----------
const pw = await connect('node', [path.resolve('node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated', '--no-sandbox', ...(CHROME ? ['--executable-path', CHROME] : [])]);
const ref = (snap, re) => { const m = snap.match(re); if (!m) throw new Error('ref not found: ' + re + '\n' + snap.slice(0, 2000)); return m[1]; };
// The leanest sequence a model could use with the current @playwright/mcp (it has browser_fill_form for batching fields,
// actions no longer return snapshots inline, so refs need an explicit browser_snapshot per new page).
let s = await pw.call('browser_navigate', { url: base + '/login' });
s = await pw.call('browser_snapshot', {});
await pw.call('browser_fill_form', { fields: [
  { name: 'Email', type: 'textbox', target: ref(s, /textbox "Email"[^\n]*\[ref=([a-z0-9]+)\]/), value: 'john@example.com' },
  { name: 'Password', type: 'textbox', target: ref(s, /textbox "Password"[^\n]*\[ref=([a-z0-9]+)\]/), value: 'secret123' },
] });
await pw.call('browser_click', { element: 'Log in', target: ref(s, /button "Log in"[^\n]*\[ref=([a-z0-9]+)\]/) });
await pw.call('browser_wait_for', { text: 'Welcome back' });
s = await pw.call('browser_snapshot', {});
await pw.call('browser_click', { element: 'size and colour checkbox', target: ref(s, /checkbox "I have checked the size and colour"[^\n]*\[ref=([a-z0-9]+)\]/) });
await pw.call('browser_click', { element: 'Add Blue T-shirt to cart', target: ref(s, /button "Add Blue T-shirt to cart"[^\n]*\[ref=([a-z0-9]+)\]/) });
await pw.call('browser_wait_for', { text: 'Added to cart: Blue T-shirt' });
await pw.call('browser_select_option', { element: 'Currency', target: ref(s, /combobox "Currency"[^\n]*\[ref=([a-z0-9]+)\]/), values: ['GBP'] });
await pw.call('browser_close', {}).catch(() => {});
await pw.c.close();

// ---------- fastqa: open + one batched act ----------
const fq = await connect('node', [path.resolve('dist/index.js')], { FASTQA_VAR_password: 'secret123' });
await fq.call('open', { url: base + '/login' });
const out = await fq.call('act', { steps: [
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
if (!out.startsWith('PASSED')) throw new Error(out);
const fqJourney = { ...fq.stats };
await fq.call('flow', { action: 'save', name: 'bench' });
const t = Date.now();
const replay = await fq.call('flow', { action: 'run', name: 'bench' });
const replayMs = Date.now() - t;
await fq.call('close', {});
await fq.c.close();
srv.close();

const row = (name, st, extraTurns = 0) => {
  const turns = st.calls + extraTurns;
  const promptPerTurn = st.toolChars;
  return { name, tool_calls: st.calls, chars_returned: st.chars, approx_tokens_returned: Math.round(st.chars / 4),
    tool_def_tokens_per_turn: Math.round(promptPerTurn / 4), tool_ms: st.ms,
    est_end_to_end_s: +(turns * LLM_TURN_S + st.ms / 1000).toFixed(1) };
};
const pwRow = row('@playwright/mcp', { ...pw.stats, calls: pw.stats.calls - 1 });
const fqRow = row('fastqa', fqJourney);
console.table([pwRow, fqRow]);
console.log(`fastqa replay of the saved flow (no model at all): ${replayMs}ms -> ${replay.split('\n')[0]}`);
console.log(`Assumed ${LLM_TURN_S}s per model turn for the end-to-end estimate (override with LLM_TURN_S).`);
console.log(JSON.stringify({ pw: pwRow, fq: fqRow, replayMs }));
