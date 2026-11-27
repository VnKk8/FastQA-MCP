// Local, sanitized session artifacts under .fastqa/sessions/<runId>/. JSON is canonical; Markdown is derived from it.
// Opt-in (artifacts.enabled, `fastqa-mcp run --bundle`, or evidence {report:true}). Nothing is uploaded anywhere.
//
//   summary.json        written last and atomically: a directory without it is an interrupted run
//   actions.jsonl       sanitized action ledger
//   observations.jsonl  bounded event detail (streamed while the session runs when artifacts.enabled)
//   findings.json       canonical candidate records
//   discovery/          only when discovery is on
//   evidence/<id>/      finding.md (derived) and network.json for that finding
import { createWriteStream, mkdirSync, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Observer, ObserverSink } from '../observation/observer.js';
import type { Finding, Observation, RequestRecord } from '../observation/types.js';
import { SEVERITIES } from '../observation/types.js';
import { describeConfig, type Config } from '../config.js';
import { FLOW_DIR, rel, writeAtomic } from '../dirs.js';
import { md, redactor } from '../privacy/redact.js';

const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const FINDING_ID = /^F-\d{3,6}$/;
export const sessionsDir = () => path.join(FLOW_DIR(), 'sessions');
export const sessionDir = (obs: Observer) => path.join(sessionsDir(), obs.runId);
/** Serialization boundary: every line is sanitized again with everything the redactor has learned by now. */
const line = (v: unknown) => redactor.text(JSON.stringify(v)) + '\n';

export interface BundleExtra {
  flow?: string;
  reports?: { html?: string; junit?: string };
  screenshot?: string;
  execution?: { status: 'passed' | 'failed'; steps?: number; failedAt?: number };
  policy?: { outcome: string; reasons: string[] };
  environment?: Record<string, unknown>;
  discovery?: { endpoints: unknown; journeys: unknown };
}

/** Streams observations to disk as they happen, within a byte budget. Used when artifacts.enabled. */
export class BundleStream implements ObserverSink {
  private stream?: WriteStream;
  bytes = 0; written = 0; skipped = 0;
  private failed = false;
  constructor(private obs: Observer, private budget: number) {}
  onEvent(e: Observation) {
    if (this.failed) return;
    try {
      if (!this.stream) {
        const dir = sessionDir(this.obs);
        mkdirSync(dir, { recursive: true }); // once: the directory must exist before the first append
        this.stream = createWriteStream(path.join(dir, 'observations.jsonl'), { flags: 'a' });
        this.stream.on('error', () => { this.failed = true; });
      }
      const l = line(e);
      if (this.bytes + l.length > this.budget) { this.skipped++; return; }
      this.stream.write(l); this.bytes += l.length; this.written++;
    } catch { this.failed = true; }
  }
  async close() { const s = this.stream; if (s) await new Promise<void>((r) => s.end(() => r())); this.stream = undefined; }
}
export const streams = new WeakMap<Observer, BundleStream>();

function counts(obs: Observer) {
  const by = (pred: (f: Finding) => boolean) => obs.quality.findings.filter(pred).length;
  const bySeverity: Record<string, number> = {}; const byRule: Record<string, number> = {};
  for (const s of SEVERITIES) bySeverity[s] = by((f) => f.status === 'candidate' && f.severity === s);
  for (const f of obs.quality.findings) if (f.status === 'candidate') byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  return { candidates: by((f) => f.status === 'candidate'), expected: by((f) => f.status === 'expected'), suppressed: by((f) => f.status === 'suppressed'), bySeverity, byRule };
}

