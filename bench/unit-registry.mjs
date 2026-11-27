// The MCP Registry entry (server.json) and the npm package must agree, or the Release workflow's registry job fails
// after npm has already been published. These checks catch that before a release.
// Run with: node --test bench/unit-registry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const raw = readFileSync('server.json', 'utf8');
const server = JSON.parse(raw);
const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');

test('server.json names the npm package, and the package names the server (the registry checks both ways)', () => {
  assert.equal(server.name, pkg.mcpName, 'package.json "mcpName" must equal the name in server.json');
  const npm = server.packages.find((p) => p.registryType === 'npm');
  assert.ok(npm, 'an npm package entry');
  assert.equal(npm.identifier, pkg.name);
  assert.deepEqual(npm.transport, { type: 'stdio' });
});

test('the name is in the namespace GitHub login grants: io.github.<owner>/, with the owner exactly as GitHub writes it', () => {
  // The registry grants io.github.<repository owner>/* and compares case-sensitively: "vnkk8" would be refused.
  const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)[1];
  assert.ok(server.name.startsWith(`io.github.${owner}/`), `${server.name} must start with io.github.${owner}/`);
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, 'the schema pattern for names');
  assert.equal(server.repository.url.toLowerCase(), pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '').toLowerCase());
});

test('versions agree, so the release publishes the version npm has', () => {
  assert.equal(server.version, pkg.version);
  for (const p of server.packages) assert.equal(p.version, pkg.version, `${p.identifier} version`);
});

test('limits of the registry schema', () => {
  assert.ok(server.description.length >= 1 && server.description.length <= 100, `description is ${server.description.length} characters; the registry allows 100`);
  assert.ok(!server.title || server.title.length <= 100);
  assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d\d-\d\d\/server\.schema\.json$/);
  for (const e of server.packages.flatMap((p) => p.environmentVariables ?? [])) {
    assert.match(e.name, /^FASTQA_[A-Z_]+$/);
    assert.ok(!e.isSecret && !e.isRequired, `${e.name}: FastQA needs no secret and no required setting to start`);
  }
});

test('the Release workflow keeps server.json in step and publishes it after npm', () => {
  assert.match(workflow, /j\.version = process\.argv\[1\]; for \(const p of j\.packages\) p\.version = process\.argv\[1\]/, 'the version bump also sets server.json');
  assert.match(workflow, /git add package\.json package-lock\.json server\.json dist/, 'the release commit includes server.json');
  assert.match(workflow, /needs: release[\s\S]*mcp-publisher login github-oidc[\s\S]*mcp-publisher publish/, 'a registry job after the npm release');
  assert.match(workflow, /MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+/, 'mcp-publisher is pinned');
  // npm can take many minutes to validate a new version before it is public; the registry checks npm, so the job
  // must wait for npm first (1.0.2: the registry job gave up after 2.5 minutes while npm was still validating)
  assert.match(workflow, /Wait until npm shows this version[\s\S]*npm view "fastqa-mcp@\$VERSION" version[\s\S]*mcp-publisher publish/, 'the registry job waits for npm before publishing');
  assert.match(workflow, /timeout-minutes: \d+/, 'and has a time limit');
  // the bump rewrites the file with JSON.stringify(…, null, 2): keep the file in that layout so releases make clean diffs
  assert.equal(raw.replace(/\r\n/g, '\n'), JSON.stringify(server, null, 2) + '\n'); // a Windows checkout may have CRLF
});
