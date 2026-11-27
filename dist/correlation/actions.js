/** Steps that drive the page. Assertions and waits are passive: they never count as the origin of a request. */
export const INTERACTIVE = /^(goto|click|dblclick|hover|fill|type|press|select|check|uncheck|upload)$/;
const MAX_ACTIONS = 1000;
/** A request that starts while the step itself executes, or this soon after it returned, is driven by that step. */
const PROMPT_MS = 100;
/**
 * Tracks batch and action scopes and decides, at the moment a request starts, which action it belongs to.
 * The decision is made once, at request start, and never changes when the response arrives:
 * a response that lands while a later step runs still belongs to the action that started the request.
 *
 * Rules (temporal association only; this is not proof of causality):
 *  - the main-frame navigation an action explicitly asked for (goto / open)      -> direct
 *  - request starts while the step executes (or within 100 ms of its return)     -> inferred to it; never treated as
 *    background, because that is exactly when a step's own requests start
 *  - request starts later: during the settle phase of the action, or shortly
 *    after the latest interactive action ended (window)                           -> inferred to it, delay stated,
 *    unless the endpoint is known background or periodic traffic                   -> ambiguous
 *  - another recent action still has requests in flight                          -> ambiguous, candidates listed
 *  - nothing recent                                                                -> unattributed
 */