/** The canonical summary of a session. Counts describe what was observed, never the coverage of the product. */
export function summaryOf(obs: Observer, extra: BundleExtra = {}, files: Record<string, unknown> = {}) {
  const cov = obs.coverage();
  const batches = obs.actions.batches;
  const pol = extra.policy ?? (() => { const p = obs.quality.policy({ pending: cov.pending, dropped: cov.dropped, final: true }); return { outcome: p.outcome, reasons: p.reasons }; })();
  return {
    schemaVersion: 1,
    sessionId: obs.sessionId, runId: obs.runId,
    startedAt: obs.startedAt.toISOString(), endedAt: (obs.endedAt ?? new Date()).toISOString(),
    environment: { platform: `${process.platform} ${process.arch}`, node: process.version, ...extra.environment },
    policy: describeConfig(obs.cfg),
    outcomes: {
      execution: extra.execution ?? { status: batches.every((b) => b.ok !== false) ? 'passed' : 'failed' },
      batches: batches.length, actions: obs.actions.actions.length, failedActions: obs.actions.actions.filter((a) => a.ok === false).length,
      policy: pol,
    },
    quality: counts(obs),
    coverage: {
      state: cov.state, pendingRequests: cov.pending, droppedEvents: cov.dropped, retainedEvents: obs.store.size,
      requests: obs.stats.tracked, firstPartyRequests: obs.stats.firstParty, thirdPartyRequests: obs.stats.thirdParty,
      payloads: { capture: obs.cfg.capture.payloads, captured: obs.stats.bodiesCaptured, skipped: obs.stats.bodiesSkipped },
      rulesNotEvaluated: [...obs.quality.notEvaluated].map(([id, v]) => ({ id, reason: v.reason, count: v.count })),
      note: 'Observed browser activity of this session only. Backend-only traffic, service workers and WebSockets are not covered. This is not a coverage measure of the product.',
    },
    reproduction: { status: 'not attempted', flow: extra.flow ? `flows/${extra.flow}.json` : undefined },
    artifacts: { ...files, reports: extra.reports, screenshot: extra.screenshot },
  };
}

const networkOf = (obs: Observer, f: Finding) => f.requestIds.map((id) => obs.requests.get(id)).filter((r): r is RequestRecord => !!r).map((r) => ({
  id: r.id, method: r.method, url: r.url, status: r.status, failure: r.failure, resourceType: r.resourceType, contentType: r.contentType,
  durationMs: r.endedMs !== undefined ? Math.round(r.endedMs - r.startedMs) : undefined, traceId: r.traceId, pageId: r.pageId,
  association: r.association, redirectedFrom: r.redirectedFrom, redirectedTo: r.redirectedTo, body: r.body, requestShape: r.requestShape,
}));

