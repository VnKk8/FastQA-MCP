import { sevRank } from '../observation/types.js';
import { endpointMatches, jsonPointer } from '../util/paths.js';
export const RULES = [
    { id: 'NET-5XX', version: 1, description: 'First-party HTTP 5xx response' },
    { id: 'NET-FAIL', version: 1, description: 'First-party request failed at transport level (not an abort)' },
    { id: 'NET-4XX', version: 1, description: 'First-party HTTP 4xx response that no policy or assertion declared as expected' },
    { id: 'JS-EXCEPTION', version: 1, description: 'Uncaught exception in the page' },
    { id: 'CONSOLE-ERROR', version: 1, description: 'console.error from the page' },
    { id: 'BUSINESS-ERROR', version: 1, description: 'Configured response invariant violated (needs payload capture)' },
    { id: 'CONTRACT-STATUS', version: 1, description: 'Response status not documented in the configured OpenAPI contract' },
    { id: 'CONTRACT-MEDIA', version: 1, description: 'Response media type not documented in the configured OpenAPI contract' },
    { id: 'CONTRACT-SCHEMA', version: 1, description: 'Response body does not match the configured OpenAPI schema (needs payload capture)' },
    { id: 'PERF-SLOW', version: 1, description: 'Response slower than a configured threshold' },
    { id: 'PERF-BASELINE', version: 1, description: 'Response slower than the recorded baseline for this environment' },
    { id: 'PERF-CALLS', version: 1, description: 'Endpoint called more often than the configured limit' },
    { id: 'STATE-INVARIANT', version: 1, description: 'Configured UI state expectation not met after a matching response' },
];
const ruleVersion = (id) => RULES.find((r) => r.id === id)?.version ?? 1;
const confidenceOf = (a) => (a.confidence === 'direct' ? 'high' : a.confidence === 'inferred' ? 'medium' : 'low');
const normText = (s) => s.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 140);
export class QualityEngine {
    cfg;
    ctx;
    findings = [];
    byFp = new Map();
    n = 0;
    /** rule or check id -> why it could not be evaluated (e.g. payload not captured) */
    notEvaluated = new Map();
    /** findings with id counter above this were not yet shown inline */
    shown = 0;
    repeats = 0;
    expectedMarks = new Set();
    calls = new Map();
    stateChecks = [];
    contract;
    baseline;
    enabled;
    constructor(cfg, ctx) {
        this.cfg = cfg;
        this.ctx = ctx;
        this.enabled = cfg.mode !== 'off';
    }
    // ---------------------------------------------------------------- detectors
    onRequestStart(rec) {
        const limits = this.cfg.performance?.maxCalls;
        if (!this.enabled || !limits || !rec.firstParty || !rec.tracked)
            return;
        limits.forEach((l, i) => {
            if (!endpointMatches(l, rec.method, rec.path))
                return;
            const per = l.per ?? 'action';
            const scope = per === 'action' ? rec.association.actionId : rec.batchId;
            if (!scope)
                return;
            const key = `${i}|${scope}`;
            const count = (this.calls.get(key) ?? 0) + 1;
            this.calls.set(key, count);
            if (count === l.max + 1)
                this.report({
                    ruleId: 'PERF-CALLS', severity: 'low', rec, association: rec.association, signature: `${per}`,
                    title: `${rec.method} ${rec.route} called more than ${l.max}× in one ${per}`, actual: `${count} calls in ${scope}`, expected: `at most ${l.max} per ${per} (configured)`,
                });
        });
    }
    onResponse(rec, ev) {
        if (!this.enabled || !rec.firstParty || rec.status === undefined)
            return;
        const st = rec.status;
        if (/favicon/.test(rec.path))
            return;
        if (st >= 500) {
            this.report({
                ruleId: 'NET-5XX', severity: rec.tracked ? 'high' : 'medium', rec, ev, association: rec.association, signature: String(st),
                title: `${rec.method} ${rec.route} returned ${st}`, actual: `HTTP ${st}`, expected: 'no server error',
            });
        }
        else if (st >= 400) {
            // 401/403 are routinely probed by apps (session checks), so they stay informational.
            const sev = st === 401 || st === 403 ? 'info' : 'low';
            this.report({
                ruleId: 'NET-4XX', severity: sev, rec, ev, association: rec.association, signature: String(st),
                title: `${rec.method} ${rec.route} returned ${st}`, actual: `HTTP ${st}`, expected: 'no client error, unless this is a negative test',
            });
        }
        // a server error is already NET-5XX; reporting "500 is not documented" on top would only be noise
        if (this.contract && rec.tracked && rec.resourceType !== 'document' && st < 500)
            this.contractIssues(this.contract.checkResponse(rec), rec, ev);
        for (const r of this.cfg.stateRules) {
            if (!endpointMatches(r.after, rec.method, rec.path) || (r.after.status !== undefined ? r.after.status !== st : st >= 400))
                continue;
            if (this.stateChecks.length < 20)
                this.stateChecks.push({ ruleId: r.id, rec, expectText: r.expectText, expectNoText: r.expectNoText, withinMs: r.withinMs ?? 2000, severity: r.severity ?? 'medium' });
        }
    }
    onFinished(rec, ev) {
        if (!this.enabled || !rec.firstParty || !rec.tracked || rec.endedMs === undefined)
            return;
        const ms = Math.round(rec.endedMs - rec.startedMs);
        const p = this.cfg.performance;
        const limit = p?.endpoints?.find((e) => endpointMatches(e, rec.method, rec.path))?.maxMs ?? p?.slowMs;
        if (limit !== undefined && ms > limit) {
            this.report({
                ruleId: 'PERF-SLOW', severity: 'low', rec, ev, association: rec.association, signature: 'slow',
                title: `${rec.method} ${rec.route} took ${ms}ms (limit ${limit}ms)`, actual: `${ms}ms`, expected: `at most ${limit}ms (configured)`,
            });
        }
        const base = this.baseline?.limitFor(rec.method, rec.route);
        if (base && ms > base.limitMs) {
            this.report({
                ruleId: 'PERF-BASELINE', severity: 'low', rec, ev, association: rec.association, signature: 'baseline',
                title: `${rec.method} ${rec.route} took ${ms}ms, baseline median ${Math.round(base.medianMs)}ms`,
                actual: `${ms}ms`, expected: `at most ${Math.round(base.limitMs)}ms (baseline of ${base.samples} samples)`,
            });
        }
    }
    onFailed(rec, ev) {
        if (!this.enabled || !rec.firstParty || rec.aborted)
            return;
        const err = (rec.failure ?? 'failed').replace(/^net::/, '');
        this.report({
            ruleId: 'NET-FAIL', severity: rec.tracked ? 'medium' : 'low', rec, ev, association: rec.association, signature: err,
            title: `${rec.method} ${rec.route} failed: ${err}`, actual: `no response (${err})`, expected: 'a response',
        });
    }
    onPageError(ev) {
        if (!this.enabled)
            return;
        const msg = String(ev.data.message ?? '');
        this.report({
            ruleId: 'JS-EXCEPTION', severity: 'medium', ev, association: ev.action, signature: normText(msg),
            title: `Uncaught exception: ${msg.slice(0, 120)}`, actual: msg.slice(0, 300), expected: 'no uncaught exception',
            confidence: ev.action.confidence === 'unattributed' ? 'medium' : 'high',
        });
    }
    onConsoleError(ev) {
        if (!this.enabled)
            return;
        const text = String(ev.data.text ?? '');
        if (/Failed to load resource/.test(text))
            return; // the request itself is covered by NET-*
        this.report({
            ruleId: 'CONSOLE-ERROR', severity: 'low', ev, association: ev.action, signature: normText(text), confidence: 'low',
            title: `console.error: ${text.slice(0, 120)}`, actual: text.slice(0, 300), expected: 'no console errors',
        });
    }
    /** True when a rule needs this response body. Lets the observer explain why a rule was not evaluated. */
    wantsBody(rec) {
        return this.cfg.businessRules.some((r) => endpointMatches(r, rec.method, rec.path)) || !!this.contract?.wantsBody(rec);
    }
    /** Called once per response when the body is final: captured (raw JSON passed, not retained here), skipped or failed. */
    onBody(rec, raw) {
        if (!this.enabled)
            return;
        const captured = rec.body?.state === 'captured';
        for (const r of this.cfg.businessRules) {
            if (!endpointMatches(r, rec.method, rec.path))
                continue;
            if (r.status !== undefined && r.status !== rec.status)
                continue;
            if (!captured) {
                this.skip(r.id, `response body not available (${rec.body?.reason ?? rec.body?.state ?? 'capture off'})`);
                continue;
            }
            const got = jsonPointer(raw, r.jsonPointer);
            let ok = true;
            let expected = '';
            if (r.exists !== undefined) {
                ok = got.found === r.exists;
                expected = `${r.jsonPointer} ${r.exists ? 'present' : 'absent'}`;
            }
            if (ok && 'equals' in r && r.equals !== undefined) {
                ok = got.found && same(got.value, r.equals);
                expected = `${r.jsonPointer} = ${show(r.equals)}`;
            }
            if (ok && 'notEquals' in r && r.notEquals !== undefined) {
                ok = !got.found || !same(got.value, r.notEquals);
                expected = `${r.jsonPointer} ≠ ${show(r.notEquals)}`;
            }
            if (ok)
                continue;
            const actual = got.found ? `${r.jsonPointer} = ${show(got.value)}` : `${r.jsonPointer} is missing`;
            this.report({
                ruleId: 'BUSINESS-ERROR', severity: r.severity ?? 'high', rec, association: rec.association, signature: r.id,
                title: `${r.id}: ${rec.method} ${rec.route} → HTTP ${rec.status} but ${actual}`, actual, expected: `${expected} (configured rule ${r.id})`,
            });
        }
        if (this.contract?.wantsBody(rec)) {
            if (captured)
                this.contractIssues(this.contract.checkBody(rec, raw), rec);
            else
                this.skip('CONTRACT-SCHEMA', `response body not available (${rec.body?.reason ?? rec.body?.state ?? 'capture off'})`);
        }
    }
    contractIssues(out, rec, ev) {
        if (out.notEvaluated)
            this.skip(`CONTRACT:${rec.method} ${rec.route}`, out.notEvaluated);
        for (const i of out.issues) {
            const ruleId = i.kind === 'status' ? 'CONTRACT-STATUS' : i.kind === 'media' ? 'CONTRACT-MEDIA' : 'CONTRACT-SCHEMA';
            this.report({
                ruleId, severity: i.kind === 'media' ? 'low' : 'medium', rec, ev, association: rec.association, signature: i.signature,
                title: `${rec.method} ${rec.route}: ${i.message}`, actual: i.actual, expected: i.expected,
            });
        }
    }
    stateViolation(c, actual) {
        this.report({
            ruleId: 'STATE-INVARIANT', severity: c.severity, rec: c.rec, association: c.rec.association, signature: c.ruleId,
            title: `${c.ruleId}: after ${c.rec.method} ${c.rec.route} → ${c.rec.status}, ${actual}`,
            actual, expected: c.expectText !== undefined ? `text ${JSON.stringify(c.expectText)} visible within ${c.withinMs}ms (configured rule ${c.ruleId})` : `text ${JSON.stringify(c.expectNoText)} not visible (configured rule ${c.ruleId})`,
        });
    }
    skip(id, reason) {
        const e = this.notEvaluated.get(id);
        if (e)
            e.count++;
        else if (this.notEvaluated.size < 100)
            this.notEvaluated.set(id, { reason, count: 1 });
    }
    // ---------------------------------------------------------------- lifecycle
    report(d) {
        const rec = d.rec;
        const fp = `${d.ruleId}|${rec ? `${rec.method} ${rec.origin}${rec.route}` : ''}|${d.signature}`;
        const policy = this.classify(d);
        const seq = d.ev?.sequence ?? 0;
        const at = d.ev?.at ?? new Date().toISOString();
        const evIds = d.ev ? [d.ev.eventId] : rec ? rec.eventIds.slice(-2) : [];
        let f = this.byFp.get(fp);
        if (f) {
            f.occurrences++;
            f.lastSequence = seq || f.lastSequence;
            f.lastAt = at;
            for (const id of evIds)
                if (!f.evidenceIds.includes(id))
                    f.evidenceIds.push(id);
            if (f.evidenceIds.length > 12)
                f.evidenceIds.splice(4, f.evidenceIds.length - 12); // keep the first and the latest samples
            if (rec && !f.requestIds.includes(rec.id)) {
                f.requestIds.push(rec.id);
                if (f.requestIds.length > 12)
                    f.requestIds.splice(4, 1);
            }
            // a later occurrence without a clear action (background, ambiguous) lowers the confidence of the whole finding
            const conf = d.confidence ?? confidenceOf(d.association);
            if (confRank[conf] < confRank[f.confidence]) {
                f.confidence = conf;
                f.association = d.association;
            }
            if (policy.status === 'expected')
                f.expectedOccurrences++;
            if (policy.status === 'suppressed') {
                f.status = 'suppressed';
                f.statusReason = policy.reason;
            }
            else
                this.restatus(f, policy.reason);
            this.repeats++;
            return f;
        }
        const batchId = rec?.batchId ?? d.ev?.batchId;
        f = {
            schemaVersion: 1, id: `F-${String(++this.n).padStart(3, '0')}`, ruleId: d.ruleId, ruleVersion: ruleVersion(d.ruleId),
            severity: d.severity, confidence: d.confidence ?? confidenceOf(d.association),
            status: policy.status, statusReason: policy.reason,
            title: d.title, expected: d.expected, actual: d.actual, association: d.association,
            batchId, scope: this.ctx.scopeOf(batchId), evidenceIds: evIds, requestIds: rec ? [rec.id] : [],
            fingerprint: fp, occurrences: 1, expectedOccurrences: policy.status === 'expected' ? 1 : 0,
            firstSequence: seq, lastSequence: seq, firstAt: at, lastAt: at,
            late: batchId !== undefined && batchId !== this.ctx.currentBatchId() ? true : undefined,
            endpoint: rec ? { method: rec.method, route: rec.route, origin: rec.origin, status: rec.status } : undefined,
        };
        this.findings.push(f);
        this.byFp.set(fp, f);
        return f;
    }
    classify(d) {
        const rec = d.rec;
        const today = new Date().toISOString().slice(0, 10);
        for (const s of this.cfg.suppressions) {
            if (s.expires && s.expires.slice(0, 10) < today)
                continue;
            if (!s.ruleId && !s.path)
                continue; // a suppression must name what it suppresses
            if (s.ruleId && s.ruleId !== d.ruleId)
                continue;
            if (s.path && !(rec && endpointMatches({ method: s.method, path: s.path }, rec.method, rec.path)))
                continue;
            return { status: 'suppressed', reason: `known issue ${s.id}: ${s.reason}` };
        }
        if (rec && rec.status !== undefined && (d.ruleId === 'NET-4XX' || d.ruleId === 'NET-5XX')) {
            const scope = this.ctx.scopeOf(rec.batchId);
            for (const e of this.cfg.expectedResponses) {
                if (e.scope === scope && e.statuses.includes(rec.status) && endpointMatches(e, rec.method, rec.path))
                    return { status: 'expected', reason: `policy (${e.scope}): ${e.reason}` };
            }
        }
        return { status: 'candidate' };
    }
    restatus(f, reason) {
        if (f.status === 'suppressed')
            return;
        const expected = f.expectedOccurrences >= f.occurrences;
        f.status = expected ? 'expected' : 'candidate';
        if (expected && reason)
            f.statusReason = reason;
        if (!expected)
            f.statusReason = f.expectedOccurrences ? `${f.expectedOccurrences} of ${f.occurrences} occurrences were expected` : undefined;
    }
    /** An explicit expect_request assertion passed on this response: the agent declared it as expected (a negative test). */
    markExpected(requestId, reason) {
        for (const f of this.findings) {
            if ((f.ruleId !== 'NET-4XX' && f.ruleId !== 'NET-5XX') || !f.requestIds.includes(requestId))
                continue;
            const key = `${f.id}|${requestId}`;
            if (this.expectedMarks.has(key))
                continue;
            this.expectedMarks.add(key);
            f.expectedOccurrences++;
            this.restatus(f, reason);
        }
    }
    // ---------------------------------------------------------------- views
    candidates(min = 'info') { return this.findings.filter((f) => f.status === 'candidate' && sevRank(f.severity) >= sevRank(min)); }
    /** Findings not yet shown inline, most important first, and marks them shown. */
    takeNew() {
        const fresh = this.findings.filter((f) => Number(f.id.slice(2)) > this.shown && f.status === 'candidate').sort(byImportance);
        this.shown = this.n;
        const repeats = this.repeats;
        this.repeats = 0;
        return { fresh, repeats };
    }
    policy(o) {
        if (!this.cfg.enforce)
            return { outcome: 'not_enforced', failing: [], reasons: [] };
        const pool = (o.findings ?? this.findings).filter((f) => f.status === 'candidate');
        const failing = pool.filter((f) => sevRank(f.severity) >= sevRank(this.cfg.failOnSeverity)).sort(byImportance);
        const reasons = failing.length ? [`${failing.length} finding(s) at or above "${this.cfg.failOnSeverity}"`] : [];
        if (o.final && o.pending > 0 && this.cfg.onIncomplete === 'fail')
            reasons.push(`observation incomplete: ${o.pending} request(s) still pending at finalization`);
        if (reasons.length)
            return { outcome: 'failed', failing, reasons };
        if (!o.final && o.pending > 0)
            return { outcome: 'provisional', failing, reasons: [`${o.pending} request(s) still pending`] };
        return { outcome: 'passed', failing, reasons };
    }
}
const confRank = { low: 0, medium: 1, high: 2 };
export const byImportance = (a, b) => sevRank(b.severity) - sevRank(a.severity) || confRank[b.confidence] - confRank[a.confidence] || a.firstSequence - b.firstSequence;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => { const s = JSON.stringify(v) ?? 'undefined'; return s.length > 60 ? s.slice(0, 57) + '…' : s; };
