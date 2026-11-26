// Unit tests of the OpenAPI contract checker (src/contract/openapi.ts). No browser: pure functions over request records.
// Run: npm run build && node --test bench/unit-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContracts } from '../dist/contract/openapi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const ORIGIN = 'http://shop.example.test';
const CANARY = 'CANARY-VALUE-7731';

/** A request record with the fields the checker reads. */
const rec = (method, p, status, o = {}) => ({ method, origin: ORIGIN, path: p, status, contentType: 'application/json', firstParty: true, ...o });
const shop = () => loadContracts([{ spec: 'openapi-shop.json' }], FIXTURES);

/** Writes documents into a fresh project: <tmp>/.fastqa is the fastqa dir, <tmp> is the project root. */
function project(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'fq-contract-'));
  const base = path.join(root, '.fastqa');
  mkdirSync(base, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(base, name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { root, base };
}
/** A minimal OpenAPI document with one GET operation whose 200 response has `schema`. */
const doc = (schema, extra = {}) => ({
  openapi: '3.0.3', info: { title: 't', version: '1' },
  paths: { '/thing': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } } } } },
  ...extra,
});
const one = (document, contract = {}) => {
  const { base } = project({ 'api.json': document });
  return loadContracts([{ spec: 'api.json', ...contract }], base);
};

test('the shop fixture loads without warnings', () => {
  const { checker, warnings } = shop();
  assert.deepEqual(warnings, []);
  assert.ok(checker);
});

test('a documented status with a matching body passes', () => {
  const { checker } = shop();
  const r = rec('POST', '/api/orders', 201);
  const res = checker.checkResponse(r);
  assert.equal(res.matched, true);
  assert.deepEqual(res.issues, []);
  assert.equal(res.needsBody, true);
  assert.equal(checker.wantsBody(r), true);
  assert.deepEqual(checker.checkBody(r, { success: true, orderId: 'ORD-1001', total: 19.99 }), { matched: true, issues: [] });
  // the documented error response of a negative test passes too
  const e = rec('POST', '/api/orders', 422);
  assert.deepEqual(checker.checkResponse(e).issues, []);
  assert.deepEqual(checker.checkBody(e, { error: 'Quantity must be at least 1' }).issues, []);
});

test('an undocumented status is a status issue', () => {
  const { checker } = shop();
  const res = checker.checkResponse(rec('POST', '/api/orders', 202));
  assert.equal(res.matched, true);
  assert.equal(res.issues.length, 1);
  const i = res.issues[0];
  assert.equal(i.kind, 'status');
  assert.equal(i.signature, 'status 202');
  assert.match(i.message, /status 202 is not documented/);
  assert.match(i.expected, /200, 201, 422/);
  assert.equal(i.actual, 'HTTP 202');
  // a 500 is not documented either: the contract reports it, NET-5XX reports the failure itself
  assert.equal(checker.checkResponse(rec('POST', '/api/orders', 500)).issues[0].kind, 'status');
  // the body of an undocumented status is not judged a second time
  assert.deepEqual(checker.checkBody(rec('POST', '/api/orders', 202), { anything: 1 }), { matched: true, issues: [] });
  assert.equal(checker.wantsBody(rec('POST', '/api/orders', 202)), false);
});

test('a media type that is not documented is a media issue', () => {
  const { checker } = shop();
  const res = checker.checkResponse(rec('POST', '/api/orders', 201, { contentType: 'text/html; charset=utf-8' }));
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].kind, 'media');
  assert.match(res.issues[0].message, /media type text\/html is not documented for status 201/);
  assert.equal(res.issues[0].expected, 'one of application/json');
  assert.equal(res.needsBody, false);
  // parameters and case are ignored
  assert.deepEqual(checker.checkResponse(rec('POST', '/api/orders', 201, { contentType: 'Application/JSON; charset=utf-8' })).issues, []);
  // no content-type header: nothing to compare
  assert.deepEqual(checker.checkResponse(rec('POST', '/api/orders', 201, { contentType: undefined })).issues, []);
  // wildcards in the contract
  const wild = one({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {
    '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/*': { schema: { type: 'object' } } } } } } },
    '/b': { get: { responses: { 200: { description: 'ok', content: { '*/*': {} } } } } },
  } }).checker;
  assert.deepEqual(wild.checkResponse(rec('GET', '/a', 200)).issues, []);
  assert.equal(wild.checkResponse(rec('GET', '/a', 200, { contentType: 'text/plain' })).issues[0].kind, 'media');
  assert.deepEqual(wild.checkResponse(rec('GET', '/b', 200, { contentType: 'image/png' })).issues, []);
});