/** Candidate bug report. Every value that came from the app under test is escaped: it is data, not markup. */
export function bugMarkdown(obs: Observer, f: Finding, extra: BundleExtra = {}): string {
  const acts = obs.actions.actions;
  const upTo = f.association.actionId ?? f.association.candidateActionIds?.[0];
  const idx = upTo ? acts.findIndex((a) => a.actionId === upTo) : -1;
  const steps = (idx >= 0 ? acts.slice(Math.max(0, idx - 14), idx + 1) : acts.slice(-10));
  const reqs = networkOf(obs, f);
  const events = f.evidenceIds.map((id) => { const e = obs.store.get(id); return e ? `${id} ${e.kind} ${md(JSON.stringify(e.data).slice(0, 240))}` : `${id} (${obs.store.availability(id) === 'evicted' ? 'evicted: over the retention budget' : 'not retained'})`; });
  const env = { ...extra.environment };
  return [
    `# [Candidate] ${md(f.title)}`,
    '',
    '> Generated by fastqa from observations. This is a lead to verify, not a confirmed defect.',
    '',
    `- Environment/build/browser: ${md(Object.entries(env).map(([k, v]) => `${k} ${v}`).join(', ') || 'unknown')} · ${process.platform} · origins ${md([...obs.firstParty].join(', ') || 'unknown')}`,
    '- Preconditions / test data placeholders: unknown (values typed through {{placeholders}} are not recorded)',
    '- Minimal observed reproduction steps (as executed; not minimized):',
    ...steps.map((a, i) => `  ${i + 1}. ${md(a.label)}${a.ok === false ? ' — failed' : ''}${a.actionId === upTo ? '  ← associated action' : ''}`),
    `- Expected: ${md(f.expected ?? 'unknown')}`,
    `- Actual: ${md(f.actual)}`,
    `- UI outcome / assertion result: ${acts.some((a) => a.ok === false) ? 'at least one step failed in this session' : 'all executed steps and explicit assertions passed'}`,
    '- Network / JS evidence:',
    ...reqs.map((r) => `  - ${r.id} ${md(`${r.method} ${r.url}`)} → ${r.failure ? md(r.failure) : r.status ?? 'pending'}${r.durationMs !== undefined ? ` · ${r.durationMs}ms` : ''}${r.traceId ? ` · trace ${md(r.traceId)}` : ''}${r.body ? ` · body ${r.body.state}${r.body.reason ? ` (${r.body.reason})` : ''}` : ''}`),
    ...events.map((e) => `  - ${e}`),
    `- Severity estimate / confidence / correlation rationale: ${f.severity} / ${f.confidence} / ${md(obs.actions.describe(f.association))} — ${md(f.association.reason)}`,
    `- Occurrences in this session: ${f.occurrences}${f.late ? ' (surfaced after its batch had returned)' : ''}`,
    '- Reproduction status: not attempted',
    `- Known issue / suppression: ${f.status === 'suppressed' ? md(f.statusReason) : f.status === 'expected' ? `declared expected — ${md(f.statusReason)}` : 'none'}`,
    `- Limitations and next investigation: association is temporal, not proof of cause. ${f.confidence === 'low' ? 'Low confidence: the request may be background traffic. ' : ''}Check server logs${reqs.find((r) => r.traceId) ? ' with the trace id above' : ''}, confirm the business expectation, and replay only if the steps are safe to repeat.`,
    `- Rule: ${f.ruleId} v${f.ruleVersion} · finding ${f.id} · session ${obs.sessionId} · run ${obs.runId}`,
    '',
  ].join('\n');
}

export async function writeBugDraft(obs: Observer, findingId: string, extra: BundleExtra = {}): Promise<{ file: string; markdown: string } | undefined> {
  if (!FINDING_ID.test(findingId)) return undefined;
  const f = obs.quality.findings.find((x) => x.id === findingId);
  if (!f) return undefined;
  const dir = path.join(sessionDir(obs), 'evidence', f.id);
  const markdown = redactor.text(bugMarkdown(obs, f, extra));
  await writeAtomic(path.join(dir, 'finding.md'), markdown);
  await writeAtomic(path.join(dir, 'network.json'), redactor.text(JSON.stringify({ schemaVersion: 1, finding: f.id, requests: networkOf(obs, f) }, null, 2)) + '\n');
  return { file: path.join(dir, 'finding.md'), markdown };
}

