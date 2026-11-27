// One Observer per browser context (= one session). It turns Playwright events into sanitized, bounded observations,
// keeps each request's lifecycle, and feeds the quality engine. It never blocks an action: capture failures are recorded, not thrown.
import { randomBytes } from 'node:crypto';
import type { ConsoleMessage, Frame, Page, Request, Response } from 'playwright';
import type { Config } from '../config.js';
import { ActionTracker } from '../correlation/actions.js';
import { Redactor } from '../privacy/redact.js';
import { QualityEngine } from '../quality/engine.js';
import { endpointMatches, normalizePath, shapeOf } from '../util/paths.js';
import { EventStore } from './store.js';
import type { Association, Observation, ObservationKind, RequestRecord } from './types.js';

const TRACKED = new Set(['fetch', 'xhr', 'document']);
const TRACE_HEADERS = ['x-request-id', 'x-correlation-id', 'x-trace-id', 'traceparent', 'x-amzn-trace-id', 'request-id'];
/** Endpoints whose payloads are never captured unless they are listed explicitly in capture.allowedEndpoints. */
const SENSITIVE_PATH = /login|logout|signin|sign-in|auth|oauth|token|password|passwd|session|secret|payment|checkout\/pay|card|billing|2fa|otp|mfa/i;
const MAX_REQUESTS = 3000;
const BODY_TIMEOUT_MS = 5000;

export interface ObserverSink { onEvent?(e: Observation): void; onRequestDone?(r: RequestRecord): void }

export class Observer {
  readonly sessionId = `S-${randomBytes(4).toString('hex')}`;
  readonly runId: string;
  readonly startedAt = new Date();
  private t0 = performance.now();
  readonly store: EventStore;
  readonly actions: ActionTracker;
  readonly quality: QualityEngine;
  readonly requests = new Map<string, RequestRecord>();
  private byReq = new WeakMap<Request, RequestRecord & { held?: boolean }>();
  private pageIds = new WeakMap<Page, string>();
  private frameIds = new WeakMap<Frame, string>();
  private lastNav = new Map<string, number>();
  private nReq = 0; private nPage = 0; private nFrame = 0;
  /** tracked first-party requests without a response yet */
  readonly pending = new Set<RequestRecord>();
  bodyReaders = 0;
  private capturedBytes = 0;
  readonly firstParty = new Set<string>();
  readonly stats = { requests: 0, tracked: 0, firstParty: 0, thirdParty: 0, bodiesCaptured: 0, bodiesSkipped: 0, consoleErrors: 0, pageErrors: 0 };
  readonly sinks: ObserverSink[] = [];
  /** what is known about the environment (fastqa version, browser, device); goes into summaries and bug drafts */
  readonly environment: Record<string, unknown> = {};
  disposed = false;
  endedAt?: Date;

  constructor(readonly cfg: Config, readonly redactor: Redactor) {
    this.runId = `${this.startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}-${this.sessionId.slice(2)}`;
    this.store = new EventStore(cfg.capture.maxEvents, cfg.capture.maxBytes);
    this.actions = new ActionTracker(cfg.postActionWindowMs, this.now);
    this.quality = new QualityEngine(cfg, {
      scopeOf: (b) => this.actions.scopeOf(b),
      currentBatchId: () => this.actions.currentBatch?.batchId,
      describeAction: (a) => this.actions.describe(a),
    });
    for (const o of cfg.firstPartyOrigins) this.firstParty.add(o);
  }

  now = () => performance.now() - this.t0;

  /** The origins the agent explicitly opened are first party; everything else is not flagged by default. */
  noteFirstParty(url: string) { try { const o = new URL(url).origin; if (o !== 'null') this.firstParty.add(o); } catch { /* not a URL */ } }

  pageId(page: Page): string {
    let id = this.pageIds.get(page);
    if (!id) { id = `P-${++this.nPage}`; this.pageIds.set(page, id); }
    return id;
  }
  private frameId(page: Page, frame: Frame | null): string | undefined {
    if (!frame || frame === page.mainFrame()) return undefined;
    let id = this.frameIds.get(frame);
    if (!id) { id = `FR-${++this.nFrame}`; this.frameIds.set(frame, id); }
    return id;
  }