test('a schema mismatch names pointer paths and types, never response values', () => {
  const { checker } = shop();
  const r = rec('POST', '/api/orders', 201);
  const body = { success: true, orderId: 1001, total: CANARY };
  const res = checker.checkBody(r, body);
  assert.equal(res.issues.length, 1);
  const i = res.issues[0];
  assert.equal(i.kind, 'schema');
  assert.match(i.message, /^response body does not match the schema: /);
  assert.match(i.message, /\/orderId must be string \(is integer\)/);
  assert.match(i.message, /\/total must be number \(is string\)/);
  assert.equal(i.signature, 'schema 201 /orderId type,/total type');
  assert.match(i.expected, /POST \/api\/orders 201/);
  assert.match(i.actual, /^2 schema violation\(s\)/);
  for (const field of [i.message, i.expected, i.actual, i.signature]) {
    assert.ok(!field.includes(CANARY), `value leaked into: ${field}`);
    assert.ok(!field.includes('1001'), `value leaked into: ${field}`);
  }
  // the signature is stable: the same violations in another order and with other values dedupe to one finding
  assert.equal(checker.checkBody(r, { total: 'x', orderId: 7, success: false }).issues[0].signature, i.signature);
  // a missing required field is reported at the root
  const missing = checker.checkBody(r, { success: true }).issues[0];
  assert.match(missing.message, /\(root\) must have required property 'orderId'/);
  assert.match(missing.signature, /^schema 201 \/ required/);
});

test('undeclared response keys and enum, const and pattern values are not echoed', () => {
  const { checker } = one(doc({
    type: 'object', additionalProperties: false,
    properties: {
      state: { type: 'string', enum: ['open', 'closed'] }, kind: { const: 'order' }, ref: { type: 'string', pattern: '^ORD-' },
      sessions: { type: 'object', additionalProperties: { type: 'object', properties: { ttl: { type: 'integer' } } } },
      items: { type: 'array', items: { type: 'object', properties: { price: { type: 'number' } } } },
    },
  }));
  const body = {
    state: CANARY, kind: CANARY, ref: CANARY, [CANARY]: 1,
    sessions: { [`${CANARY}-key`]: { ttl: 'soon' } },
    items: [{ price: 1 }, { price: CANARY }],
  };
  const i = checker.checkBody(rec('GET', '/thing', 200), body).issues[0];
  const all = [i.message, i.expected, i.actual, i.signature].join('\n');
  assert.ok(!all.includes('CANARY'), all);
  assert.match(i.signature, /\/sessions\/\{key\}\/ttl type/); // a dynamic key becomes {key}
  assert.match(i.signature, /\/items\/\*\/price type/);        // an array index becomes *
  assert.match(i.signature, /\/ additionalProperties/);
  assert.match(i.signature, /\/state enum/);
  assert.match(i.message, /\+\d+ more/);                       // at most three violations are spelled out
});

