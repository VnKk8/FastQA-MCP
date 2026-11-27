// Observed product graph (opt-in "discovery"): which routes were visited, which actions were performed there and
// which first-party API endpoints they were seen to call. Built only from what the browser showed in this session.
// It never crawls, never infers backend ownership or business rules, and never claims coverage of unseen functionality.
// Only names, shapes and counts are kept: no query values, no body values.
import type { ObserverSink } from '../observation/observer.js';
import type { AssocConfidence, Observation, RequestRecord } from '../observation/types.js';
import { normalizePath, shapeOf } from '../util/paths.js';

export const DISCOVERY_CAPS = { routes: 500, endpoints: 2000, actions: 2000, edges: 5000, batches: 200, stepsPerBatch: 100 };
const LIMITS_NOTE = 'Observed browser activity only: routes, actions and first-party API calls seen in the listed session(s). ' +
  'Not a coverage measure. Backend-only traffic, unvisited pages, service ownership and business rules are not represented.';
const JOURNEY_NOTE = 'Only actions with an observed navigation or first-party request appear. Order is the order in which they were first observed.';
const MAX_SAMPLES = 3;
const MAX_TRACKED_ACTIONS = 5000;

export interface RouteNode { id: string; origin: string; path: string; count: number; firstSeen: string; lastSeen: string; evidenceIds: string[] }
export interface EndpointNode {
  id: string; method: string; origin: string; path: string;
  statuses: number[]; contentTypes: string[];
  count: number;
  /** calls that no action could be tied to (unattributed or ambiguous): background or page-initiated traffic */
  background: number;
  /** transport failures (not aborts) */
  failed: number;
  firstSeen: string; lastSeen: string; evidenceIds: string[];
  /** field names and types only; present only when payload capture was allowed for this endpoint */
  requestShape?: unknown;
  /** by status code; field names and types only */
  responseShapes?: Record<string, unknown>;
}
export interface ActionNode {
  id: string;
  /** id of the route the action was performed on, when known */
  route?: string;
  label: string; kind: string;
  /** agent-supplied batch labels (act scope, flow name) under which this action was seen */
  scopes: string[];
  count: number;
}
export interface DiscoveryEdge {
  from: string; to: string;
  relation: 'navigation' | 'observed_request' | 'triggers';
  /** the weakest association confidence seen for this edge: it never overstates */
  confidence: AssocConfidence;
  byConfidence: Partial<Record<AssocConfidence, number>>;
  count: number;
  evidenceIds: string[];
  /** navigation only: ids of the actions that preceded it */
  via?: string[];
}
export interface DiscoveryExport {
  schemaVersion: 1;
  kind: 'fastqa-discovery';
  sessions: string[];
  generatedAt: string;
  limits: string;
  routes: RouteNode[];
  endpoints: EndpointNode[];
  actions: ActionNode[];
  edges: DiscoveryEdge[];
  /** requests to other origins, of any type; counted, never listed */
  thirdPartyRequests: number;
  truncated: boolean;
  dropped: { routes: number; endpoints: number; actions: number; edges: number };
}
export interface JourneyStep {
  action: string; kind: string;
  routeBefore?: string; routeAfter?: string;
  routeBeforeId?: string; routeAfterId?: string;
  /** "METHOD /path" of the endpoints this action was seen to trigger */
  endpoints: string[];
  endpointIds: string[];
}
export interface JourneyExport {
  schemaVersion: 1;
  kind: 'fastqa-journeys';
  sessionId: string;
  generatedAt: string;
  note: string;
  journeys: Array<{ batchId: string; kind?: string; scope?: string; steps: JourneyStep[] }>;
  truncated: boolean;
}

export interface DiscoveryOptions {
  sessionId: string;
  pathTemplates?: string[];
  describeAction: (actionId: string) => { label: string; kind: string } | undefined;
  scopeOf: (batchId?: string) => string | undefined;
  /** optional: 'open' | 'act' | 'flow' for a batch id, used in journeys */
  batchKind?: (batchId?: string) => string | undefined;
  /** optional clock (ISO string), for deterministic tests */
  now?: () => string;
}