  emit(kind: ObservationKind, data: Record<string, unknown>, action: Association, o: { pageId?: string; frameId?: string; batchId?: string } = {}): Observation {
    const batchId = o.batchId ?? this.actions.get(action.actionId)?.batchId ?? this.actions.currentBatch?.batchId;
    const ev = this.store.add({ sessionId: this.sessionId, batchId, pageId: o.pageId, frameId: o.frameId, action, at: new Date().toISOString(), elapsedMs: Math.round(this.now()), kind, data });
    for (const s of this.sinks) try { s.onEvent?.(ev); } catch { /* a sink must never break observation */ }
    return ev;
  }

  // ------------------------------------------------------------------ network

  onRequest(page: Page, req: Request): RequestRecord | undefined {
    if (this.disposed) return;
    const rawUrl = req.url();
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return;
    let origin = ''; let pathname = '';
    try { const u = new URL(rawUrl); origin = u.origin; pathname = u.pathname; } catch { return; }
    const resourceType = req.resourceType();
    const tracked = TRACKED.has(resourceType);
    const firstParty = this.firstParty.has(origin);
    let frame: Frame | null = null;
    try { frame = req.frame(); } catch { /* service worker or detached */ }
    const route = normalizePath(pathname, this.cfg.discovery.pathTemplates);
    const method = req.method();
    const from = req.redirectedFrom();
    const prev = from ? this.byReq.get(from) : undefined;
    const navigation = req.isNavigationRequest();
    const association: Association = prev
      ? { ...prev.association, reason: `redirect of ${prev.id}` }
      : tracked
        ? this.actions.associate({ endpointKey: `${method} ${origin}${route}`, mainFrameNavigation: navigation && !!frame && frame === page.mainFrame() })
        : this.actions.associateMoment();
    const pageId = this.pageId(page);
    const rec: RequestRecord & { held?: boolean } = {
      id: `R-${++this.nReq}`, method, url: this.redactor.networkUrl(rawUrl), origin, path: this.redactor.text(pathname), route: this.redactor.text(route),
      resourceType, firstParty, tracked, navigation, pageId, frameId: this.frameId(page, frame),
      batchId: this.actions.get(association.actionId)?.batchId ?? this.actions.currentBatch?.batchId,
      association, startedMs: this.now(), redirectedFrom: prev?.id, eventIds: [], done: false,
    };
    if (prev) prev.redirectedTo = rec.id;
    this.byReq.set(req, rec); this.requests.set(rec.id, rec);
    if (this.requests.size > MAX_REQUESTS) this.trimRequests();
    this.stats.requests++; if (firstParty) this.stats.firstParty++; else this.stats.thirdParty++;
    if (tracked) {
      this.stats.tracked++;
      rec.held = this.actions.hold(association);
      if (firstParty) this.pending.add(rec);
      const ev = this.emit('request', { requestId: rec.id, method, url: rec.url, resourceType, firstParty, navigation: navigation || undefined, redirectedFrom: prev?.id }, association, rec);
      rec.eventIds.push(ev.eventId);
      if (this.captureAllowed(rec) === true) {
        try {
          const body = req.postData();
          if (body && body.length <= this.cfg.capture.maxBodyBytes && /json/i.test(req.headers()['content-type'] ?? '')) rec.requestShape = shapeOf(JSON.parse(body));
        } catch { /* not JSON: no shape */ }
      }
      this.quality.onRequestStart(rec);
    }
    return rec;
  }

  onResponse(page: Page, res: Response): RequestRecord | undefined {
    const rec = this.byReq.get(res.request());
    if (!rec || this.disposed) return rec;
    rec.status = res.status(); rec.responseMs = this.now();
    const h = res.headers();
    rec.contentType = h['content-type']?.split(';')[0].trim();
    for (const name of TRACE_HEADERS) if (h[name]) { rec.traceId = this.redactor.text(h[name]).slice(0, 80); break; }
    this.settle(rec);
    if (rec.tracked || rec.status >= 400) {
      const ev = this.emit('response', {
        requestId: rec.id, method: rec.method, url: rec.url, status: rec.status, resourceType: rec.resourceType, firstParty: rec.firstParty,
        contentType: rec.contentType, ttfbMs: Math.round(rec.responseMs - rec.startedMs), traceId: rec.traceId, redirectedFrom: rec.redirectedFrom,
      }, rec.association, rec);
      rec.eventIds.push(ev.eventId);
      this.quality.onResponse(rec, ev);
    }
    this.captureBody(rec, res, h);
    return rec;
  }