test('OpenAPI 3.0 nullable is honoured', () => {
  const { checker } = one(doc({
    type: 'object',
    properties: {
      note: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['a', 'b'], nullable: true },
      owner: { allOf: [{ $ref: '#/components/schemas/Owner' }], nullable: true },
      strict: { type: 'string' },
      price: { type: 'number', minimum: 0, exclusiveMinimum: true },
    },
  }, { components: { schemas: { Owner: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } }));
  const r = rec('GET', '/thing', 200);
  assert.deepEqual(checker.checkBody(r, { note: null, status: null, owner: null, strict: 'x', price: 0.5 }).issues, []);
  assert.deepEqual(checker.checkBody(r, { note: 'hi', status: 'a', owner: { id: 3 } }).issues, []);
  assert.match(checker.checkBody(r, { strict: null }).issues[0].message, /\/strict must be string \(is null\)/);
  assert.match(checker.checkBody(r, { note: 5 }).issues[0].message, /\/note must be string,null \(is integer\)/);
  assert.match(checker.checkBody(r, { owner: { id: 'x' } }).issues[0].signature, /\/owner/);
  assert.match(checker.checkBody(r, { price: 0 }).issues[0].message, /\/price must be > 0/); // boolean exclusiveMinimum converted
});

test('an OpenAPI 3.1 document is validated as JSON Schema 2020-12', () => {
  const { checker, warnings } = one({
    openapi: '3.1.0', info: { title: 't', version: '1' },
    paths: { '/thing': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } } } } },
    components: { schemas: { Thing: {
      type: 'object', required: ['name', 'pair'],
      properties: { name: { type: ['string', 'null'] }, pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false }, kind: { const: 'thing' } },
    } } },
  });
  assert.deepEqual(warnings, []);
  const r = rec('GET', '/thing', 200);
  assert.deepEqual(checker.checkBody(r, { name: null, pair: ['a', 1], kind: 'thing' }).issues, []);
  const i = checker.checkBody(r, { name: 3, pair: [1, 'a', 'extra'] }).issues[0];
  assert.match(i.signature, /\/name type/);
  assert.match(i.signature, /\/pair\/\* type/);
});

test('templated paths, literal preference, servers prefix and basePath', () => {
  const api = {
    openapi: '3.0.3', info: { title: 't', version: '1' }, servers: [{ url: 'https://api.example.test/v1/' }],
    paths: {
      '/orders/{id}': { get: { responses: { 200: { description: 'one', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } } } } },
      '/orders/latest': { get: { responses: { 204: { description: 'none' } } } },
      '/users/{userId}/orders/{orderId}': { delete: { responses: { default: { description: 'any' } } } },
    },
  };
  const { checker } = one(api);
  assert.deepEqual(checker.checkResponse(rec('GET', '/v1/orders/42', 200)).issues, []);
  assert.equal(checker.checkBody(rec('GET', '/v1/orders/42', 200), { id: 'x' }).issues[0].kind, 'schema'); // schema found behind a templated path
  assert.match(checker.checkBody(rec('GET', '/v1/orders/42', 200), { id: 'x' }).issues[0].expected, /GET \/v1\/orders\/\{id\} 200/);
  // the literal path wins over the template: 200 is documented for {id}, not for "latest"
  assert.deepEqual(checker.checkResponse(rec('GET', '/v1/orders/latest', 204)).issues, []);
  assert.equal(checker.checkResponse(rec('GET', '/v1/orders/latest', 200)).issues[0].kind, 'status');
  // `default` documents every status; the method must match
  assert.deepEqual(checker.checkResponse(rec('DELETE', '/v1/users/7/orders/9', 503)).issues, []);
  assert.equal(checker.checkResponse(rec('GET', '/v1/users/7/orders/9', 200)).matched, false);
  // without the server prefix nothing matches
  assert.equal(checker.checkResponse(rec('GET', '/orders/42', 200)).matched, false);
  // an explicit basePath overrides servers[0].url
  const based = one(api, { basePath: '/shop/api' }).checker;
  assert.equal(based.checkResponse(rec('GET', '/shop/api/orders/42', 200)).matched, true);
  assert.equal(based.checkResponse(rec('GET', '/v1/orders/42', 200)).matched, false);
  const rooted = one(api, { basePath: '' }).checker;
  assert.equal(rooted.checkResponse(rec('GET', '/orders/42', 200)).matched, true);
});