const RANK: Record<AssocConfidence, number> = { direct: 3, inferred: 2, ambiguous: 1, unattributed: 0 };
const weakest = (a: AssocConfidence, b: AssocConfidence): AssocConfidence => (RANK[a] <= RANK[b] ? a : b);
const attributed = (c: AssocConfidence) => c === 'direct' || c === 'inferred';
const addSample = (list: string[], id?: string) => { if (id && list.length < MAX_SAMPLES && !list.includes(id)) list.push(id); };
const addTo = <T>(list: T[], v: T, max: number) => { if (!list.includes(v) && list.length < max) list.push(v); };
/** Action labels can quote a URL (goto "…"): the query string and fragment are dropped, values never enter the graph. */
const cleanLabel = (s: string) => s.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/g, '$1').slice(0, 160);

interface StepState { actionId: string; node?: string; step: JourneyStep }
interface BatchState { batchId: string; kind?: string; scope?: string; steps: Map<string, StepState> }

export class DiscoveryGraph implements ObserverSink {
  private routes = new Map<string, RouteNode>();
  private endpoints = new Map<string, EndpointNode>();
  private actions = new Map<string, ActionNode>();
  private edges = new Map<string, DiscoveryEdge>();
  private nRoute = 0; private nEndpoint = 0; private nAction = 0;
  /** page id -> key of the route that page is on */
  private pageRoute = new Map<string, string>();
  /** action id -> its node key and batch, so one execution is counted once */
  private seenActions = new Map<string, { key?: string; batchId?: string }>();
  private batches = new Map<string, BatchState>();
  private thirdParty = 0;
  private dropped = { routes: 0, endpoints: 0, actions: 0, edges: 0 };
  private journeysTruncated = false;
  private readonly templates: string[];
  private readonly now: () => string;

  constructor(private o: DiscoveryOptions) {
    this.templates = o.pathTemplates ?? [];
    this.now = o.now ?? (() => new Date().toISOString());
  }

  // ------------------------------------------------------------------ sink

  onEvent(e: Observation): void {
    const d = e.data as Record<string, unknown>;
    if (e.kind === 'state_change') {
      if (d.type === 'page_closed' && e.pageId) { this.pageRoute.delete(e.pageId); return; }
      if (d.type !== 'navigation' || typeof d.url !== 'string') return;
      let origin = ''; let pathname = '';
      try { const u = new URL(d.url); origin = u.origin; pathname = u.pathname; } catch { return; }
      if (!/^https?:/.test(origin)) return;
      const pageId = e.pageId ?? 'P-?';
      const prevKey = this.pageRoute.get(pageId);
      // the action is registered against the route the page was on before this navigation
      const st = attributed(e.action.confidence) ? this.touchAction(e.action.actionId, e.batchId, prevKey) : undefined;
      const at = e.at || this.now();
      const key = `${origin}${normalizePath(pathname, this.templates)}`;
      let r = this.routes.get(key);
      if (!r) {
        if (this.routes.size >= DISCOVERY_CAPS.routes) { this.dropped.routes++; return; }
        r = { id: `R${++this.nRoute}`, origin, path: key.slice(origin.length), count: 0, firstSeen: at, lastSeen: at, evidenceIds: [] };
        this.routes.set(key, r);
      }
      r.count++; r.lastSeen = at; addSample(r.evidenceIds, e.eventId);
      if (this.pageRoute.size < 200 || this.pageRoute.has(pageId)) this.pageRoute.set(pageId, key);
      if (st) { st.step.routeAfter = r.path; st.step.routeAfterId = r.id; }
      const prev = prevKey ? this.routes.get(prevKey) : undefined;
      if (prev && prev !== r) {
        const edge = this.edge('navigation', prev.id, r.id, e.action.confidence, e.eventId);
        const via = st?.node ? this.actions.get(st.node)?.id : undefined;
        if (edge && via) { edge.via ??= []; addTo(edge.via, via, MAX_SAMPLES); }
      }
      return;
    }
    // any other event tied to one action: remember which route that action was performed on (first sight wins)
    if (attributed(e.action.confidence) && e.action.actionId) this.touchAction(e.action.actionId, e.batchId, e.pageId ? this.pageRoute.get(e.pageId) : undefined);
  }

