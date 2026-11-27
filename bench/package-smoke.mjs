// Package smoke test: npm pack -> install the tarball into an empty project -> run the installed package as an MCP server.
// Nothing is published. Needs network access (or a warm npm cache) for the dependencies.
// Usage: node bench/package-smoke.mjs      (after npm run build)
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { start } from './demo-server.mjs';
import { suite } from './lib.mjs';

const { check, has, done } = suite('package');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const work = mkdtempSync(path.join(tmpdir(), 'fq-pack-'));
const sh = (cmd, cwd, env = {}) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

// ---- 1. what would be published
const packed = JSON.parse(sh(`npm pack --json --pack-destination "${work}"`))[0];
const files = packed.files.map((f) => f.path);
check('tarball: only dist/, README.md, LICENSE and package.json', files.every((f) => f.startsWith('dist/') || ['README.md', 'LICENSE', 'package.json'].includes(f)), files.filter((f) => !f.startsWith('dist/')).join(', '));
for (const need of ['dist/index.js', 'dist/ordering.js', 'dist/exec.js', 'dist/config.js', 'dist/observation/observer.js', 'dist/correlation/actions.js', 'dist/quality/engine.js', 'dist/privacy/redact.js', 'dist/evidence/bundle.js', 'dist/discovery/graph.js', 'dist/contract/openapi.js', 'README.md', 'LICENSE'])
  check(`tarball contains ${need}`, files.includes(need));
check('tarball: no sources, tests, docs or local data', !files.some((f) => /^(src|bench|docs|\.fastqa|\.github|\.claude)\//.test(f)));
console.log(`     ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB packed, ${(packed.unpackedSize / 1024).toFixed(1)} kB unpacked`);

// ---- 2. install it like a user would
const app = path.join(work, 'app');
mkdirSync(app);
writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'fastqa-smoke', private: true, version: '0.0.0' }));
sh(`npm install "${path.join(work, packed.filename)}" --no-audit --no-fund --loglevel=error`, app);
const installed = path.join(app, 'node_modules', 'fastqa-mcp');
const bin = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).bin['fastqa-mcp'];
check('installed package: bin entry exists', existsSync(path.join(installed, bin)), bin);
has('installed bin prints the package version', sh('npx --no-install fastqa-mcp --version', app).trim(), pkg.version);
has('installed bin prints help', sh('npx --no-install fastqa-mcp --help', app), 'fastqa-mcp run <flow|*>', '--mode=observe|strict|off');
has('installed bin validates configuration', sh('npx --no-install fastqa-mcp config', app), '"mode": "observe"');

// ---- 3. the installed server over real MCP stdio
const srv = await start();
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = path.join(work, 'fastqa-dir');
const c = new Client({ name: 'package-smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [path.join(installed, bin)], cwd: app, env: { ...process.env, FASTQA_DIR: dir, FASTQA_VAR_password: 'secret123' } }));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content.map((x) => x.text ?? '').join('\n');
has('server reports the package version', JSON.stringify(c.getServerVersion()), `"version":"${pkg.version}"`);
has('eight tools', (await c.listTools()).tools.map((t) => t.name).join(','), 'open,act,snapshot,screenshot,audit,evidence,flow,close');
has('open works from the installed package', await call('open', { url: `${base}/orders?notify=500`, fresh: true }), 'title: Orders', 'button "Place order"');
let out = await call('act', { steps: [{ do: 'click', target: 'Place order' }, { do: 'expect_text', value: 'Thank you for your order' }] });
has('act + continuous QA', out, /^PASSED 2\/2/, 'F-001 HIGH NET-5XX POST /api/notifications returned 500');
has('evidence drill-down', await call('evidence', { finding: 'F-001', details: true }), 'association: A-2 click "Place order" (inferred)');
has('audit (axe-core resolves from the installed package)', await call('audit'), /rule\(s\) violated|No WCAG/);
has('flow save', await call('flow', { action: 'save', name: 'smoke' }), 'Saved 3 steps');
has('flow run without a model', await call('flow', { action: 'run', name: 'smoke' }), /^1\/1 flows passed/);
has('flow export', await call('flow', { action: 'export', name: 'smoke' }), "import { test, expect } from '@playwright/test';");
await call('close');
await c.close();
// async on purpose: the demo server lives in this process and must keep answering while the CLI runs
const { exec } = await import('node:child_process');
const { promisify } = await import('node:util');
const replay = await promisify(exec)('npx --no-install fastqa-mcp run smoke', { cwd: app, env: { ...process.env, FASTQA_DIR: dir } }).then((r) => r.stdout, (e) => `exit=${e.code}\n${e.stdout}`);
has('installed CLI replays the flow', replay.replace(/\r/g, ''), 'PASS smoke', '1/1 passed');
srv.close();
process.exit(done() ? 1 : 0);