/** Writes the whole bundle for a session and returns its directory. Safe to call more than once: files are replaced atomically. */
export async function writeBundle(obs: Observer, extra: BundleExtra = {}): Promise<string> {
  if (!RUN_ID.test(obs.runId)) throw new Error('unexpected run id');
  const dir = sessionDir(obs);
  await fs.mkdir(dir, { recursive: true });
  const cfg = obs.cfg;
  const budget = cfg.artifacts.maxBytesPerRun;
  const truncation: string[] = [];
  const stream = streams.get(obs);
  let obsBytes = 0; let obsLines = 0;
  if (stream) {
    await stream.close();
    obsBytes = stream.bytes; obsLines = stream.written;
    if (stream.skipped) truncation.push(`observations.jsonl: ${stream.skipped} events not written (artifacts.maxBytesPerRun)`);
  } else {
    const out: string[] = [];
    for (const e of obs.store.all()) {
      const l = line(e);
      if (obsBytes + l.length > budget * 0.8) { truncation.push(`observations.jsonl: stopped at ${obsLines} events (artifacts.maxBytesPerRun)`); break; }
      out.push(l); obsBytes += l.length; obsLines++;
    }
    await writeAtomic(path.join(dir, 'observations.jsonl'), out.join(''));
  }
  if (obs.store.dropped) truncation.push(`${obs.store.dropped} older events were evicted from memory before export (capture.maxEvents / capture.maxBytes)`);
  const batches = new Map(obs.actions.batches.map((b) => [b.batchId, b]));
  await writeAtomic(path.join(dir, 'actions.jsonl'), obs.actions.actions.map((a) => line({
    actionId: a.actionId, batchId: a.batchId, batchKind: batches.get(a.batchId)?.kind, scope: batches.get(a.batchId)?.scope, index: a.index, do: a.do, label: a.label,
    ok: a.ok, pageId: a.pageId, startedMs: Math.round(a.startedMs), endedMs: a.endedMs === undefined ? undefined : Math.round(a.endedMs), requests: a.requests,
  })).join(''));
  await writeAtomic(path.join(dir, 'findings.json'), redactor.text(JSON.stringify({ schemaVersion: 1, sessionId: obs.sessionId, runId: obs.runId, note: 'Candidates are leads to verify, not confirmed defects.', findings: obs.quality.findings }, null, 2)) + '\n');
  const files: Record<string, unknown> = { actions: 'actions.jsonl', observations: 'observations.jsonl', findings: 'findings.json', observationEvents: obsLines, bytes: obsBytes };
  if (extra.discovery) {
    await writeAtomic(path.join(dir, 'discovery', 'endpoints.json'), redactor.text(JSON.stringify(extra.discovery.endpoints, null, 2)) + '\n');
    await writeAtomic(path.join(dir, 'discovery', 'journeys.json'), redactor.text(JSON.stringify(extra.discovery.journeys, null, 2)) + '\n');
    files.discovery = ['discovery/endpoints.json', 'discovery/journeys.json'];
  }
  const drafts: string[] = [];
  for (const f of obs.quality.findings.filter((x) => x.status === 'candidate').slice(0, 25)) {
    const d = await writeBugDraft(obs, f.id, extra);
    if (d) drafts.push(`evidence/${f.id}/finding.md`);
  }
  files.bugDrafts = drafts; files.truncation = truncation;
  // the manifest goes last and atomically: its presence means the bundle is complete
  await writeAtomic(path.join(dir, 'summary.json'), redactor.text(JSON.stringify(summaryOf(obs, extra, files), null, 2)) + '\n');
  await cleanupSessions(cfg, obs.runId).catch(() => {});
  return dir;
}

/**
 * Retention for .fastqa/sessions: keeps the newest artifacts.maxRuns bundles, removes bundles older than
 * artifacts.retentionDays and interrupted ones (no summary.json) older than a day. Only real directories whose
 * name is a fastqa run id are ever removed; flows, reports and anything else are never touched.
 */
export async function cleanupSessions(cfg: Config, keep?: string): Promise<string[]> {
  const root = sessionsDir();
  let names: string[];
  try { names = await fs.readdir(root); } catch { return []; }
  const runs: Array<{ name: string; ms: number; complete: boolean }> = [];
  for (const name of names) {
    if (!RUN_ID.test(name)) continue;
    const st = await fs.lstat(path.join(root, name)).catch(() => undefined);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
    const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/.exec(name)!;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const complete = await fs.access(path.join(root, name, 'summary.json')).then(() => true, () => false);
    runs.push({ name, ms, complete });
  }
  runs.sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first: run ids sort by time
  const now = Date.now(); const day = 86_400_000;
  const removed: string[] = [];
  let kept = 0;
  for (const r of runs) {
    const expired = now - r.ms > cfg.artifacts.retentionDays * day;
    const stale = !r.complete && now - r.ms > day;
    if (r.name !== keep && (expired || stale || (r.complete && kept >= cfg.artifacts.maxRuns))) {
      await fs.rm(path.join(root, r.name), { recursive: true, force: true }).catch(() => {});
      removed.push(r.name);
    } else if (r.complete || r.name === keep) kept++;
  }
  return removed;
}

export const relBundle = (dir: string) => rel(dir);