  onFinished(req: Request) {
    const rec = this.byReq.get(req);
    if (!rec || this.disposed || rec.endedMs !== undefined) return;
    rec.endedMs = this.now(); this.settle(rec);
    if (rec.tracked) {
      const ev = this.emit('request_finished', { requestId: rec.id, method: rec.method, url: rec.url, status: rec.status, durationMs: Math.round(rec.endedMs - rec.startedMs) }, rec.association, rec);
      rec.eventIds.push(ev.eventId);
      this.quality.onFinished(rec, ev);
    }
    this.finish(rec);
  }

  onFailed(page: Page, req: Request): RequestRecord | undefined {
    const rec = this.byReq.get(req);
    if (!rec || this.disposed) return rec;
    rec.failure = req.failure()?.errorText ?? 'failed'; rec.endedMs = this.now();
    rec.aborted = /ERR_ABORTED/.test(rec.failure);
    this.settle(rec);
    // An abort is only called "navigation noise" when there is evidence: the page navigated or closed after the request started.
    const navigated = (this.lastNav.get(rec.pageId ?? '') ?? -1) >= rec.startedMs || page.isClosed();
    const ev = this.emit('request_failed', { requestId: rec.id, method: rec.method, url: rec.url, errorText: rec.failure, aborted: rec.aborted || undefined, navigationEvidence: rec.aborted ? navigated : undefined, status: rec.status }, rec.association, rec);
    rec.eventIds.push(ev.eventId);
    this.quality.onFailed(rec, ev);
    this.finish(rec);
    return rec;
  }

  private settle(rec: RequestRecord & { held?: boolean }) {
    if (rec.held) { this.actions.release(rec.association); rec.held = false; }
    this.pending.delete(rec);
  }
  private finish(rec: RequestRecord) {
    if (rec.body?.state === 'pending') return; // completed when the body reader settles
    rec.done = true;
    for (const s of this.sinks) try { s.onRequestDone?.(rec); } catch { /* ignore */ }
  }
  private trimRequests() {
    let n = 500;
    for (const [id, r] of this.requests) { if (n <= 0) break; if (r.done) { this.requests.delete(id); n--; } }
  }

  // ------------------------------------------------------------------ payload capture (opt-in, scoped, bounded)

  /** true = allowed; otherwise the reason it is not. Payloads are captured only for allowlisted first-party JSON endpoints. */
  captureAllowed(rec: RequestRecord): true | string {
    const c = this.cfg.capture;
    if (c.payloads !== 'json') return 'capture-off';
    if (!c.allowedOrigins.includes(rec.origin)) return 'origin-not-allowed';
    const listed = c.allowedEndpoints.some((e) => endpointMatches(e, rec.method, rec.path));
    if (c.allowedEndpoints.length && !listed) return 'endpoint-not-allowed';
    if (!listed && SENSITIVE_PATH.test(rec.path)) return 'sensitive-endpoint';
    return true;
  }