  onRequestDone(rec: RequestRecord): void {
    if (!rec.firstParty) { this.thirdParty++; return; }
    if (!rec.tracked || rec.resourceType === 'document') return; // pages and static resources are not API endpoints
    const at = this.now();
    const path = normalizePath(rec.route || rec.path, this.templates);
    const key = `${rec.method} ${rec.origin}${path}`;
    let ep = this.endpoints.get(key);
    if (!ep) {
      if (this.endpoints.size >= DISCOVERY_CAPS.endpoints) { this.dropped.endpoints++; return; }
      ep = { id: `EP${++this.nEndpoint}`, method: rec.method, origin: rec.origin, path, statuses: [], contentTypes: [], count: 0, background: 0, failed: 0, firstSeen: at, lastSeen: at, evidenceIds: [] };
      this.endpoints.set(key, ep);
    }
    ep.count++; ep.lastSeen = at;
    if (rec.status !== undefined && !ep.statuses.includes(rec.status)) { ep.statuses.push(rec.status); ep.statuses.sort((a, b) => a - b); }
    if (rec.contentType) addTo(ep.contentTypes, rec.contentType, 5);
    if (rec.failure && !rec.aborted) ep.failed++;
    const sample = rec.eventIds[1] ?? rec.eventIds[0];
    addSample(ep.evidenceIds, sample);
    // shapes exist only when payload capture was explicitly allowed for this endpoint; they hold names and types, never values
    if (rec.requestShape !== undefined && ep.requestShape === undefined) ep.requestShape = rec.requestShape;
    if (rec.body?.state === 'captured' && rec.body.json !== undefined && rec.status !== undefined) {
      ep.responseShapes ??= {};
      const k = String(rec.status);
      if (!(k in ep.responseShapes) && Object.keys(ep.responseShapes).length < 5) ep.responseShapes[k] = shapeOf(rec.body.json);
    }
    const conf = rec.association.confidence;
    const routeKey = rec.pageId ? this.pageRoute.get(rec.pageId) : undefined;
    const route = routeKey ? this.routes.get(routeKey) : undefined;
    if (route) this.edge('observed_request', route.id, ep.id, conf, sample);
    if (!attributed(conf) || !rec.association.actionId) { ep.background++; return; } // no action context: background / unknown
    const st = this.touchAction(rec.association.actionId, rec.batchId, routeKey);
    const node = st?.node ? this.actions.get(st.node) : undefined;
    if (!node) return;
    this.edge('triggers', node.id, ep.id, conf, sample);
    const name = `${ep.method} ${ep.path}`;
    if (st && !st.step.endpointIds.includes(ep.id) && st.step.endpointIds.length < 20) { st.step.endpointIds.push(ep.id); st.step.endpoints.push(name); }
  }

  // ------------------------------------------------------------------ internals

  /** Registers one execution of an action (once per action id) and returns its journey step. */
  private touchAction(actionId: string | undefined, batchId: string | undefined, routeKey: string | undefined): StepState | undefined {
    if (!actionId) return undefined;
    let seen = this.seenActions.get(actionId);
    if (!seen) {
      const info = this.o.describeAction(actionId);
      if (!info) return undefined;
      const label = cleanLabel(info.label);
      const route = routeKey ? this.routes.get(routeKey) : undefined;
      // A goto does not depend on the page it starts from, so it is one node wherever it was issued.
      const on = info.kind === 'goto' ? undefined : route;
      const key = `${on ? routeKey : ''}|${label}`;
      let node = this.actions.get(key);
      if (!node) {
        if (this.actions.size >= DISCOVERY_CAPS.actions) this.dropped.actions++;
        else { node = { id: `AC${++this.nAction}`, route: on?.id, label, kind: info.kind, scopes: [], count: 0 }; this.actions.set(key, node); }
      }
      if (node) { node.count++; const scope = this.o.scopeOf(batchId); if (scope) addTo(node.scopes, scope, 5); }
      seen = { key: node ? key : undefined, batchId };
      this.seenActions.set(actionId, seen);
      if (this.seenActions.size > MAX_TRACKED_ACTIONS) this.seenActions.delete(this.seenActions.keys().next().value as string);
      this.journeyStep(actionId, seen, label, info.kind, route);
    }
    const b = seen.batchId ? this.batches.get(seen.batchId) : undefined;
    const st = b?.steps.get(actionId);
    return st ?? (seen.key ? { actionId, node: seen.key, step: { action: '', kind: '', endpoints: [], endpointIds: [] } } : undefined);
  }