test('status ranges are honoured after exact codes', () => {
  const { checker } = one({
    openapi: '3.0.3', info: { title: 't', version: '1' },
    paths: { '/thing': { get: { responses: { '2XX': { description: 'ok' }, 404: { description: 'gone' } } } } },
  });
  assert.deepEqual(checker.checkResponse(rec('GET', '/thing', 204)).issues, []);
  assert.deepEqual(checker.checkResponse(rec('GET', '/thing', 404)).issues, []);
  assert.equal(checker.checkResponse(rec('GET', '/thing', 400)).issues[0].kind, 'status');
});

test('no matching operation is "not evaluated", never a mismatch', () => {
  const { checker } = shop();
  for (const r of [rec('GET', '/api/unknown', 200), rec('DELETE', '/api/orders', 200)]) {
    assert.deepEqual(checker.checkResponse(r), { matched: false, issues: [], notEvaluated: 'no matching operation in the contract' });
    assert.deepEqual(checker.checkBody(r, { a: 1 }), { matched: false, issues: [], notEvaluated: 'no matching operation in the contract' });
    assert.equal(checker.wantsBody(r), false);
  }
});

test('a remote $ref is not resolved and not fetched', () => {
  const remote = one(doc({ type: 'object', properties: { a: { $ref: 'https://schemas.example.test/a.json' } } })).checker;
  assert.deepEqual(remote.checkBody(rec('GET', '/thing', 200), { a: 1 }), { matched: true, issues: [], notEvaluated: 'remote $ref is not resolved' });
  const file = one(doc({ $ref: 'other.json#/Thing' })).checker;
  assert.equal(file.checkBody(rec('GET', '/thing', 200), {}).notEvaluated, 'remote $ref is not resolved');
  // a remote ref hidden behind a local one, and a response object behind a remote ref
  const nested = one(doc({ $ref: '#/components/schemas/A' }, { components: { schemas: { A: { type: 'object', properties: { b: { $ref: 'http://x.test/b.json' } } } } } })).checker;
  assert.equal(nested.checkBody(rec('GET', '/thing', 200), {}).notEvaluated, 'remote $ref is not resolved');
  const response = one({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/thing': { get: { responses: { 200: { $ref: 'https://x.test/responses.json#/Ok' } } } } } }).checker;
  assert.equal(response.checkResponse(rec('GET', '/thing', 200)).notEvaluated, 'remote $ref is not resolved');
  assert.equal(response.wantsBody(rec('GET', '/thing', 200)), false);
});

test('an invalid or unresolvable schema is "unsupported", not a mismatch', () => {
  for (const schema of [
    { type: 'strng' },
    { type: 'object', properties: { a: { type: 'object', required: 'yes' } } },
    { $ref: '#/components/schemas/Missing' },
    { $ref: '#/components/schemas/Broken' },
  ]) {
    const { checker } = one(doc(schema, { components: { schemas: { Broken: { type: 'array', items: { type: 'nope' } } } } }));
    const res = checker.checkBody(rec('GET', '/thing', 200), { a: 1 });
    assert.deepEqual(res.issues, [], JSON.stringify(schema));
    assert.match(res.notEvaluated ?? '', /^unsupported schema: /, JSON.stringify(schema));
  }
});

test('local and recursive refs are resolved; a response can be a $ref', () => {
  const { checker } = one({
    openapi: '3.0.3', info: { title: 't', version: '1' },
    paths: { '/thing': { get: { responses: { 200: { $ref: '#/components/responses/Tree' } } } } },
    components: {
      responses: { Tree: { description: 'tree', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } },
      schemas: { Node: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } },
    },
  });
  const r = rec('GET', '/thing', 200);
  assert.equal(checker.wantsBody(r), true);
  assert.deepEqual(checker.checkBody(r, { name: 'a', children: [{ name: 'b', children: [{ name: 'c' }] }] }).issues, []);
  assert.match(checker.checkBody(r, { name: 'a', children: [{ name: 'b', children: [{ name: 7 }] }] }).issues[0].signature, /\/children\/\*\/children\/\*\/name type/);
});

test('unusable documents give a warning and no crash', () => {
  const { base } = project({
    'api.yaml': 'openapi: 3.0.3\n', 'api.yml': 'openapi: 3.0.3\n', 'broken.json': '{ "openapi": ', 'swagger.json': { swagger: '2.0', paths: {} },
    'other.json': { hello: 'world' }, 'array.json': [1, 2], 'ok.json': doc({ type: 'object' }),
  });
  const { checker, warnings } = loadContracts([
    { spec: 'api.yaml' }, { spec: 'api.yml' }, { spec: 'broken.json' }, { spec: 'swagger.json' }, { spec: 'other.json' }, { spec: 'array.json' }, { spec: 'missing.json' }, { spec: 'ok.json' },
  ], base);
  assert.equal(warnings.length, 7);
  assert.match(warnings[0], /^contract "api\.yaml": YAML is not supported/);
  assert.match(warnings[1], /YAML is not supported/);
  assert.match(warnings[2], /^contract "broken\.json": not valid JSON/);
  assert.match(warnings[3], /Swagger 2\.0 is not supported/);
  assert.match(warnings[4], /not an OpenAPI 3\.0 or 3\.1 document/);
  assert.match(warnings[5], /not an OpenAPI document/);
  assert.match(warnings[6], /file not found/);
  assert.equal(checker.checkResponse(rec('GET', '/thing', 200)).matched, true); // the one good document still works
  // nothing usable at all: no checker, no throw
  assert.deepEqual(loadContracts([{ spec: 'api.yaml' }], base).checker, undefined);
  assert.deepEqual(loadContracts([], base), { warnings: [] });
  assert.deepEqual(loadContracts(undefined, base), { warnings: [] });
});

test('a document larger than 5 MiB is skipped', () => {
  const { base } = project({ 'big.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'x'.repeat(5 * 1024 * 1024), version: '1' }, paths: {} }) });
  const { checker, warnings } = loadContracts([{ spec: 'big.json' }], base);
  assert.equal(checker, undefined);
  assert.match(warnings[0], /larger than 5 MiB/);
});

test('paths outside the fastqa and project directories are rejected', () => {
  const { base, root } = project({});
  // a real document two levels up must not be reachable
  const outside = path.join(path.dirname(root), `fq-outside-${path.basename(root)}.json`);
  writeFileSync(outside, JSON.stringify(doc({ type: 'object' })));
  for (const spec of ['../../etc/passwd', `../../${path.basename(outside)}`, outside, '/etc/passwd', 'C:\\Windows\\win.ini']) {
    const { checker, warnings } = loadContracts([{ spec }], base);
    assert.equal(checker, undefined, spec);
    assert.equal(warnings.length, 1, spec);
    assert.match(warnings[0], /outside the fastqa and project directories|file not found/, spec);
    assert.ok(!/root:|\[fonts\]/.test(warnings[0]));
  }
  assert.match(loadContracts([{ spec: '../../etc/passwd' }], base).warnings[0], /outside the fastqa and project directories/);
});

test('a document in the project root is found when it is not in the fastqa dir', () => {
  const { base, root } = project({});
  writeFileSync(path.join(root, 'openapi.json'), JSON.stringify(doc({ type: 'object' })));
  mkdirSync(path.join(root, 'api'), { recursive: true });
  writeFileSync(path.join(root, 'api', 'spec.json'), JSON.stringify(doc({ type: 'object' })));
  for (const spec of ['openapi.json', 'api/spec.json']) {
    const { checker, warnings } = loadContracts([{ spec }], base);
    assert.deepEqual(warnings, [], spec);
    assert.equal(checker.checkResponse(rec('GET', '/thing', 200)).matched, true, spec);
  }
});

test('a contract bound to an origin applies only to that origin', () => {
  const { base } = project({
    'a.json': { openapi: '3.0.3', info: { title: 'a', version: '1' }, paths: { '/thing': { get: { responses: { 200: { description: 'ok' } } } } } },
    'b.json': { openapi: '3.0.3', info: { title: 'b', version: '1' }, paths: { '/thing': { get: { responses: { 204: { description: 'ok' } } } } } },
  });
  const bound = loadContracts([{ origin: 'https://a.example.test', spec: 'a.json' }], base).checker;
  assert.equal(bound.checkResponse(rec('GET', '/thing', 200, { origin: 'https://a.example.test' })).matched, true);
  assert.equal(bound.checkResponse(rec('GET', '/thing', 200, { origin: 'https://b.example.test' })).matched, false);
  // an unbound contract covers first-party requests of any origin, never third-party ones
  const unbound = loadContracts([{ spec: 'a.json' }], base).checker;
  assert.equal(unbound.checkResponse(rec('GET', '/thing', 200, { origin: 'https://b.example.test' })).matched, true);
  assert.equal(unbound.checkResponse(rec('GET', '/thing', 200, { origin: 'https://cdn.example.net', firstParty: false })).matched, false);
  // a bound contract wins over an unbound one for its origin, whatever the order in the config
  const both = loadContracts([{ spec: 'a.json' }, { origin: 'https://b.example.test', spec: 'b.json' }], base).checker;
  assert.deepEqual(both.checkResponse(rec('GET', '/thing', 204, { origin: 'https://b.example.test' })).issues, []);
  assert.equal(both.checkResponse(rec('GET', '/thing', 204, { origin: 'https://a.example.test' })).issues[0].kind, 'status');
});

test('responses without a JSON schema ask for no body and report nothing', () => {
  const { checker } = one({
    openapi: '3.0.3', info: { title: 't', version: '1' },
    paths: {
      '/empty': { get: { responses: { 204: { description: 'no content' } } } },
      '/text': { get: { responses: { 200: { description: 'text', content: { 'text/plain': { schema: { type: 'string' } } } } } } },
      '/any': { get: { responses: { 200: { description: 'anything', content: { 'application/json': {} } } } } },
    },
  });
  assert.equal(checker.wantsBody(rec('GET', '/empty', 204, { contentType: undefined })), false);
  assert.equal(checker.wantsBody(rec('GET', '/text', 200, { contentType: 'text/plain' })), false);
  assert.equal(checker.wantsBody(rec('GET', '/any', 200)), false);
  assert.deepEqual(checker.checkBody(rec('GET', '/any', 200), { a: 1 }), { matched: true, issues: [] });
  // a request whose status is not known yet is never judged
  assert.deepEqual(checker.checkResponse(rec('GET', '/empty', undefined)), { matched: true, issues: [] });
});

test('the demo shop scenarios used by the integration tests', () => {
  const { checker } = shop();
  // ?mode=contract: orderId is a number and total a string
  assert.equal(checker.checkBody(rec('POST', '/api/orders', 201), { success: true, orderId: 1001, total: '19.99' }).issues[0].kind, 'schema');
  // ?mode=undoc: 202 is not documented
  assert.equal(checker.checkResponse(rec('POST', '/api/orders', 202)).issues[0].kind, 'status');
  // the other documented endpoints pass with the bodies the demo server sends
  assert.deepEqual(checker.checkBody(rec('POST', '/api/notifications', 200), { queued: true }).issues, []);
  assert.deepEqual(checker.checkBody(rec('GET', '/api/stock/v2', 200), { stock: 5 }).issues, []);
  assert.deepEqual(checker.checkBody(rec('GET', '/api/prices', 200), { n: 1 }).issues, []);
  assert.deepEqual(checker.checkBody(rec('GET', '/api/poll', 200), { tick: 12 }).issues, []);
  // /api/stock (the 302 hop) and /api/slow are not in the contract
  assert.equal(checker.checkResponse(rec('GET', '/api/stock', 302)).matched, false);
  assert.equal(checker.checkResponse(rec('GET', '/api/slow', 200)).notEvaluated, 'no matching operation in the contract');
});