export class ActionTracker {
    windowMs;
    now;
    batches = [];
    actions = [];
    byId = new Map();
    current;
    currentBatch;
    nBatch = 0;
    nAction = 0;
    /** endpoint key -> number of starts that no action could explain */
    background = new Map();
    /** endpoint key -> its latest start times outside a step's own execution, to recognise periodic traffic (polling) */
    starts = new Map();
    navigationClaimed = false;
    /** batches up to this number have had their result returned to the caller */
    reportedN = 0;
    constructor(windowMs, now) {
        this.windowMs = windowMs;
        this.now = now;
    }
    beginBatch(kind, scope) {
        const b = { batchId: `B-${++this.nBatch}`, kind, scope, startedMs: this.now(), actions: 0 };
        this.batches.push(b);
        if (this.batches.length > 300)
            this.batches.shift();
        this.currentBatch = b;
        return b;
    }
    endBatch(b, ok) { b.endedMs = this.now(); b.ok = ok; if (this.currentBatch === b)
        this.currentBatch = undefined; }
    /** Call when a result that covers every ended batch is handed back. A finding that turns up afterwards is "late". */
    markReported() { this.reportedN = this.currentBatch ? this.nBatch - 1 : this.nBatch; }
    isReported(batchId) { return !!batchId && Number(batchId.slice(2)) <= this.reportedN; }
    beginAction(kind, label, pageId) {
        const b = this.currentBatch;
        const a = {
            actionId: `A-${++this.nAction}`, batchId: b.batchId, index: ++b.actions, do: kind, label,
            interactive: INTERACTIVE.test(kind), pageId, startedMs: this.now(), inflight: 0, requests: 0,
        };
        this.actions.push(a);
        this.byId.set(a.actionId, a);
        if (this.actions.length > MAX_ACTIONS) {
            const old = this.actions.shift();
            this.byId.delete(old.actionId);
        }
        this.current = a;
        this.navigationClaimed = false;
        return a;
    }
    /** The step itself has returned; the settle phase begins. */
    executed(a) { a.executedMs = this.now(); }
    endAction(a, ok) { a.endedMs = this.now(); a.executedMs ??= a.endedMs; a.ok = ok; if (this.current === a)
        this.current = undefined; }
    get(id) { return id ? this.byId.get(id) : undefined; }
    /** scope labels that policy rules can match: the batch scope (flow name or act scope) */
    scopeOf(batchId) { return this.batches.find((b) => b.batchId === batchId)?.scope; }
    associate(o) {
        const now = this.now();
        const cur = this.current?.interactive ? this.current : undefined;
        if (cur && o.mainFrameNavigation && cur.do === 'goto' && !this.navigationClaimed) {
            this.navigationClaimed = true;
            cur.requests++;
            return { actionId: cur.actionId, confidence: 'direct', reason: 'navigation requested by the action' };
        }
        // the step's own requests start while it executes: these are never demoted to background or periodic traffic
        const prompt = !!cur && (cur.executedMs === undefined || now - cur.executedMs <= PROMPT_MS);
        // interactive actions that ended inside the window, most recent first
        const recent = [];
        for (let i = this.actions.length - 1; i >= 0 && recent.length < 4; i--) {
            const a = this.actions[i];
            if (a === cur || !a.interactive || a.endedMs === undefined)
                continue;
            if (now - a.endedMs > this.windowMs)
                break;
            recent.push(a);
        }
        const every = prompt ? 0 : this.periodic(o.endpointKey, now);
        const primary = cur ?? recent[0];
        if (!primary) {
            if (this.background.size < 500 || this.background.has(o.endpointKey))
                this.background.set(o.endpointKey, (this.background.get(o.endpointKey) ?? 0) + 1);
            return { confidence: 'unattributed', reason: this.current ? 'started during a passive step with no recent interactive action' : 'no action in progress (background or page-initiated)' };
        }
        const bg = prompt ? 0 : this.background.get(o.endpointKey) ?? 0;
        const competing = recent.filter((a) => a !== primary && a.inflight > 0);
        if (bg >= 2 || every || competing.length) {
            const ids = [primary, ...competing].map((a) => a.actionId);
            const reason = bg >= 2
                ? `endpoint also fires as background traffic (${bg} earlier starts without an action)`
                : every ? `endpoint fires periodically (about every ${every}ms): likely background traffic`
                    : `${competing.map((a) => a.actionId).join(', ')} still had requests in flight when this one started`;
            primary.requests++;
            return { candidateActionIds: ids, confidence: 'ambiguous', reason };
        }
        const reason = primary === cur
            ? (prompt ? 'request started during the action' : `request started ${Math.round(now - cur.executedMs)}ms after the step returned, while the page settled`)
            : `request started ${Math.round(now - primary.endedMs)}ms after the action ended`;
        primary.requests++;
        return { actionId: primary.actionId, confidence: 'inferred', reason };
    }
    /**
     * Polling starts at a steady rhythm no matter what the user does. Four starts of one endpoint at near-constant
     * intervals (outside a step's own execution) mark it as periodic; from then on its starts are not blamed on
     * whichever action happens to run. Returns the interval in ms, or 0.
     */
    periodic(key, now) {
        let t = this.starts.get(key);
        if (!t) {
            if (this.starts.size >= 500)
                return 0;
            this.starts.set(key, (t = []));
        }
        t.push(now);
        if (t.length > 4)
            t.shift();
        if (t.length < 4)
            return 0;
        const gaps = [t[1] - t[0], t[2] - t[1], t[3] - t[2]];
        const mean = (gaps[0] + gaps[1] + gaps[2]) / 3;
        return mean >= 80 && gaps.every((g) => Math.abs(g - mean) <= mean * 0.3) ? Math.round(mean) : 0;
    }
    /** A request attributed to one action is in flight. Returns true when the action was found, so the caller can release it later. */
    hold(assoc) {
        const a = assoc.actionId ? this.byId.get(assoc.actionId) : undefined;
        if (a)
            a.inflight++;
        return !!a;
    }
    /** call when a held request gets its response or fails */
    release(assoc) {
        const a = assoc.actionId ? this.byId.get(assoc.actionId) : undefined;
        if (a && a.inflight > 0)
            a.inflight--;
    }
    /** Association for something that is not a request (a page error, a console error). */
    associateMoment() {
        const now = this.now();
        const cur = this.current?.interactive ? this.current : undefined;
        if (cur)
            return { actionId: cur.actionId, confidence: 'inferred', reason: 'happened during the action' };
        for (let i = this.actions.length - 1; i >= 0; i--) {
            const a = this.actions[i];
            if (!a.interactive || a.endedMs === undefined)
                continue;
            if (now - a.endedMs > this.windowMs)
                break;
            return { actionId: a.actionId, confidence: 'inferred', reason: `happened ${Math.round(now - a.endedMs)}ms after the action ended` };
        }
        return { confidence: 'unattributed', reason: 'no action in progress' };
    }
    describe(assoc) {
        const one = (id) => { const a = this.byId.get(id); return a ? `${id} ${a.label}` : id; };
        if (assoc.actionId)
            return `${one(assoc.actionId)} (${assoc.confidence})`;
        if (assoc.candidateActionIds?.length)
            return `${assoc.candidateActionIds.map(one).join(' or ')} (ambiguous)`;
        return 'no action (unattributed)';
    }
}
