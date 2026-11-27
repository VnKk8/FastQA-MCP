// Project configuration: .fastqa/config.json. Validated with a strict schema and never executed.
// Precedence: defaults < config file < explicit run options. Hard caps and deny rules (FASTQA_CAPTURE=off) always win.
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Severity } from './observation/types.js';

const sev = z.enum(['info', 'low', 'medium', 'high']);
const method = z.string().regex(/^[A-Za-z*]+$/, 'HTTP method or *').optional();
const origin = z.string().regex(/^https?:\/\/[^/]+$/, 'origin such as https://shop.example.test (no path)');
const pos = z.number().int().positive();

const QualitySchema = z.object({
  mode: z.enum(['observe', 'strict', 'discovery', 'debug', 'off']).optional(),
  firstPartyOrigins: z.array(origin).optional(),
  expectedResponses: z.array(z.object({
    method, path: z.string().min(1), statuses: z.array(z.number().int().min(100).max(599)).min(1),
    scope: z.string().min(1), reason: z.string().min(1),
  }).strict()).optional(),
  suppressions: z.array(z.object({
    id: z.string().min(1), ruleId: z.string().optional(), method, path: z.string().optional(),
    reason: z.string().min(1), expires: z.string().regex(/^\d{4}-\d\d-\d\d/, 'ISO date').optional(),
  }).strict()).optional(),
  businessRules: z.array(z.object({
    id: z.string().min(1), method, path: z.string().min(1), status: z.number().int().optional(),
    jsonPointer: z.string(), equals: z.any().optional(), notEquals: z.any().optional(), exists: z.boolean().optional(),
    severity: sev.optional(),
  }).strict().refine((r) => 'equals' in r || 'notEquals' in r || 'exists' in r, 'needs equals, notEquals or exists')).optional(),
  failOnSeverity: sev.optional(),
  finalizeTimeoutMs: z.number().int().min(0).max(30000).optional(),
  onIncomplete: z.enum(['fail', 'ignore']).optional(),
  postActionWindowMs: z.number().int().min(0).max(10000).optional(),
  inlineFindings: z.number().int().min(0).max(10).optional(),
  performance: z.object({
    slowMs: pos.optional(),
    endpoints: z.array(z.object({ method, path: z.string().min(1), maxMs: pos }).strict()).optional(),
    maxCalls: z.array(z.object({ method, path: z.string().min(1), max: pos, per: z.enum(['action', 'batch']).optional() }).strict()).optional(),
    baseline: z.object({ factor: z.number().min(1).optional(), minDeltaMs: z.number().min(0).optional(), minSamples: pos.optional() }).strict().optional(),
  }).strict().optional(),
  stateRules: z.array(z.object({
    id: z.string().min(1),
    after: z.object({ method, path: z.string().min(1), status: z.number().int().optional() }).strict(),
    expectText: z.string().optional(), expectNoText: z.string().optional(),
    withinMs: z.number().int().min(0).max(10000).optional(), severity: sev.optional(),
  }).strict().refine((r) => r.expectText !== undefined || r.expectNoText !== undefined, 'needs expectText or expectNoText')).optional(),
  contracts: z.array(z.object({ origin: origin.optional(), spec: z.string().min(1), basePath: z.string().optional() }).strict()).optional(),
}).strict();

const ConfigSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  quality: QualitySchema.optional(),
  capture: z.object({
    payloads: z.enum(['off', 'json']).optional(),
    maxEvents: pos.optional(), maxBytes: pos.optional(), maxBodyBytes: pos.optional(),
    allowedOrigins: z.array(origin).optional(),
    allowedEndpoints: z.array(z.object({ method, path: z.string().min(1) }).strict()).optional(),
    allowUnknownLength: z.boolean().optional(),
  }).strict().optional(),
  privacy: z.object({
    keepQueryParams: z.array(z.string()).optional(),
    secretVars: z.array(z.string()).optional(),
    secretKeys: z.array(z.string().min(1)).optional(),
    maskSelectors: z.array(z.string()).optional(),
  }).strict().optional(),
  locator: z.object({ strict: z.boolean().optional() }).strict().optional(),
  discovery: z.object({ enabled: z.boolean().optional(), pathTemplates: z.array(z.string()).optional() }).strict().optional(),
  artifacts: z.object({
    enabled: z.boolean().optional(), maxBytesPerRun: pos.optional(), retentionDays: z.number().min(0).optional(),
    maxRuns: pos.optional(), screenshots: z.boolean().optional(), maxScreenshots: pos.optional(), maxReports: pos.optional(),
  }).strict().optional(),
  browser: z.object({ ignoreHTTPSErrors: z.boolean().optional(), allowedOrigins: z.array(origin).optional() }).strict().optional(),
  mcp: z.object({ structuredContent: z.boolean().optional() }).strict().optional(),
}).strict();

