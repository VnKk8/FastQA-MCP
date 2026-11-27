// Optional OpenAPI contract checks: response status, media type and body schema of observed first-party calls.
//
// Supported
//   - OpenAPI 3.0.x: schemas are compiled as JSON Schema draft-07 after converting `nullable: true` to a type union
//     and the boolean `exclusiveMinimum` / `exclusiveMaximum` to their numeric form.
//   - OpenAPI 3.1.x: schemas are compiled as JSON Schema 2020-12 (ajv/dist/2020).
//   - Local JSON documents only, at most 5 MiB, read from the fastqa dir or the project root. Local `#/…` refs,
//     including recursive ones. Path templates (`/orders/{id}`), `servers[0].url` path prefix or an explicit basePath.
//   - Response keys: exact status, `2XX`-style ranges and `default`.
// Not supported (reported as a warning or as "not evaluated", never as a mismatch)
//   - Swagger 2.0, YAML, remote or file `$ref`s (nothing is ever fetched), request validation.
//   - `format` is not validated; `discriminator`, `xml`, `example(s)` are ignored; `readOnly` / `writeOnly` are not enforced.
// Privacy: issue texts are built from the contract only (pointer paths made of names the contract declares, keywords,
// expected types). Response values and undeclared response keys are never echoed.
// Bounds: the document is loaded once, validators are compiled lazily and cached per operation + status + media type.
// Validation is synchronous; its input is already bounded by the payload capture limit. `pattern` regexes come from the
// local contract, which is trusted configuration.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Config } from '../config.js';
import { inside } from '../dirs.js';
import type { RequestRecord } from '../observation/types.js';
import type { ContractChecker, ContractIssue, ContractOutcome } from '../quality/engine.js';
import { jsonPointer, patternToRegex } from '../util/paths.js';

const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const MAX_OPERATIONS = 5000;
const MAX_NODES = 200_000;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const NO_OPERATION = 'no matching operation in the contract';
const REMOTE_REF = 'remote $ref is not resolved';
const DOC_KEY = 'fastqa-contract';

class RemoteRefError extends Error {}

interface Operation {
  method: string;
  /** full path template including the base path, e.g. /v1/orders/{id} */
  template: string;
  regex: RegExp;
  params: number;
  /** JSON pointer (without '#') of the operation's `responses` object in the document */
  pointer: string;
  responses: Record<string, unknown>;
}
interface Compiled { validate?: ValidateFunction; notEvaluated?: string }
interface Spec {
  label: string;
  origin?: string;
  doc: any;
  v31: boolean;
  ops: Operation[];
  /** every property name the contract declares: the only response keys that may be echoed in a message */
  vocabulary: Set<string>;
  ajv?: InstanceType<typeof Ajv> | InstanceType<typeof Ajv2020>;
  validators: Map<string, Compiled>;
}
interface Hit { spec: Spec; op: Operation }
interface ResolvedResponse { key: string; node: any; pointer: string }