  private journeyStep(actionId: string, seen: { key?: string; batchId?: string }, label: string, kind: string, route?: RouteNode) {
    const batchId = seen.batchId;
    if (!batchId) return;
    let b = this.batches.get(batchId);
    if (!b) {
      if (this.batches.size >= DISCOVERY_CAPS.batches) { this.batches.delete(this.batches.keys().next().value as string); this.journeysTruncated = true; }
      b = { batchId, kind: this.o.batchKind?.(batchId), scope: this.o.scopeOf(batchId), steps: new Map() };
      this.batches.set(batchId, b);
    }
    if (b.steps.size >= DISCOVERY_CAPS.stepsPerBatch) { this.journeysTruncated = true; return; }
    b.steps.set(actionId, { actionId, node: seen.key, step: { action: label, kind, routeBefore: route?.path, routeBeforeId: route?.id, routeAfter: route?.path, routeAfterId: route?.id, endpoints: [], endpointIds: [] } });
  }

  private edge(relation: DiscoveryEdge['relation'], from: string, to: string, conf: AssocConfidence, evidenceId?: string): DiscoveryEdge | undefined {
    const key = `${relation}|${from}|${to}`;
    let e = this.edges.get(key);
    if (!e) {
      if (this.edges.size >= DISCOVERY_CAPS.edges) { this.dropped.edges++; return undefined; }
      e = { from, to, relation, confidence: conf, byConfidence: {}, count: 0, evidenceIds: [] };
      this.edges.set(key, e);
    }
    e.count++; e.confidence = weakest(e.confidence, conf);
    e.byConfidence[conf] = (e.byConfidence[conf] ?? 0) + 1;
    addSample(e.evidenceIds, evidenceId);
    return e;
  }

  // ------------------------------------------------------------------ exports

  export(): DiscoveryExport {
    const d = this.dropped;
    return JSON.parse(JSON.stringify({
      schemaVersion: 1, kind: 'fastqa-discovery', sessions: [this.o.sessionId], generatedAt: this.now(), limits: LIMITS_NOTE,
      routes: [...this.routes.values()], endpoints: [...this.endpoints.values()], actions: [...this.actions.values()], edges: [...this.edges.values()],
      thirdPartyRequests: this.thirdParty,
      truncated: d.routes + d.endpoints + d.actions + d.edges > 0, dropped: { ...d },
    })) as DiscoveryExport;
  }

  journeys(): JourneyExport {
    return JSON.parse(JSON.stringify({
      schemaVersion: 1, kind: 'fastqa-journeys', sessionId: this.o.sessionId, generatedAt: this.now(), note: JOURNEY_NOTE,
      journeys: [...this.batches.values()].map((b) => ({ batchId: b.batchId, kind: b.kind, scope: b.scope, steps: [...b.steps.values()].map((s) => s.step) })),
      truncated: this.journeysTruncated,
    })) as JourneyExport;
  }
}

// ---------------------------------------------------------------------------------------------------- merge

/**
 * Explicit merge of sanitized exports from several sessions. Nodes and edges are united by their stable keys
 * (route = origin + path, endpoint = method + origin + path, action = route + label); counts are summed.
 * Evidence ids are prefixed with their session id so they stay traceable to the session bundle they came from.
 */