export type RawConfig = z.infer<typeof ConfigSchema>;
export type Mode = 'observe' | 'strict' | 'discovery' | 'debug' | 'off';
type Q = NonNullable<RawConfig['quality']>;

export interface Config {
  source?: string;
  warnings: string[];
  mode: Mode;
  enforce: boolean;
  firstPartyOrigins: string[];
  expectedResponses: NonNullable<Q['expectedResponses']>;
  suppressions: NonNullable<Q['suppressions']>;
  businessRules: NonNullable<Q['businessRules']>;
  failOnSeverity: Severity;
  finalizeTimeoutMs: number;
  onIncomplete: 'fail' | 'ignore';
  postActionWindowMs: number;
  inlineFindings: number;
  performance?: Q['performance'];
  stateRules: NonNullable<Q['stateRules']>;
  contracts: NonNullable<Q['contracts']>;
  capture: { payloads: 'off' | 'json'; maxEvents: number; maxBytes: number; maxBodyBytes: number; allowedOrigins: string[]; allowedEndpoints: Array<{ method?: string; path: string }>; allowUnknownLength: boolean; maxBodyReaders: number };
  privacy: { keepQueryParams: string[]; secretVars: string[]; secretKeys: string[]; maskSelectors: string[] };
  strictLocators: boolean;
  discovery: { enabled: boolean; pathTemplates: string[] };
  artifacts: { enabled: boolean; maxBytesPerRun: number; retentionDays: number; maxRuns: number; screenshots: boolean; maxScreenshots: number; maxReports: number };
  browser: { ignoreHTTPSErrors: boolean; allowedOrigins: string[]; legacyTls: boolean };
  structuredContent: boolean;
}

export class ConfigError extends Error {}

// Hard caps: a config file can lower these, never raise them.
export const CAPS = { maxEvents: 20000, maxBytes: 64 * 1024 * 1024, maxBodyBytes: 256 * 1024, maxBodyReaders: 16 };
const MiB = 1024 * 1024;
const truthy = (v?: string) => /^(1|true|yes|on)$/i.test(v || '');