  private captureBody(rec: RequestRecord, res: Response, h: Record<string, string>) {
    if (!rec.tracked || rec.resourceType === 'document' || rec.status === undefined || (rec.status >= 300 && rec.status < 400)) return;
    const wants = this.quality.wantsBody(rec);
    const skip = (reason: string) => { rec.body = { state: 'skipped', reason }; this.stats.bodiesSkipped++; this.quality.onBody(rec); };
    const allowed = this.captureAllowed(rec);
    if (allowed !== true) { if (wants) skip(allowed); return; }
    if (!/json/i.test(rec.contentType ?? '')) return skip('not-json');
    const c = this.cfg.capture;
    const len = h['content-length'] === undefined ? NaN : Number(h['content-length']);
    // Playwright cannot stream a body: an unknown size is skipped unless explicitly allowed, so nothing unbounded is buffered by default.
    if (Number.isNaN(len)) { if (!c.allowUnknownLength) return skip('unknown-size'); }
    else if (len > c.maxBodyBytes) return skip('oversized');
    if (this.bodyReaders >= c.maxBodyReaders) return skip('reader-limit');
    if (this.capturedBytes >= c.maxBytes / 2) return skip('capture-budget');
    rec.body = { state: 'pending' }; this.bodyReaders++;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), BODY_TIMEOUT_MS); });
    let raw: unknown;
    Promise.race([res.body(), timeout]).then((buf) => {
      if (buf.length > c.maxBodyBytes) { rec.body = { state: 'skipped', reason: 'oversized', bytes: buf.length }; this.stats.bodiesSkipped++; return; }
      raw = JSON.parse(buf.toString('utf8'));
      // Only the sanitized copy is retained; the raw value is handed to the rules once and then dropped.
      rec.body = { state: 'captured', bytes: buf.length, json: this.redactor.json(raw) };
      this.capturedBytes += buf.length; this.stats.bodiesCaptured++;
    }).catch((e) => {
      rec.body = { state: 'failed', reason: /timeout/.test(String(e)) ? 'read-timeout' : 'read-error' };
    }).finally(() => {
      clearTimeout(timer); this.bodyReaders--;
      if (!this.disposed) this.quality.onBody(rec, raw);
      if (rec.endedMs !== undefined) this.finish(rec);
    });
  }

  // ------------------------------------------------------------------ page signals

  onConsole(page: Page, m: ConsoleMessage) {
    if (this.disposed || m.type() !== 'error') return;
    this.stats.consoleErrors++;
    const loc = m.location();
    const ev = this.emit('console_error', { text: this.redactor.text(m.text()).slice(0, 500), source: loc?.url ? `${this.redactor.networkUrl(loc.url)}:${loc.lineNumber}` : undefined }, this.actions.associateMoment(), { pageId: this.pageId(page) });
    this.quality.onConsoleError(ev);
  }

  onPageError(page: Page, e: Error) {
    if (this.disposed) return;
    this.stats.pageErrors++;
    const stack = String(e?.stack ?? '').split('\n').slice(1, 4).map((l) => this.redactor.text(l.trim()).slice(0, 200));
    const ev = this.emit('page_error', { message: this.redactor.text(String(e?.message || e)).slice(0, 500), stack: stack.length ? stack : undefined }, this.actions.associateMoment(), { pageId: this.pageId(page) });
    this.quality.onPageError(ev);
  }

  onNavigated(page: Page, frame: Frame) {
    if (this.disposed || frame !== page.mainFrame()) return;
    const pageId = this.pageId(page);
    this.lastNav.set(pageId, this.now());
    const cur = this.actions.current;
    // the navigation a goto asked for is a known link, everything else is temporal
    const assoc: Association = cur?.do === 'goto' ? { actionId: cur.actionId, confidence: 'direct', reason: 'navigation requested by the action' } : this.actions.associateMoment();
    this.emit('state_change', { type: 'navigation', url: this.redactor.pageUrl(frame.url()) }, assoc, { pageId });
  }

  onPage(page: Page, type: 'page_opened' | 'page_closed') {
    if (this.disposed) return;
    this.emit('state_change', { type, url: type === 'page_opened' ? undefined : this.redactor.pageUrl(page.url()) }, this.actions.associateMoment(), { pageId: this.pageId(page) });
  }

  // ------------------------------------------------------------------ coverage and finalization

  private finalCoverage?: ReturnType<Observer['coverage']>;
  coverage(): { pending: number; dropped: number; state: 'disabled' | 'partial' | 'complete' } {
    if (this.finalCoverage) return this.finalCoverage;
    const pending = this.pending.size + this.bodyReaders;
    return { pending, dropped: this.store.dropped, state: (this.cfg.mode === 'off' ? 'disabled' : pending || this.store.dropped ? 'partial' : 'complete') as 'disabled' | 'partial' | 'complete' };
  }

  /**
   * Bounded drain of the requests that are pending right now (later traffic, e.g. polling, is not waited for).
   * Never an unbounded network-idle wait: it returns at the deadline and reports what was still open.
   */
  async drain(timeoutMs: number): Promise<{ pending: RequestRecord[] }> {
    const waiting = [...this.pending];
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && (waiting.some((r) => this.pending.has(r)) || this.bodyReaders > 0)) await new Promise((r) => setTimeout(r, 25));
    return { pending: waiting.filter((r) => this.pending.has(r)) };
  }

  dispose() {
    if (this.disposed) return;
    this.finalCoverage = this.coverage(); // what was still open when the session ended stays visible afterwards
    this.disposed = true; this.endedAt = new Date();
    this.pending.clear();
  }
}