export function mergeDiscovery(exports: DiscoveryExport[]): DiscoveryExport {
  const routes = new Map<string, RouteNode>(); const endpoints = new Map<string, EndpointNode>();
  const actions = new Map<string, ActionNode>(); const edges = new Map<string, DiscoveryEdge>();
  const sessions: string[] = []; const dropped = { routes: 0, endpoints: 0, actions: 0, edges: 0 };
  let thirdParty = 0; let truncated = false; let generatedAt = '';
  const min = (a: string, b: string) => (a && (!b || a < b) ? a : b);
  const max = (a: string, b: string) => (a > b ? a : b);

  for (const d of exports) {
    if (!d || d.schemaVersion !== 1) continue;
    for (const s of d.sessions ?? []) if (!sessions.includes(s)) sessions.push(s);
    // ids of a single-session export are local to it; ids of an already merged export are prefixed already
    const tag = (id: string) => (id.includes(':') || (d.sessions ?? []).length !== 1 ? id : `${d.sessions[0]}:${id}`);
    const samples = (into: string[], from: string[] = []) => { for (const id of from) addSample(into, tag(id)); };
    thirdParty += d.thirdPartyRequests ?? 0; truncated ||= !!d.truncated; generatedAt = max(generatedAt, d.generatedAt ?? '');
    for (const k of ['routes', 'endpoints', 'actions', 'edges'] as const) dropped[k] += d.dropped?.[k] ?? 0;
    const local = new Map<string, string>(); // id in this export -> stable key

    for (const r of d.routes ?? []) {
      const key = `${r.origin}${r.path}`; local.set(r.id, `route:${key}`);
      let m = routes.get(key);
      if (!m) {
        if (routes.size >= DISCOVERY_CAPS.routes) { dropped.routes++; continue; }
        m = { id: '', origin: r.origin, path: r.path, count: 0, firstSeen: r.firstSeen, lastSeen: r.lastSeen, evidenceIds: [] }; routes.set(key, m);
      }
      m.count += r.count; m.firstSeen = min(m.firstSeen, r.firstSeen); m.lastSeen = max(m.lastSeen, r.lastSeen); samples(m.evidenceIds, r.evidenceIds);
    }
    for (const e of d.endpoints ?? []) {
      const key = `${e.method} ${e.origin}${e.path}`; local.set(e.id, `endpoint:${key}`);
      let m = endpoints.get(key);
      if (!m) {
        if (endpoints.size >= DISCOVERY_CAPS.endpoints) { dropped.endpoints++; continue; }
        m = { id: '', method: e.method, origin: e.origin, path: e.path, statuses: [], contentTypes: [], count: 0, background: 0, failed: 0, firstSeen: e.firstSeen, lastSeen: e.lastSeen, evidenceIds: [] };
        endpoints.set(key, m);
      }
      m.count += e.count; m.background += e.background ?? 0; m.failed += e.failed ?? 0;
      m.firstSeen = min(m.firstSeen, e.firstSeen); m.lastSeen = max(m.lastSeen, e.lastSeen);
      for (const s of e.statuses ?? []) if (!m.statuses.includes(s)) m.statuses.push(s);
      m.statuses.sort((a, b) => a - b);
      for (const c of e.contentTypes ?? []) addTo(m.contentTypes, c, 5);
      samples(m.evidenceIds, e.evidenceIds);
      if (e.requestShape !== undefined && m.requestShape === undefined) m.requestShape = e.requestShape;
      for (const [st, shape] of Object.entries(e.responseShapes ?? {})) { m.responseShapes ??= {}; if (!(st in m.responseShapes) && Object.keys(m.responseShapes).length < 5) m.responseShapes[st] = shape; }
    }
    for (const a of d.actions ?? []) {
      const routeKey = a.route ? local.get(a.route) : undefined;
      const key = `${routeKey ?? ''}|${a.label}`; local.set(a.id, `action:${key}`);
      let m = actions.get(key);
      if (!m) {
        if (actions.size >= DISCOVERY_CAPS.actions) { dropped.actions++; continue; }
        m = { id: '', route: routeKey, label: a.label, kind: a.kind, scopes: [], count: 0 }; actions.set(key, m); // route holds the stable key until ids are assigned
      }
      m.count += a.count; for (const s of a.scopes ?? []) addTo(m.scopes, s, 5);
    }
    for (const e of d.edges ?? []) {
      const from = local.get(e.from); const to = local.get(e.to);
      if (!from || !to) { dropped.edges++; continue; }
      const key = `${e.relation}|${from}|${to}`;
      let m = edges.get(key);
      if (!m) {
        if (edges.size >= DISCOVERY_CAPS.edges) { dropped.edges++; continue; }
        m = { from, to, relation: e.relation, confidence: e.confidence, byConfidence: {}, count: 0, evidenceIds: [] }; edges.set(key, m);
      }
      m.count += e.count; m.confidence = weakest(m.confidence, e.confidence);
      for (const [c, n] of Object.entries(e.byConfidence ?? {})) m.byConfidence[c as AssocConfidence] = (m.byConfidence[c as AssocConfidence] ?? 0) + (n ?? 0);
      samples(m.evidenceIds, e.evidenceIds);
      for (const v of e.via ?? []) { const k = local.get(v); if (k) { m.via ??= []; addTo(m.via, k, MAX_SAMPLES); } }
    }
  }

  // assign ids, then turn stable keys back into ids; anything pointing at a node that was dropped by a cap goes too
  const ids = new Map<string, string>();
  let n = 0; for (const [k, r] of routes) { r.id = `R${++n}`; ids.set(`route:${k}`, r.id); }
  n = 0; for (const [k, e] of endpoints) { e.id = `EP${++n}`; ids.set(`endpoint:${k}`, e.id); }
  n = 0; for (const [k, a] of actions) { a.id = `AC${++n}`; ids.set(`action:${k}`, a.id); a.route = a.route ? ids.get(a.route) : undefined; }
  const outEdges: DiscoveryEdge[] = [];
  for (const e of edges.values()) {
    const from = ids.get(e.from); const to = ids.get(e.to);
    if (!from || !to) { dropped.edges++; continue; }
    const via = e.via?.map((v) => ids.get(v)).filter((v): v is string => !!v);
    outEdges.push({ ...e, from, to, ...(via?.length ? { via } : { via: undefined }) });
  }
  truncated ||= dropped.routes + dropped.endpoints + dropped.actions + dropped.edges > 0;
  return JSON.parse(JSON.stringify({
    schemaVersion: 1, kind: 'fastqa-discovery', sessions, generatedAt, limits: LIMITS_NOTE,
    routes: [...routes.values()], endpoints: [...endpoints.values()], actions: [...actions.values()], edges: outEdges,
    thirdPartyRequests: thirdParty, truncated, dropped,
  })) as DiscoveryExport;
}