const esc = (seg: string) => seg.replace(/~/g, '~0').replace(/\//g, '~1');
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const mediaOf = (ct?: string) => (ct ?? '').split(';')[0].trim().toLowerCase();
const isJsonMedia = (m: string) => m === 'application/json' || m.endsWith('+json') || m === '*/*' || m === 'application/*';

/** Path part of a server URL (`https://api.example.test/v1` -> `/v1`, `/v1/` -> `/v1`). Server variables stay as `{name}` segments. */
function serverPath(url: unknown): string {
  if (typeof url !== 'string') return '';
  const p = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
  return p.replace(/\/+$/, '');
}
function joinPath(base: string, p: string): string {
  const b = base ? '/' + base.replace(/^\/+|\/+$/g, '') : '';
  return (b + '/' + p.replace(/^\/+/, '')).replace(/\/{2,}/g, '/');
}

/** Follows local `$ref`s of a non-schema node (path item, response). Returns the node and where it lives in the document. */
function deref(doc: any, node: any, pointer: string): { node: any; pointer: string } {
  for (let i = 0; i < 20 && isObj(node) && typeof node.$ref === 'string'; i++) {
    const ref: string = node.$ref;
    if (!ref.startsWith('#')) throw new RemoteRefError(ref);
    pointer = decodeURIComponent(ref.slice(1));
    const got = jsonPointer(doc, pointer);
    if (!got.found) throw new Error(`unresolved $ref ${ref}`);
    node = got.value;
  }
  return { node, pointer };
}

/**
 * Walks a schema and everything it references. Throws on a remote ref, a dangling ref or an oversized schema.
 * `targets` collects every referenced schema, so each one can be checked against the meta-schema before compiling.
 */
function scanRefs(doc: any, node: unknown, seen: Set<object>, targets: unknown[], budget: { n: number }) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (budget.n-- <= 0) throw new Error('schema is too large');
  if (Array.isArray(node)) { for (const x of node) scanRefs(doc, x, seen, targets, budget); return; }
  const o = node as Record<string, unknown>;
  if (typeof o.$ref === 'string') {
    if (!o.$ref.startsWith('#')) throw new RemoteRefError(o.$ref);
    const got = jsonPointer(doc, decodeURIComponent(o.$ref.slice(1)));
    if (!got.found) throw new Error(`unresolved $ref ${o.$ref}`);
    if (got.value && typeof got.value === 'object' && !seen.has(got.value)) targets.push(got.value);
    scanRefs(doc, got.value, seen, targets, budget);
  }
  for (const v of Object.values(o)) scanRefs(doc, v, seen, targets, budget);
}

/**
 * OpenAPI 3.0 schema objects -> JSON Schema draft-07, in place on a private copy of the document:
 * `nullable: true` becomes a type union (or an anyOf with null), boolean exclusive bounds become numeric.
 */
function convert30(node: unknown, budget: { n: number }) {
  if (!node || typeof node !== 'object' || budget.n-- <= 0) return;
  if (Array.isArray(node)) { for (const x of node) convert30(x, budget); return; }
  const o = node as Record<string, any>;
  for (const v of Object.values(o)) convert30(v, budget);
  for (const [excl, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    if (typeof o[excl] !== 'boolean') continue;
    if (o[excl] && typeof o[bound] === 'number') { o[excl] = o[bound]; delete o[bound]; } else delete o[excl];
  }
  if (o.nullable === true) {
    delete o.nullable;
    if (typeof o.type === 'string' && !o.allOf && !o.anyOf && !o.oneOf && !o.$ref) {
      o.type = [o.type, 'null'];
      if (Array.isArray(o.enum) && !o.enum.includes(null)) o.enum = [...o.enum, null];
    } else if (Array.isArray(o.type)) {
      if (!o.type.includes('null')) o.type = [...o.type, 'null'];
    } else {
      const rest = { ...o };
      for (const k of Object.keys(o)) delete o[k];
      o.anyOf = [rest, { type: 'null' }];
    }
  } else if (o.nullable === false) delete o.nullable;
}

function collectVocabulary(node: unknown, out: Set<string>, budget: { n: number }) {
  if (!node || typeof node !== 'object' || budget.n-- <= 0) return;
  if (Array.isArray(node)) { for (const x of node) collectVocabulary(x, out, budget); return; }
  const o = node as Record<string, unknown>;
  if (isObj(o.properties)) for (const k of Object.keys(o.properties)) out.add(k);
  if (Array.isArray(o.required)) for (const k of o.required) if (typeof k === 'string') out.add(k);
  for (const v of Object.values(o)) collectVocabulary(v, out, budget);
}

function loadSpec(c: { origin?: string; spec: string; basePath?: string }, baseDir: string): Spec | string {
  if (/\.ya?ml$/i.test(c.spec)) return 'YAML is not supported; convert the document to JSON';
  let file: string | undefined; let base = ''; let escaped = 0;
  const bases = [baseDir, path.dirname(baseDir)];
  for (const b of bases) {
    try { const f = inside(b, c.spec); if (existsSync(f)) { file = f; base = b; break; } }
    catch { escaped++; }
  }
  if (!file) return escaped === bases.length ? 'path is outside the fastqa and project directories' : 'file not found in the fastqa or project directory';
  try { inside(realpathSync(base), realpathSync(file)); } catch { return 'path resolves outside the allowed directory'; }
  let doc: any;
  try {
    const st = statSync(file);
    if (!st.isFile()) return 'not a file';
    if (st.size > MAX_SPEC_BYTES) return `larger than ${MAX_SPEC_BYTES / 1024 / 1024} MiB`;
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e: any) { return e instanceof SyntaxError ? 'not valid JSON' : `cannot be read (${String(e?.code ?? e?.message ?? e).slice(0, 60)})`; }
  if (!isObj(doc)) return 'not an OpenAPI document';
  if (doc.swagger !== undefined) return 'Swagger 2.0 is not supported';
  if (typeof doc.openapi !== 'string' || !/^3\.[01](\.|$)/.test(doc.openapi)) return 'not an OpenAPI 3.0 or 3.1 document';
  const v31 = /^3\.1/.test(doc.openapi);
  if (!v31) convert30(doc, { n: MAX_NODES });
  const prefix = c.basePath ?? serverPath(doc.servers?.[0]?.url);
  const ops: Operation[] = [];
  for (const [p, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!p.startsWith('/') || ops.length >= MAX_OPERATIONS) continue;
    let item: { node: any; pointer: string };
    try { item = deref(doc, rawItem, `/paths/${esc(p)}`); } catch { continue; } // a path item behind a remote ref is simply not known
    if (!isObj(item.node)) continue;
    const template = joinPath(prefix, p);
    for (const m of METHODS) {
      const op = item.node[m];
      if (!isObj(op)) continue;
      ops.push({
        method: m, template, regex: patternToRegex(template), params: (template.match(/\{[^}]+\}/g) ?? []).length,
        pointer: `${item.pointer}/${m}/responses`, responses: isObj(op.responses) ? op.responses : {},
      });
    }
  }
  ops.sort((a, b) => a.params - b.params || b.template.length - a.template.length); // literal paths win over templates
  const vocabulary = new Set<string>();
  collectVocabulary(doc, vocabulary, { n: MAX_NODES });
  return { label: c.spec, origin: c.origin, doc, v31, ops, vocabulary, validators: new Map() };
}

