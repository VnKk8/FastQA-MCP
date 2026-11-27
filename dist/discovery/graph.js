import { normalizePath, shapeOf } from '../util/paths.js';
export const DISCOVERY_CAPS = { routes: 500, endpoints: 2000, actions: 2000, edges: 5000, batches: 200, stepsPerBatch: 100 };
const LIMITS_NOTE = 'Observed browser activity only: routes, actions and first-party API calls seen in the listed session(s). ' +
    'Not a coverage measure. Backend-only traffic, unvisited pages, service ownership and business rules are not represented.';
const JOURNEY_NOTE = 'Only actions with an observed navigation or first-party request appear. Order is the order in which they were first observed.';
const MAX_SAMPLES = 3;
const MAX_TRACKED_ACTIONS = 5000;
export const BEHAVIOUR_CAPS = { routes: 200, fieldsPerRoute: 30, controlsPerRoute: 60 };
const RANK = { direct: 3, inferred: 2, ambiguous: 1, unattributed: 0 };
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const attributed = (c) => c === 'direct' || c === 'inferred';
const addSample = (list, id) => { if (id && list.length < MAX_SAMPLES && !list.includes(id))
    list.push(id); };
const addTo = (list, v, max) => { if (!list.includes(v) && list.length < max)
    list.push(v); };