// ---------------------------------------------------------------------------------------------------- text view

/** Compact, bounded text view for `evidence {view:"discovery"}`. `path` filters routes and endpoints by path fragment. */
export function renderDiscovery(d: DiscoveryExport, opts: { path?: string; limit?: number } = {}): string {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const f = opts.path;
  const origins = new Set([...d.routes.map((r) => r.origin), ...d.endpoints.map((e) => e.origin)]);
  const single = origins.size <= 1;
  const at = (origin: string, path: string) => (single ? path : origin + path);
  const routes = d.routes.filter((r) => !f || r.path.includes(f));
  const endpoints = d.endpoints.filter((e) => !f || e.path.includes(f));
  const name = new Map<string, string>();
  for (const r of d.routes) name.set(r.id, `${r.id} ${at(r.origin, r.path)}`);
  for (const e of d.endpoints) name.set(e.id, `${e.id} ${e.method} ${at(e.origin, e.path)}`);
  for (const a of d.actions) name.set(a.id, `${a.id} ${a.label}`);
  const keep = new Set([...routes.map((r) => r.id), ...endpoints.map((e) => e.id)]);
  const edges = d.edges.filter((e) => !f || keep.has(e.from) || keep.has(e.to));
  const section = <T>(title: string, items: T[], line: (x: T) => string): string[] => {
    if (!items.length) return [`${title}: none${f ? ` matching "${f}"` : ''}`];
    const shown = items.slice(0, limit);
    return [`${title} (${shown.length} of ${items.length}${items.length > shown.length ? `, ${items.length - shown.length} omitted: raise limit or filter by path` : ''}):`, ...shown.map((x) => '  ' + line(x))];
  };
  const shapes = (e: EndpointNode) => {
    const parts: string[] = [];
    if (e.requestShape !== undefined) parts.push(`request ${JSON.stringify(e.requestShape).slice(0, 160)}`);
    for (const [st, s] of Object.entries(e.responseShapes ?? {})) parts.push(`${st} ${JSON.stringify(s).slice(0, 160)}`);
    return parts.length ? ` · fields: ${parts.join(' | ')}` : '';
  };
  const dropped = d.dropped.routes + d.dropped.endpoints + d.dropped.actions + d.dropped.edges;
  return [
    `discovery: observed activity of ${d.sessions.length} session(s) ${d.sessions.slice(0, 4).join(', ')}${d.sessions.length > 4 ? ', …' : ''} — what was seen, not coverage of what was not`,
    `${d.routes.length} routes · ${d.endpoints.length} endpoints · ${d.actions.length} actions · ${d.edges.length} edges · ${d.thirdPartyRequests} third-party requests (not listed)${d.truncated ? ` · truncated: ${dropped} items over the caps were dropped` : ''}`,
    single && origins.size ? `origin: ${[...origins][0]}` : '',
    ...section('routes', routes, (r) => `${r.id} ${at(r.origin, r.path)} ×${r.count}`),
    ...section('endpoints', endpoints, (e) => `${e.id} ${e.method} ${at(e.origin, e.path)} → ${e.statuses.join(',') || 'no response'} ×${e.count}${e.background ? ` (${e.background} without an action: background or unknown)` : ''}${e.failed ? ` (${e.failed} failed)` : ''}${shapes(e)}`),
    ...section('edges', edges, (e) => `${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to} · ${e.relation} ×${e.count} (${e.confidence})${e.via?.length ? ` via ${e.via.map((v) => name.get(v) ?? v).join(', ')}` : ''}${e.evidenceIds.length ? ` · ${e.evidenceIds.join(',')}` : ''}`),
  ].filter(Boolean).join('\n');
}