class Checker implements ContractChecker {
  constructor(private specs: Spec[]) {}

  private find(rec: RequestRecord): Hit | undefined {
    const method = rec.method.toLowerCase();
    for (const spec of this.specs) {
      if (spec.origin ? spec.origin !== rec.origin : !rec.firstParty) continue;
      const op = spec.ops.find((o) => o.method === method && o.regex.test(rec.path));
      if (op) return { spec, op };
    }
    return undefined;
  }

  /** The documented response for a status: exact code, then the `2XX` range, then `default`. */
  private response(h: Hit, status: number): ResolvedResponse | undefined {
    const r = h.op.responses;
    const range = `${Math.floor(status / 100)}xx`;
    const key = String(status) in r ? String(status) : Object.keys(r).find((k) => k.toLowerCase() === range) ?? ('default' in r ? 'default' : undefined);
    if (key === undefined) return undefined;
    const d = deref(h.spec.doc, r[key], `${h.op.pointer}/${esc(key)}`);
    return { key, node: d.node, pointer: d.pointer };
  }

  /** The media entry that applies to this response and has a JSON schema, with the pointer of that schema. */
  private schemaOf(res: ResolvedResponse, contentType?: string): { media: string; node: unknown; pointer: string } | undefined {
    const content = res.node?.content;
    if (!isObj(content)) return undefined;
    const ct = mediaOf(contentType);
    const keys = Object.keys(content);
    const key = keys.find((k) => mediaOf(k) === ct) ?? keys.find((k) => mediaMatches(mediaOf(k), ct) && isJsonMedia(mediaOf(k))) ?? (ct ? undefined : keys.find((k) => isJsonMedia(mediaOf(k))));
    if (key === undefined || !isJsonMedia(mediaOf(key)) || (ct && !isJsonMedia(ct))) return undefined;
    const schema = content[key]?.schema;
    if (schema === undefined || (typeof schema !== 'object' && typeof schema !== 'boolean')) return undefined;
    return { media: key, node: schema, pointer: `${res.pointer}/content/${esc(key)}/schema` };
  }