/** Action labels can quote a URL (goto "…"): the query string and fragment are dropped, values never enter the graph. */
const cleanLabel = (s) => s.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/g, '$1').slice(0, 160);
export class DiscoveryGraph {
    o;
    routes = new Map();
    endpoints = new Map();
    actions = new Map();
    edges = new Map();
    nRoute = 0;
    nEndpoint = 0;
    nAction = 0;
    /** page id -> key of the route that page is on */
    pageRoute = new Map();
    /** action id -> its node key and batch, so one execution is counted once */
    seenActions = new Map();
    batches = new Map();
    thirdParty = 0;
    dropped = { routes: 0, endpoints: 0, actions: 0, edges: 0 };
    journeysTruncated = false;
    templates;
    now;
    /** route key -> fields and controls the snapshots of that route showed (bounded) */
    seen = new Map();
    seenTruncated = false;
    /** labels of this session (role, environment), set by the owner */
    context;
    /**
     * What a snapshot of a page showed: its fields with the constraints they declare, and its controls. Called with the
     * lines fastqa already has (CPU only, no page access). Values are never kept: only names, roles and constraints.
     */
    noteSnapshot(url, lines) {
        let origin = '';
        let pathname = '';
        try {
            const u = new URL(url);
            origin = u.origin;
            pathname = u.pathname;
        }
        catch {
            return;
        }
        if (!/^https?:/.test(origin))
            return;
        const key = `${origin}${normalizePath(pathname, this.templates)}`;
        let s = this.seen.get(key);
        if (!s) {
            if (this.seen.size >= BEHAVIOUR_CAPS.routes) {
                this.seenTruncated = true;
                return;
            }
            s = { fields: new Map(), controls: new Set() };
            this.seen.set(key, s);
        }
        for (const l of lines) {
            const m = /^\s*e\d+ (\S+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(l);
            if (!m || !m[2])
                continue;
            let name = m[2];
            try {
                name = JSON.parse(`"${m[2]}"`);
            }
            catch { /* keep as shown */ }
            const role = m[1];
            if (/^(textbox|searchbox|combobox|listbox|checkbox|radio|switch|slider|file)$/.test(role)) {
                if (s.fields.has(`${role}|${name}`))
                    continue;
                if (s.fields.size >= BEHAVIOUR_CAPS.fieldsPerRoute) {
                    this.seenTruncated = true;
                    continue;
                }
                // constraint tokens only (required, type, lengths, limits, pattern, accept); never the value (=…) or options: the
                // value token is removed first, so text typed into a field ("type:pdf acme") can never pass for a constraint
                const rest = m[3].replace(/(^| )=("(?:[^"\\]|\\.)*"|\S+)/g, ' ').replace(/(^| )options:.*?(?= \[|$)/, ' ');
                const constraints = (rest.match(/(?:^| )(\[(required|disabled|multiple)\]|(type|maxlength|minlength|min|max|step|pattern|accept):("(?:[^"\\]|\\.)*"|\S+))/g) ?? []).map((c) => c.trim()).slice(0, 8);
                s.fields.set(`${role}|${name}`, { name: cleanLabel(name).slice(0, 60), role, constraints });
            }
            else if (/^(button|link|tab|menuitem|option)$/.test(role)) {
                if (s.controls.size >= BEHAVIOUR_CAPS.controlsPerRoute) {
                    this.seenTruncated = true;
                    continue;
                }
                s.controls.add(`${role} ${JSON.stringify(cleanLabel(name).slice(0, 60))}`);
            }
        }
    }
    behaviour() {
        return {
            version: 1, truncated: this.seenTruncated,
            // routes by their stable key (origin + normalized path), so merging needs no id mapping
            routes: [...this.seen].map(([k, s]) => ({ route: k, fields: [...s.fields.values()], controls: [...s.controls] })),
        };
    }
    constructor(o) {
        this.o = o;
        this.templates = o.pathTemplates ?? [];
        this.now = o.now ?? (() => new Date().toISOString());
    }
    // ------------------------------------------------------------------ sink
    onEvent(e) {
        const d = e.data;
        if (e.kind === 'state_change') {
            if (d.type === 'page_closed' && e.pageId) {
                this.pageRoute.delete(e.pageId);
                return;
            }
            if (d.type !== 'navigation' || typeof d.url !== 'string')
                return;
            let origin = '';
            let pathname = '';
            try {
                const u = new URL(d.url);
                origin = u.origin;
                pathname = u.pathname;
            }
            catch {
                return;
            }
            if (!/^https?:/.test(origin))
                return;
            const pageId = e.pageId ?? 'P-?';
            const prevKey = this.pageRoute.get(pageId);
            // the action is registered against the route the page was on before this navigation
            const st = attributed(e.action.confidence) ? this.touchAction(e.action.actionId, e.batchId, prevKey) : undefined;
            const at = e.at || this.now();
            const key = `${origin}${normalizePath(pathname, this.templates)}`;
            let r = this.routes.get(key);
            if (!r) {
                if (this.routes.size >= DISCOVERY_CAPS.routes) {
                    this.dropped.routes++;
                    return;
                }
                r = { id: `R${++this.nRoute}`, origin, path: key.slice(origin.length), count: 0, firstSeen: at, lastSeen: at, evidenceIds: [] };
                this.routes.set(key, r);
            }
            r.count++;
            r.lastSeen = at;
            addSample(r.evidenceIds, e.eventId);
            if (this.pageRoute.size < 200 || this.pageRoute.has(pageId))
                this.pageRoute.set(pageId, key);
            if (st) {
                st.step.routeAfter = r.path;
                st.step.routeAfterId = r.id;
            }
            const prev = prevKey ? this.routes.get(prevKey) : undefined;
            if (prev && prev !== r) {
                const edge = this.edge('navigation', prev.id, r.id, e.action.confidence, e.eventId);
                const via = st?.node ? this.actions.get(st.node)?.id : undefined;
                if (edge && via) {
                    edge.via ??= [];
                    addTo(edge.via, via, MAX_SAMPLES);
                }
            }
            return;
        }
        // any other event tied to one action: remember which route that action was performed on (first sight wins)
        if (attributed(e.action.confidence) && e.action.actionId)
            this.touchAction(e.action.actionId, e.batchId, e.pageId ? this.pageRoute.get(e.pageId) : undefined);
    }
    onRequestDone(rec) {
        if (!rec.firstParty) {
            this.thirdParty++;
            return;
        }
        if (!rec.tracked || rec.resourceType === 'document')
            return; // pages and static resources are not API endpoints
        const at = this.now();
        const path = normalizePath(rec.route || rec.path, this.templates);
        const key = `${rec.method} ${rec.origin}${path}`;
        let ep = this.endpoints.get(key);
        if (!ep) {
            if (this.endpoints.size >= DISCOVERY_CAPS.endpoints) {
                this.dropped.endpoints++;
                return;
            }
            ep = { id: `EP${++this.nEndpoint}`, method: rec.method, origin: rec.origin, path, statuses: [], contentTypes: [], count: 0, background: 0, failed: 0, firstSeen: at, lastSeen: at, evidenceIds: [] };
            this.endpoints.set(key, ep);
        }
        ep.count++;
        ep.lastSeen = at;
        if (rec.status !== undefined && !ep.statuses.includes(rec.status)) {
            ep.statuses.push(rec.status);
            ep.statuses.sort((a, b) => a - b);
        }
        if (rec.contentType)
            addTo(ep.contentTypes, rec.contentType, 5);
        if (rec.failure && !rec.aborted)
            ep.failed++;
        const sample = rec.eventIds[1] ?? rec.eventIds[0];
        addSample(ep.evidenceIds, sample);
        // shapes exist only when payload capture was explicitly allowed for this endpoint; they hold names and types, never values
        if (rec.requestShape !== undefined && ep.requestShape === undefined)
            ep.requestShape = rec.requestShape;
        if (rec.body?.state === 'captured' && rec.body.json !== undefined && rec.status !== undefined) {
            ep.responseShapes ??= {};
            const k = String(rec.status);
            if (!(k in ep.responseShapes) && Object.keys(ep.responseShapes).length < 5)
                ep.responseShapes[k] = shapeOf(rec.body.json);
        }
        const conf = rec.association.confidence;
        const routeKey = rec.pageId ? this.pageRoute.get(rec.pageId) : undefined;
        const route = routeKey ? this.routes.get(routeKey) : undefined;
        if (route)
            this.edge('observed_request', route.id, ep.id, conf, sample);
        if (!attributed(conf) || !rec.association.actionId) {
            ep.background++;
            return;
        } // no action context: background / unknown
        const st = this.touchAction(rec.association.actionId, rec.batchId, routeKey);
        const node = st?.node ? this.actions.get(st.node) : undefined;
        if (!node)
            return;
        this.edge('triggers', node.id, ep.id, conf, sample);
        const name = `${ep.method} ${ep.path}`;
        if (st && !st.step.endpointIds.includes(ep.id) && st.step.endpointIds.length < 20) {
            st.step.endpointIds.push(ep.id);
            st.step.endpoints.push(name);
        }
    }
    // ------------------------------------------------------------------ internals
    /** Registers one execution of an action (once per action id) and returns its journey step. */
    touchAction(actionId, batchId, routeKey) {
        if (!actionId)
            return undefined;
        let seen = this.seenActions.get(actionId);
        if (!seen) {
            const info = this.o.describeAction(actionId);
            if (!info)
                return undefined;
            const label = cleanLabel(info.label);
            const route = routeKey ? this.routes.get(routeKey) : undefined;
            // A goto does not depend on the page it starts from, so it is one node wherever it was issued.
            const on = info.kind === 'goto' ? undefined : route;
            const key = `${on ? routeKey : ''}|${label}`;
            let node = this.actions.get(key);
            if (!node) {
                if (this.actions.size >= DISCOVERY_CAPS.actions)
                    this.dropped.actions++;
                else {
                    node = { id: `AC${++this.nAction}`, route: on?.id, label, kind: info.kind, scopes: [], count: 0, ...(info.control ? { control: cleanLabel(info.control).slice(0, 60) } : {}) };
                    this.actions.set(key, node);
                }
            }
            if (node) {
                node.count++;
                const scope = this.o.scopeOf(batchId);
                if (scope)
                    addTo(node.scopes, scope, 5);
            }
            seen = { key: node ? key : undefined, batchId };
            this.seenActions.set(actionId, seen);
            if (this.seenActions.size > MAX_TRACKED_ACTIONS)
                this.seenActions.delete(this.seenActions.keys().next().value);
            this.journeyStep(actionId, seen, label, info.kind, route);
        }
        const b = seen.batchId ? this.batches.get(seen.batchId) : undefined;
        const st = b?.steps.get(actionId);
        return st ?? (seen.key ? { actionId, node: seen.key, step: { action: '', kind: '', endpoints: [], endpointIds: [] } } : undefined);
    }
    journeyStep(actionId, seen, label, kind, route) {
        const batchId = seen.batchId;
        if (!batchId)
            return;
        let b = this.batches.get(batchId);
        if (!b) {
            if (this.batches.size >= DISCOVERY_CAPS.batches) {
                this.batches.delete(this.batches.keys().next().value);
                this.journeysTruncated = true;
            }
            b = { batchId, kind: this.o.batchKind?.(batchId), scope: this.o.scopeOf(batchId), steps: new Map() };
            this.batches.set(batchId, b);
        }
        if (b.steps.size >= DISCOVERY_CAPS.stepsPerBatch) {
            this.journeysTruncated = true;
            return;
        }
        b.steps.set(actionId, { actionId, node: seen.key, step: { action: label, kind, routeBefore: route?.path, routeBeforeId: route?.id, routeAfter: route?.path, routeAfterId: route?.id, endpoints: [], endpointIds: [] } });
    }
    edge(relation, from, to, conf, evidenceId) {
        const key = `${relation}|${from}|${to}`;
        let e = this.edges.get(key);
        if (!e) {
            if (this.edges.size >= DISCOVERY_CAPS.edges) {
                this.dropped.edges++;
                return undefined;
            }
            e = { from, to, relation, confidence: conf, byConfidence: {}, count: 0, evidenceIds: [] };
            this.edges.set(key, e);
        }
        e.count++;
        e.confidence = weakest(e.confidence, conf);
        e.byConfidence[conf] = (e.byConfidence[conf] ?? 0) + 1;
        addSample(e.evidenceIds, evidenceId);
        return e;
    }
    // ------------------------------------------------------------------ exports
    export() {
        const d = this.dropped;
        return JSON.parse(JSON.stringify({
            schemaVersion: 1, kind: 'fastqa-discovery', sessions: [this.o.sessionId], generatedAt: this.now(), limits: LIMITS_NOTE,
            routes: [...this.routes.values()], endpoints: [...this.endpoints.values()], actions: [...this.actions.values()], edges: [...this.edges.values()],
            thirdPartyRequests: this.thirdParty,
            truncated: d.routes + d.endpoints + d.actions + d.edges > 0, dropped: { ...d },
            ...(this.context && (this.context.role || this.context.env) ? { context: this.context } : {}),
            ...(this.seen.size ? { behaviour: this.behaviour() } : {}),
        }));
    }
    journeys() {
        return JSON.parse(JSON.stringify({
            schemaVersion: 1, kind: 'fastqa-journeys', sessionId: this.o.sessionId, generatedAt: this.now(), note: JOURNEY_NOTE,
            journeys: [...this.batches.values()].map((b) => ({ batchId: b.batchId, kind: b.kind, scope: b.scope, steps: [...b.steps.values()].map((s) => s.step) })),
            truncated: this.journeysTruncated,
        }));
    }
}
// ---------------------------------------------------------------------------------------------------- merge
/**
 * Explicit merge of sanitized exports from several sessions. Nodes and edges are united by their stable keys
 * (route = origin + path, endpoint = method + origin + path, action = route + label); counts are summed.
 * Evidence ids are prefixed with their session id so they stay traceable to the session bundle they came from.
 */
export function mergeDiscovery(exports) {
    const routes = new Map();
    const endpoints = new Map();
    const actions = new Map();
    const edges = new Map();
    const sessions = [];
    const dropped = { routes: 0, endpoints: 0, actions: 0, edges: 0 };
    let thirdParty = 0;
    let truncated = false;
    let generatedAt = '';
    const min = (a, b) => (a && (!b || a < b) ? a : b);
    const max = (a, b) => (a > b ? a : b);
    const seenBehaviour = new Map();
    let behaviourTruncated = false;
    let skipped = 0;
    for (const d of exports) {
        if (!d || d.schemaVersion !== 1)
            continue;
        // idempotent: an export whose sessions are all merged already (the same bundle twice, or a merged file plus its
        // sources) adds nothing; counts are never summed twice for one session
        const own = d.sessions ?? [];
        if (own.length && own.every((s) => sessions.includes(s))) {
            skipped++;
            continue;
        }
        for (const s of own)
            if (!sessions.includes(s))
                sessions.push(s);
        // ids of a single-session export are local to it; ids of an already merged export are prefixed already
        const tag = (id) => (id.includes(':') || (d.sessions ?? []).length !== 1 ? id : `${d.sessions[0]}:${id}`);
        const samples = (into, from = []) => { for (const id of from)
            addSample(into, tag(id)); };
        thirdParty += d.thirdPartyRequests ?? 0;
        truncated ||= !!d.truncated;
        generatedAt = max(generatedAt, d.generatedAt ?? '');
        for (const k of ['routes', 'endpoints', 'actions', 'edges'])
            dropped[k] += d.dropped?.[k] ?? 0;
        const local = new Map(); // id in this export -> stable key
        // another role or environment is another product surface: its nodes are kept apart, never united by path
        const context = d.context && (d.context.role || d.context.env) ? `role ${d.context.role || '-'}, env ${d.context.env || '-'}` : undefined;
        const cx = (k) => (context ? `[${context}] ${k}` : k);
        const tagged = (n, c) => (c ? { ...n, context: c } : n);
        for (const r of d.routes ?? []) {
            const key = cx(`${r.origin}${r.path}`);
            local.set(r.id, `route:${key}`);
            let m = routes.get(key);
            if (!m) {
                if (routes.size >= DISCOVERY_CAPS.routes) {
                    dropped.routes++;
                    continue;
                }
                m = tagged({ id: '', origin: r.origin, path: r.path, count: 0, firstSeen: r.firstSeen, lastSeen: r.lastSeen, evidenceIds: [] }, context ?? r.context);
                routes.set(key, m);
            }
            m.count += r.count;
            m.firstSeen = min(m.firstSeen, r.firstSeen);
            m.lastSeen = max(m.lastSeen, r.lastSeen);
            samples(m.evidenceIds, r.evidenceIds);
        }
        for (const b of d.behaviour?.routes ?? []) {
            const key = cx(b.route);
            let m = seenBehaviour.get(key);
            if (!m) {
                if (seenBehaviour.size >= BEHAVIOUR_CAPS.routes) {
                    behaviourTruncated = true;
                    continue;
                }
                m = { route: b.route, context, fields: new Map(), controls: new Set() };
                seenBehaviour.set(key, m);
            }
            for (const f of b.fields ?? [])
                if (m.fields.size < BEHAVIOUR_CAPS.fieldsPerRoute)
                    m.fields.set(`${f.role}|${f.name}`, f);
                else
                    behaviourTruncated = true;
            for (const c of b.controls ?? [])
                if (m.controls.size < BEHAVIOUR_CAPS.controlsPerRoute)
                    m.controls.add(c);
                else
                    behaviourTruncated = true;
            behaviourTruncated ||= !!d.behaviour?.truncated;
        }
        for (const e of d.endpoints ?? []) {
            const key = cx(`${e.method} ${e.origin}${e.path}`);
            local.set(e.id, `endpoint:${key}`);
            let m = endpoints.get(key);
            if (!m) {
                if (endpoints.size >= DISCOVERY_CAPS.endpoints) {
                    dropped.endpoints++;
                    continue;
                }
                m = tagged({ id: '', method: e.method, origin: e.origin, path: e.path, statuses: [], contentTypes: [], count: 0, background: 0, failed: 0, firstSeen: e.firstSeen, lastSeen: e.lastSeen, evidenceIds: [] }, context ?? e.context);
                endpoints.set(key, m);
            }
            m.count += e.count;
            m.background += e.background ?? 0;
            m.failed += e.failed ?? 0;
            m.firstSeen = min(m.firstSeen, e.firstSeen);
            m.lastSeen = max(m.lastSeen, e.lastSeen);
            for (const s of e.statuses ?? [])
                if (!m.statuses.includes(s))
                    m.statuses.push(s);
            m.statuses.sort((a, b) => a - b);
            for (const c of e.contentTypes ?? [])
                addTo(m.contentTypes, c, 5);
            samples(m.evidenceIds, e.evidenceIds);
            if (e.requestShape !== undefined && m.requestShape === undefined)
                m.requestShape = e.requestShape;
            for (const [st, shape] of Object.entries(e.responseShapes ?? {})) {
                m.responseShapes ??= {};
                if (!(st in m.responseShapes) && Object.keys(m.responseShapes).length < 5)
                    m.responseShapes[st] = shape;
            }
        }
        for (const a of d.actions ?? []) {
            const routeKey = a.route ? local.get(a.route) : undefined;
            const key = cx(`${routeKey ?? ''}|${a.label}`);
            local.set(a.id, `action:${key}`);
            let m = actions.get(key);
            if (!m) {
                if (actions.size >= DISCOVERY_CAPS.actions) {
                    dropped.actions++;
                    continue;
                }
                m = tagged({ id: '', route: routeKey, label: a.label, kind: a.kind, scopes: [], count: 0, ...(a.control ? { control: a.control } : {}) }, context ?? a.context);
                actions.set(key, m); // route holds the stable key until ids are assigned
            }
            m.count += a.count;
            for (const s of a.scopes ?? [])
                addTo(m.scopes, s, 5);
        }
        for (const e of d.edges ?? []) {
            const from = local.get(e.from);
            const to = local.get(e.to);
            if (!from || !to) {
                dropped.edges++;
                continue;
            }
            const key = `${e.relation}|${from}|${to}`;
            let m = edges.get(key);
            if (!m) {
                if (edges.size >= DISCOVERY_CAPS.edges) {
                    dropped.edges++;
                    continue;
                }
                m = { from, to, relation: e.relation, confidence: e.confidence, byConfidence: {}, count: 0, evidenceIds: [] };
                edges.set(key, m);
            }
            m.count += e.count;
            m.confidence = weakest(m.confidence, e.confidence);
            for (const [c, n] of Object.entries(e.byConfidence ?? {}))
                m.byConfidence[c] = (m.byConfidence[c] ?? 0) + (n ?? 0);
            samples(m.evidenceIds, e.evidenceIds);
            for (const v of e.via ?? []) {
                const k = local.get(v);
                if (k) {
                    m.via ??= [];
                    addTo(m.via, k, MAX_SAMPLES);
                }
            }
        }
    }
    // assign ids, then turn stable keys back into ids; anything pointing at a node that was dropped by a cap goes too
    const ids = new Map();
    let n = 0;
    for (const [k, r] of routes) {
        r.id = `R${++n}`;
        ids.set(`route:${k}`, r.id);
    }
    n = 0;
    for (const [k, e] of endpoints) {
        e.id = `EP${++n}`;
        ids.set(`endpoint:${k}`, e.id);
    }
    n = 0;
    for (const [k, a] of actions) {
        a.id = `AC${++n}`;
        ids.set(`action:${k}`, a.id);
        a.route = a.route ? ids.get(a.route) : undefined;
    }
    const outEdges = [];
    for (const e of edges.values()) {
        const from = ids.get(e.from);
        const to = ids.get(e.to);
        if (!from || !to) {
            dropped.edges++;
            continue;
        }
        const via = e.via?.map((v) => ids.get(v)).filter((v) => !!v);
        outEdges.push({ ...e, from, to, ...(via?.length ? { via } : { via: undefined }) });
    }
    truncated ||= dropped.routes + dropped.endpoints + dropped.actions + dropped.edges > 0;
    const behaviour = seenBehaviour.size ? {
        version: 1, truncated: behaviourTruncated,
        routes: [...seenBehaviour.values()].map((b) => ({ route: b.context ? `[${b.context}] ${b.route}` : b.route, fields: [...b.fields.values()], controls: [...b.controls] })),
    } : undefined;
    return JSON.parse(JSON.stringify({
        schemaVersion: 1, kind: 'fastqa-discovery', sessions, generatedAt, limits: LIMITS_NOTE,
        routes: [...routes.values()], endpoints: [...endpoints.values()], actions: [...actions.values()], edges: outEdges,
        thirdPartyRequests: thirdParty, truncated, dropped,
        ...(behaviour ? { behaviour } : {}),
        ...(skipped ? { mergeNote: `${skipped} export(s) skipped: their sessions were merged already` } : {}),
    }));
}
// ---------------------------------------------------------------------------------------------------- text view
/** Compact, bounded text view for `evidence {view:"discovery"}`. `path` filters routes and endpoints by path fragment. */
export function renderDiscovery(d, opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    const f = opts.path;
    const origins = new Set([...d.routes.map((r) => r.origin), ...d.endpoints.map((e) => e.origin)]);
    const single = origins.size <= 1;
    const at = (origin, path) => (single ? path : origin + path);
    const routes = d.routes.filter((r) => !f || r.path.includes(f));
    const endpoints = d.endpoints.filter((e) => !f || e.path.includes(f));
    const name = new Map();
    for (const r of d.routes)
        name.set(r.id, `${r.id} ${at(r.origin, r.path)}`);
    for (const e of d.endpoints)
        name.set(e.id, `${e.id} ${e.method} ${at(e.origin, e.path)}`);
    for (const a of d.actions)
        name.set(a.id, `${a.id} ${a.label}`);
    const keep = new Set([...routes.map((r) => r.id), ...endpoints.map((e) => e.id)]);
    const edges = d.edges.filter((e) => !f || keep.has(e.from) || keep.has(e.to));
    const section = (title, items, line) => {
        if (!items.length)
            return [`${title}: none${f ? ` matching "${f}"` : ''}`];
        const shown = items.slice(0, limit);
        return [`${title} (${shown.length} of ${items.length}${items.length > shown.length ? `, ${items.length - shown.length} omitted: raise limit or filter by path` : ''}):`, ...shown.map((x) => '  ' + line(x))];
    };
    const shapes = (e) => {
        const parts = [];
        if (e.requestShape !== undefined)
            parts.push(`request ${JSON.stringify(e.requestShape).slice(0, 160)}`);
        for (const [st, s] of Object.entries(e.responseShapes ?? {}))
            parts.push(`${st} ${JSON.stringify(s).slice(0, 160)}`);
        return parts.length ? ` · fields: ${parts.join(' | ')}` : '';
    };
    const dropped = d.dropped.routes + d.dropped.endpoints + d.dropped.actions + d.dropped.edges;
    // behaviour summaries: what the actions were seen to call, the constraints pages declared, what failed, and controls
    // that were shown but never used. All observed only; nothing here is a claim about unvisited functionality.
    const byAction = new Map();
    const epById = new Map(d.endpoints.map((x) => [x.id, x]));
    for (const e of d.edges)
        if (e.relation === 'triggers') {
            const ep = epById.get(e.to);
            if (ep && (!f || ep.path.includes(f)))
                byAction.set(e.from, [...(byAction.get(e.from) ?? []), `${ep.method} ${at(ep.origin, ep.path)} → ${ep.statuses.join(',') || '…'}${e.confidence === 'inferred' ? '' : ` (${e.confidence})`}`]);
        }
    const perAction = d.actions.filter((a) => byAction.has(a.id)).map((a) => `${a.id} ${a.label}${a.context ? ` [${a.context}]` : ''}: ${byAction.get(a.id).slice(0, 4).join(' · ')}`);
    const routeKey = new Map(d.routes.map((r) => [r.id, `${r.origin}${r.path}`]));
    const fields = (d.behaviour?.routes ?? []).filter((b) => !f || b.route.includes(f)).flatMap((b) => b.fields.filter((x) => x.constraints.length).map((x) => `${shortRoute(b.route, single)} · ${x.role} ${JSON.stringify(x.name)}: ${x.constraints.join(' ')}`));
    const failing = d.endpoints.filter((e) => (!f || e.path.includes(f)) && (e.failed || e.statuses.some((s) => s >= 400))).map((e) => `${e.method} ${at(e.origin, e.path)} → ${e.statuses.filter((s) => s >= 400).join(',') || ''}${e.failed ? `${e.statuses.some((s) => s >= 400) ? ', ' : ''}${e.failed} failed` : ''}`);
    const acted = new Map();
    for (const a of d.actions) {
        const m = /^\w+ "((?:[^"\\]|\\.)*)"/.exec(a.label);
        const rk = a.route ? routeKey.get(a.route) : undefined;
        if (!rk)
            continue;
        const set = acted.get(rk) ?? new Set();
        if (m) {
            try {
                set.add(JSON.parse(`"${m[1]}"`).toLowerCase());
            }
            catch {
                set.add(m[1].toLowerCase());
            }
        }
        if (a.control)
            set.add(a.control.toLowerCase()); // an action on a ref: matched by the control's name
        acted.set(rk, set);
    }
    const gaps = (d.behaviour?.routes ?? []).filter((b) => !f || b.route.includes(f)).flatMap((b) => {
        const used = acted.get(b.route.replace(/^\[[^\]]*\] /, '')) ?? new Set();
        const left = b.controls.filter((c) => {
            const raw = /"((?:[^"\\]|\\.)*)"/.exec(c)?.[1] ?? '';
            let n = raw;
            try {
                n = JSON.parse(`"${raw}"`);
            }
            catch { /* keep as shown */ }
            return !!n && !used.has(n.toLowerCase());
        });
        return left.length ? [`${shortRoute(b.route, single)}: ${left.slice(0, 8).join(', ')}${left.length > 8 ? ` +${left.length - 8} more` : ''}`] : [];
    });
    // these sections say nothing when they have nothing: no "none" lines
    const some = (title, items) => (items.length ? section(title, items, (x) => x) : []);
    const behaviourLines = [
        ...some('observed endpoints per action (association by timing unless marked)', perAction),
        ...some('known field constraints (declared in the page: client side; backend enforcement not verified)', fields),
        ...some('unverified: endpoints seen failing (leads, see findings)', failing),
        ...some('shown but not exercised (controls seen in snapshots that no action used, matched by name)', gaps),
    ];
    return [
        `discovery: observed activity of ${d.sessions.length} session(s) ${d.sessions.slice(0, 4).join(', ')}${d.sessions.length > 4 ? ', …' : ''} — what was seen, not coverage of what was not`,
        `${d.routes.length} routes · ${d.endpoints.length} endpoints · ${d.actions.length} actions · ${d.edges.length} edges · ${d.thirdPartyRequests} third-party requests (not listed)${d.truncated ? ` · truncated: ${dropped} items over the caps were dropped` : ''}`,
        single && origins.size ? `origin: ${[...origins][0]}` : '',
        ...section('routes', routes, (r) => `${r.id} ${at(r.origin, r.path)} ×${r.count}`),
        ...section('endpoints', endpoints, (e) => `${e.id} ${e.method} ${at(e.origin, e.path)} → ${e.statuses.join(',') || 'no response'} ×${e.count}${e.background ? ` (${e.background} without an action: background or unknown)` : ''}${e.failed ? ` (${e.failed} failed)` : ''}${shapes(e)}`),
        ...section('edges', edges, (e) => `${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to} · ${e.relation} ×${e.count} (${e.confidence})${e.via?.length ? ` via ${e.via.map((v) => name.get(v) ?? v).join(', ')}` : ''}${e.evidenceIds.length ? ` · ${e.evidenceIds.join(',')}` : ''}`),
        ...behaviourLines,
        d.behaviour?.truncated ? 'behaviour: truncated at its caps (routes, fields or controls per route)' : '',
    ].filter(Boolean).join('\n');
}
/** A behaviour route key ("[context] origin/path") shown short: the path alone when there is one origin. */
function shortRoute(key, single) {
    const m = /^(\[[^\]]*\] )?(https?:\/\/[^/]+)(.*)$/.exec(key);
    return m ? `${m[1] ?? ''}${single ? m[3] || '/' : m[2] + m[3]}` : key;
}