export function parseConfig(raw: unknown, opts: { mode?: Mode; fileExists?: boolean; source?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const env = opts.env ?? process.env;
  const res = ConfigSchema.safeParse(raw ?? {});
  if (!res.success) {
    const issues = res.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}${i.code === 'unrecognized_keys' ? ' ' + (i as any).keys.join(', ') : ''}`);
    throw new ConfigError(`Invalid ${opts.source ?? 'fastqa config'}: ${issues.join('; ')}`);
  }
  const c = res.data; const q = c.quality ?? {}; const warnings: string[] = [];
  const envMode = env.FASTQA_QUALITY as Mode | undefined;
  if (envMode && !['observe', 'strict', 'discovery', 'debug', 'off'].includes(envMode)) throw new ConfigError(`FASTQA_QUALITY must be observe, strict, discovery, debug or off (got "${envMode}")`);
  const mode: Mode = opts.mode ?? envMode ?? q.mode ?? 'observe';

  const cap = (name: keyof typeof CAPS, v: number | undefined, dflt: number) => {
    if (v !== undefined && v > CAPS[name]) { warnings.push(`capture.${name} lowered to the hard cap ${CAPS[name]}`); return CAPS[name]; }
    return v ?? dflt;
  };
  const allowedOrigins = c.capture?.allowedOrigins ?? [];
  let payloads: 'off' | 'json' = c.capture?.payloads ?? (mode === 'debug' && allowedOrigins.length ? 'json' : 'off');
  if (payloads === 'json' && !allowedOrigins.length) throw new ConfigError('capture.payloads "json" needs capture.allowedOrigins: payload capture is never global');
  if (mode === 'debug' && c.capture?.payloads === undefined && !allowedOrigins.length) warnings.push('debug mode: payload capture stays off until capture.allowedOrigins is set');
  if (truthy(env.FASTQA_CAPTURE_OFF) || /^off$/i.test(env.FASTQA_CAPTURE || '')) payloads = 'off'; // deny rule: cannot be weakened by config

  const legacyTls = !opts.fileExists && env.FASTQA_IGNORE_HTTPS_ERRORS === undefined;
  const ignoreHTTPSErrors = env.FASTQA_IGNORE_HTTPS_ERRORS !== undefined ? truthy(env.FASTQA_IGNORE_HTTPS_ERRORS)
    : c.browser?.ignoreHTTPSErrors ?? !opts.fileExists; // no config file: 0.3.x behaviour (ignore); with a config file: secure by default

  return {
    source: opts.source, warnings, mode, enforce: mode === 'strict',
    firstPartyOrigins: q.firstPartyOrigins ?? [],
    expectedResponses: q.expectedResponses ?? [], suppressions: q.suppressions ?? [], businessRules: q.businessRules ?? [],
    failOnSeverity: q.failOnSeverity ?? 'high',
    finalizeTimeoutMs: q.finalizeTimeoutMs ?? 3000,
    onIncomplete: q.onIncomplete ?? 'fail',
    postActionWindowMs: q.postActionWindowMs ?? 1500,
    inlineFindings: q.inlineFindings ?? 3,
    performance: q.performance, stateRules: q.stateRules ?? [], contracts: q.contracts ?? [],
    capture: {
      payloads, maxEvents: cap('maxEvents', c.capture?.maxEvents, 2000), maxBytes: cap('maxBytes', c.capture?.maxBytes, 8 * MiB),
      maxBodyBytes: cap('maxBodyBytes', c.capture?.maxBodyBytes, 16 * 1024), allowedOrigins,
      allowedEndpoints: c.capture?.allowedEndpoints ?? [], allowUnknownLength: c.capture?.allowUnknownLength ?? false,
      maxBodyReaders: CAPS.maxBodyReaders,
    },
    privacy: { keepQueryParams: c.privacy?.keepQueryParams ?? [], secretVars: c.privacy?.secretVars ?? [], secretKeys: c.privacy?.secretKeys ?? [], maskSelectors: c.privacy?.maskSelectors ?? [] },
    strictLocators: c.locator?.strict ?? false,
    discovery: { enabled: c.discovery?.enabled ?? mode === 'discovery', pathTemplates: c.discovery?.pathTemplates ?? [] },
    artifacts: {
      enabled: c.artifacts?.enabled ?? false, maxBytesPerRun: c.artifacts?.maxBytesPerRun ?? 32 * MiB,
      retentionDays: c.artifacts?.retentionDays ?? 7, maxRuns: c.artifacts?.maxRuns ?? 20, screenshots: c.artifacts?.screenshots ?? true,
      maxScreenshots: c.artifacts?.maxScreenshots ?? 200, maxReports: c.artifacts?.maxReports ?? 200,
    },
    browser: { ignoreHTTPSErrors, allowedOrigins: c.browser?.allowedOrigins ?? [], legacyTls: legacyTls && ignoreHTTPSErrors },
    structuredContent: c.mcp?.structuredContent ?? truthy(env.FASTQA_STRUCTURED),
  };
}

/** Reads <dir>/config.json. A missing file means defaults; an invalid one is an error, never a silent fallback. */
export function loadConfig(dir: string, mode?: Mode): Config {
  const file = path.join(dir, 'config.json');
  if (!existsSync(file)) return parseConfig({}, { mode, fileExists: false });
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e: any) { throw new ConfigError(`Invalid ${file}: not valid JSON (${String(e?.message || e).slice(0, 120)})`); }
  return parseConfig(raw, { mode, fileExists: true, source: file });
}

/** The effective configuration with nothing sensitive in it, for logs, evidence and session summaries. */
export function describeConfig(c: Config) {
  return {
    mode: c.mode, enforce: c.enforce, failOnSeverity: c.failOnSeverity, onIncomplete: c.onIncomplete,
    firstPartyOrigins: c.firstPartyOrigins, expectedResponses: c.expectedResponses.length, suppressions: c.suppressions.length,
    businessRules: c.businessRules.map((r) => r.id), stateRules: c.stateRules.map((r) => r.id), contracts: c.contracts.length,
    performance: c.performance ? 'configured' : 'disabled',
    capture: { payloads: c.capture.payloads, maxEvents: c.capture.maxEvents, maxBytes: c.capture.maxBytes, maxBodyBytes: c.capture.maxBodyBytes, allowedOrigins: c.capture.allowedOrigins, allowedEndpoints: c.capture.allowedEndpoints.length },
    strictLocators: c.strictLocators, discovery: c.discovery.enabled, artifacts: c.artifacts.enabled,
    ignoreHTTPSErrors: c.browser.ignoreHTTPSErrors, source: c.source ? 'config.json' : 'defaults', warnings: c.warnings,
  };
}