  checkResponse(rec: RequestRecord): ContractOutcome {
    const h = this.find(rec);
    if (!h) return { matched: false, issues: [], notEvaluated: NO_OPERATION };
    if (rec.status === undefined) return { matched: true, issues: [] };
    let res: ResolvedResponse | undefined;
    try { res = this.response(h, rec.status); }
    catch (e) { return { matched: true, issues: [], notEvaluated: e instanceof RemoteRefError ? REMOTE_REF : `unsupported contract: ${short(e)}` }; }
    const where = `${rec.method.toUpperCase()} ${h.op.template}`;
    if (!res) {
      const documented = Object.keys(h.op.responses).sort();
      return { matched: true, issues: [{
        kind: 'status', signature: `status ${rec.status}`,
        message: `status ${rec.status} is not documented in the contract`,
        expected: documented.length ? `one of ${documented.join(', ')} (documented for ${where})` : `a documented status for ${where}`,
        actual: `HTTP ${rec.status}`,
      }] };
    }
    const issues: ContractIssue[] = [];
    const declared = isObj(res.node?.content) ? Object.keys(res.node.content).map(mediaOf).filter(Boolean) : [];
    const ct = mediaOf(rec.contentType);
    if (declared.length && ct && !declared.some((d) => mediaMatches(d, ct))) {
      issues.push({
        kind: 'media', signature: `media ${res.key} ${ct}`,
        message: `media type ${ct} is not documented for status ${res.key}`,
        expected: `one of ${declared.join(', ')}`, actual: ct,
      });
    }
    return { matched: true, issues, needsBody: !!this.schemaOf(res, rec.contentType) };
  }

  wantsBody(rec: RequestRecord): boolean {
    const h = this.find(rec);
    if (!h || rec.status === undefined) return false;
    try { const res = this.response(h, rec.status); return !!res && !!this.schemaOf(res, rec.contentType); }
    catch { return false; }
  }

  checkBody(rec: RequestRecord, json: unknown): ContractOutcome {
    const h = this.find(rec);
    if (!h) return { matched: false, issues: [], notEvaluated: NO_OPERATION };
    if (rec.status === undefined) return { matched: true, issues: [] };
    let res: ResolvedResponse | undefined;
    try { res = this.response(h, rec.status); }
    catch (e) { return { matched: true, issues: [], notEvaluated: e instanceof RemoteRefError ? REMOTE_REF : `unsupported contract: ${short(e)}` }; }
    const schema = res && this.schemaOf(res, rec.contentType);
    if (!res || !schema) return { matched: true, issues: [] }; // an undocumented status is reported by checkResponse
    const key = `${h.op.method} ${h.op.template}|${res.key}|${schema.media}`;
    let c = h.spec.validators.get(key);
    if (!c) { c = compile(h.spec, schema.node, schema.pointer); h.spec.validators.set(key, c); }
    if (!c.validate) return { matched: true, issues: [], notEvaluated: c.notEvaluated };
    let ok: boolean;
    try { ok = c.validate(json) as boolean; }
    catch (e) { return { matched: true, issues: [], notEvaluated: `unsupported schema: ${short(e)}` }; }
    if (ok) return { matched: true, issues: [] };
    return { matched: true, issues: [schemaIssue(h, res.key, c.validate.errors ?? [], json)] };
  }
}

function mediaMatches(declared: string, actual: string): boolean {
  return declared === actual || declared === '*/*' || (declared.endsWith('/*') && actual.startsWith(declared.slice(0, -1)));
}

const short = (e: unknown) => String((e as any)?.message ?? e).replace(/\s+/g, ' ').slice(0, 100);

