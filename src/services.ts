// Optional services that attach to a session: artifacts, discovery, contracts, baselines.
// Kept out of session.ts so the core (execution + observation) has no dependency on them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sessionHooks, type Session } from './session.js';
import type { Observer } from './observation/observer.js';
import type { EvidenceQuery } from './evidence/query.js';
import { BundleStream, streams, writeBundle, writeBugDraft, sessionsDir, type BundleExtra } from './evidence/bundle.js';
import { loadBaseline, recordBaseline as record, scopeKey, scopeOf, memoBaseline } from './quality/baseline.js';
import { DiscoveryGraph, mergeDiscovery as merge, renderDiscovery, type DiscoveryExport } from './discovery/graph.js';
import { loadContracts } from './contract/openapi.js';
import { FLOW_DIR, writeAtomic } from './dirs.js';
import { redactor } from './privacy/redact.js';
import { VERSION } from './version.js';

const bundled = new WeakSet<Observer>();
const graphs = new WeakMap<Observer, DiscoveryGraph>();
/** contract warnings are printed once per process, not once per flow run */
const warned = new Set<string>();
let installed = false;

export function installServices() {
  if (installed) return;
  installed = true;
  sessionHooks.created.push((s: Session) => {
    const obs = s.obs; const cfg = s.cfg;
    obs.environment.fastqa = VERSION;
    if (cfg.artifacts.enabled) {
      const st = new BundleStream(obs, cfg.artifacts.maxBytesPerRun * 0.8);
      streams.set(obs, st); obs.sinks.push(st);
    }
    if (cfg.discovery.enabled) {
      const g = new DiscoveryGraph({
        sessionId: obs.sessionId, pathTemplates: cfg.discovery.pathTemplates,
        describeAction: (id) => { const a = obs.actions.get(id); return a ? { label: a.label, kind: a.do, ...(a.control ? { control: a.control } : {}) } : undefined; },
        scopeOf: (b) => obs.actions.scopeOf(b),
        batchKind: (b) => obs.actions.batches.find((x) => x.batchId === b)?.kind,
      });
      if (s.role || s.options.env) g.context = { role: s.role, env: s.options.env };
      graphs.set(obs, g); obs.sinks.push(g);
    }
    if (cfg.contracts.length) {
      // Local files only, resolved inside the fastqa dir or the project root. A document that cannot be used is a warning, never a crash.
      const { checker, warnings } = loadContracts(cfg.contracts, FLOW_DIR());
      obs.quality.contract = checker;
      for (const w of warnings) if (!warned.has(w)) { warned.add(w); console.error(`fastqa: ${w}`); }
      if (warnings.length) obs.environment.contractWarnings = warnings;
    }
    // labels the caller gave for this run (never inferred): they scope baselines and appear in bundles
    if (s.role) obs.environment.role = s.role;
    if (s.options.env) obs.environment.env = s.options.env;
    if (s.options.baseline === 'check' || cfg.performance?.baseline) {
      // the scope needs the application origin, known once the first page was opened: looked up at first use and again
      // only when the scope changes; a scope without a baseline is said ("not evaluated"), never silently skipped
      obs.quality.baseline = memoBaseline(() => scopeKey(scopeOf(obs)), (k) => loadBaseline(cfg, k),
        (k) => obs.quality.markNotEvaluated('PERF-BASELINE', `no response-time baseline recorded for ${k}`));
    }
    // a session that ends (close, fresh context) leaves its bundle behind when artifacts are on
    s.onEnd = async (o) => { if ((cfg.artifacts.enabled || s.options.bundle) && !bundled.has(o)) await exportBundle(o); };
  });
}

export async function exportBundle(obs: Observer, extra: BundleExtra = {}): Promise<string> {
  // a bundle written while the session is still running is a snapshot: the final one is still written when it ends
  if (obs.disposed || extra.final) bundled.add(obs);
  const g = graphs.get(obs);
  return writeBundle(obs, { ...extra, environment: { ...obs.environment, ...extra.environment }, discovery: g ? { endpoints: g.export(), journeys: g.journeys() } : undefined });
}

export async function bugDraft(obs: Observer, findingId: string): Promise<{ file: string; markdown: string } | undefined> {
  return writeBugDraft(obs, findingId, { environment: obs.environment });
}

/** Discovery only (opt-in): what a snapshot showed on a page, from lines fastqa already has. No page access. */
export function noteSnapshot(obs: Observer | undefined, url: string, lines: string[]) {
  const g = obs ? graphs.get(obs) : undefined;
  if (g) try { g.noteSnapshot(obs!.redactor.pageUrl(url), lines); } catch { /* discovery must never break a call */ }
}

export function discoveryView(obs: Observer, q: Partial<EvidenceQuery>): string {
  const g = graphs.get(obs);
  if (!g) return 'Discovery is off for this session. Set quality.mode "discovery" (or discovery.enabled) in .fastqa/config.json and open a fresh context.';
  return renderDiscovery(g.export(), { path: q.path, limit: q.limit });
}

/** Explicit merge of the sanitized discovery exports of saved session bundles into .fastqa/discovery.json. */
export async function mergeDiscovery(): Promise<string> {
  const root = sessionsDir();
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const exports: DiscoveryExport[] = [];
  for (const n of names.sort()) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(root, n, 'discovery', 'endpoints.json'), 'utf8'));
      if (d?.schemaVersion === 1 && d.kind === 'fastqa-discovery') exports.push(d);
    } catch { /* no discovery export in this bundle */ }
  }
  if (!exports.length) return `No discovery exports found in ${root}. Run with quality.mode "discovery" and artifacts enabled (or --bundle).`;
  const merged = merge(exports);
  const file = path.join(FLOW_DIR(), 'discovery.json');
  await writeAtomic(file, JSON.stringify(redactor.deep(merged), null, 2) + '\n');
  return `Merged ${exports.length} session export${exports.length === 1 ? '' : 's'} into ${file}: ${merged.routes.length} routes, ${merged.endpoints.length} endpoints, ${merged.edges.length} edges.\n` +
    'This lists observed activity only: it is not a coverage measure and says nothing about pages or endpoints that were not visited.';
}

export const recordBaseline = (samples: Observer[]) => record(samples);