function compile(spec: Spec, schema: unknown, pointer: string): Compiled {
  try {
    const targets: unknown[] = [schema];
    scanRefs(spec.doc, schema, new Set(), targets, { n: 50_000 });
    if (!spec.ajv) {
      const opts = { strict: false, allErrors: true, validateFormats: false, unicodeRegExp: false, logger: false as const };
      spec.ajv = spec.v31 ? new Ajv2020(opts) : new Ajv(opts);
      // The whole document is registered once, so local and recursive refs resolve. It is not a schema itself: no meta validation.
      spec.ajv.addSchema(spec.doc, DOC_KEY, false, false);
    }
    const ajv = spec.ajv;
    for (const s of targets) {
      if (!ajv.validateSchema(s as any)) return { notEvaluated: `unsupported schema: ${short(ajv.errorsText(ajv.errors, { dataVar: 'schema' }))}` };
    }
    // pointer segments are URI-encoded for the fragment (path templates contain braces); "~0" / "~1" stay as they are
    return { validate: ajv.compile({ $ref: `${DOC_KEY}#${pointer.split('/').map(encodeURIComponent).join('/')}` }) };
  } catch (e) {
    if (e instanceof RemoteRefError) return { notEvaluated: REMOTE_REF };
    return { notEvaluated: `unsupported schema: ${short(e)}` };
  }
}

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** Instance path made only of names the contract declares: array indexes become `*`, any other key becomes `{key}`. */
function safePath(spec: Spec, instancePath: string): string {
  if (!instancePath) return '';
  return instancePath.split('/').slice(1).map((raw) => {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(seg) ? '*' : spec.vocabulary.has(seg) ? seg : '{key}';
  }).map((s) => '/' + s).join('');
}

function schemaIssue(h: Hit, statusKey: string, errors: ErrorObject[], json: unknown): ContractIssue {
  // A failed anyOf / oneOf also reports every branch: keep the composite error, drop the branch noise.
  const composite = errors.some((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf');
  const relevant = composite ? errors.filter((e) => !/\/(anyOf|oneOf)\/\d+\//.test(e.schemaPath)) : errors;
  const seen = new Map<string, string>();
  for (const e of relevant.length ? relevant : errors) {
    const p = safePath(h.spec, e.instancePath);
    const key = `${p || '/'} ${e.keyword}`;
    if (seen.has(key)) continue;
    // Ajv messages are built from the schema (types, limits, declared names), never from the instance.
    let msg = e.keyword === 'additionalProperties' ? 'must NOT have additional properties' : String(e.message ?? e.keyword).slice(0, 80);
    if (e.keyword === 'type') { const got = jsonPointer(json, e.instancePath); if (got.found) msg += ` (is ${typeName(got.value)})`; }
    seen.set(key, `${p || '(root)'} ${msg}`);
  }
  const parts = [...seen.values()];
  const keys = [...seen.keys()].sort();
  return {
    kind: 'schema',
    signature: `schema ${statusKey} ${keys.slice(0, 10).join(',')}`,
    message: `response body does not match the schema: ${parts.slice(0, 3).join('; ')}${parts.length > 3 ? ` (+${parts.length - 3} more)` : ''}`,
    expected: `a body matching the documented schema of ${h.op.method.toUpperCase()} ${h.op.template} ${statusKey}`,
    actual: `${parts.length} schema violation(s): ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`,
  };
}

/**
 * Loads the configured contracts. A document that cannot be used produces a warning and is skipped; it never throws.
 * Returns no checker when no contract could be loaded.
 */
export function loadContracts(contracts: Config['contracts'], baseDir: string): { checker?: ContractChecker; warnings: string[] } {
  const warnings: string[] = [];
  const specs: Spec[] = [];
  for (const c of contracts ?? []) {
    let res: Spec | string;
    try { res = loadSpec(c, baseDir); } catch (e) { res = `cannot be loaded (${short(e)})`; }
    if (typeof res === 'string') { warnings.push(`contract "${c.spec}": ${res}`); continue; }
    if (!res.ops.length) warnings.push(`contract "${c.spec}": no operations found`);
    specs.push(res);
  }
  if (!specs.length) return { warnings };
  specs.sort((a, b) => Number(!!b.origin) - Number(!!a.origin)); // a contract bound to an origin wins over an unbound one
  return { checker: new Checker(specs), warnings };
}
