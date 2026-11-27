import { SEVERITIES } from '../observation/types.js';
import { byImportance } from '../quality/engine.js';
import { describeConfig } from '../config.js';
import { explainFinding } from '../quality/summary.js';
const enc = (view, offset) => Buffer.from(JSON.stringify({ v: view, o: offset })).toString('base64url');
function offsetOf(view, cursor) {
    if (!cursor)
        return 0;
    try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        return c.v === view && Number.isInteger(c.o) && c.o >= 0 ? c.o : 0;
    }
    catch {
        return 0;
    }
}
/** Independent, read-only paging: reading a page never consumes or hides evidence. */
function page(view, items, q) {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const start = offsetOf(view, q.cursor);
    const slice = items.slice(start, start + limit);
    const more = start + slice.length < items.length;
    const next = more ? enc(view, start + slice.length) : undefined;
    return { items: slice, next, footer: `${slice.length ? `${start + 1}–${start + slice.length}` : '0'} of ${items.length}${next ? ` · next: cursor=${next}` : ''}` };
}
const ms = (n) => (n === undefined ? '…' : `${Math.round(n)}ms`);
const short = (rec) => `${rec.method} ${rec.url.replace(rec.origin, '')}`;
export function requestRow(obs, r) {
    const status = r.failure ? (r.aborted ? 'aborted' : `FAILED ${r.failure.replace(/^net::/, '')}`) : r.status ?? 'pending';
    const dur = r.endedMs !== undefined ? ms(r.endedMs - r.startedMs) : r.responseMs !== undefined ? `ttfb ${ms(r.responseMs - r.startedMs)}` : 'in flight';
    return `${r.id} ${short(r)} → ${status} · ${r.resourceType}${r.firstParty ? '' : ' · third-party'} · ${dur} · ${r.pageId ?? '-'} · ${obs.actions.describe(r.association)} — ${r.association.reason}${r.traceId ? ` · trace ${r.traceId}` : ''}`;
}
function eventLine(e) {
    const d = e.data;
    switch (e.kind) {
        case 'request': return `${e.eventId} request ${d.method} ${d.url}${d.redirectedFrom ? ` (redirect of ${d.redirectedFrom})` : ''}`;
        case 'response': return `${e.eventId} response ${d.requestId} status ${d.status} · ttfb ${d.ttfbMs}ms${d.contentType ? ` · ${d.contentType}` : ''}`;
        case 'request_finished': return `${e.eventId} finished ${d.requestId} status ${d.status ?? '-'} · ${d.durationMs}ms`;
        case 'request_failed': return `${e.eventId} failed ${d.requestId} ${d.method} ${d.url} — ${d.errorText}${d.aborted ? ` (abort${d.navigationEvidence ? ', page navigated' : ''})` : ''}`;
        case 'console_error': return `${e.eventId} console.error ${JSON.stringify(d.text)}${d.source ? ` @ ${d.source}` : ''}`;
        case 'page_error': return `${e.eventId} exception ${JSON.stringify(d.message)}${d.stack ? ` @ ${d.stack[0]}` : ''}`;
        default: return `${e.eventId} ${d.type}${d.url ? ` ${d.url}` : ''}`;
    }
}
export function findingDetail(obs, f, withPayload) {
    const out = [
        `${f.id} ${f.severity.toUpperCase()} ${f.ruleId} · ${f.status}${f.statusReason ? ` (${f.statusReason})` : ''} · confidence ${f.confidence} · ×${f.occurrences}${f.late ? ' · late' : ''}`,
        `  ${f.title}`,
        `  expected: ${f.expected ?? 'unknown'} · actual: ${f.actual}`,
        `  association: ${obs.actions.describe(f.association)} — ${f.association.reason}`,
        `  first seen ${f.firstAt}${f.batchId ? ` in ${f.batchId}` : ''}${f.scope ? ` (scope ${f.scope})` : ''}`,
    ];
    const why = explainFinding(obs, f);
    out.push(`  what it may mean: ${why.impact}`, `  safe next check: ${why.next}`);
    if (f.evidenceIds.length) {
        out.push('  events:');
        for (const id of f.evidenceIds.slice(0, 8)) {
            const e = obs.store.get(id);
            out.push('    ' + (e ? eventLine(e) : `${id} (${obs.store.availability(id) === 'evicted' ? 'evicted: over the retention budget' : 'unavailable'})`));
        }
    }
    for (const rid of f.requestIds.slice(0, 3)) {
        const r = obs.requests.get(rid);
        if (!r) {
            out.push(`  request ${rid}: no longer retained`);
            continue;
        }
        out.push(`  request ${requestRow(obs, r)}`);
        if (r.body)
            out.push(`    body: ${r.body.state}${r.body.reason ? ` (${r.body.reason})` : ''}${r.body.bytes !== undefined ? ` ${r.body.bytes} bytes` : ''}${withPayload && r.body.json !== undefined ? ` ${JSON.stringify(r.body.json).slice(0, 1500)}` : ''}`);
        if (withPayload && r.requestShape !== undefined)
            out.push(`    request fields: ${JSON.stringify(r.requestShape).slice(0, 600)}`);
    }
    return out;
}
export function queryEvidence(obs, q) {
    const eng = obs.quality;
    switch (q.view) {
        case 'summary': {
            const cov = obs.coverage();
            const by = (st) => eng.findings.filter((f) => f.status === st);
            const cand = by('candidate');
            const sev = SEVERITIES.slice().reverse().map((s) => [s, cand.filter((f) => f.severity === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ');
            const rules = new Map();
            for (const f of eng.findings)
                rules.set(f.ruleId, (rules.get(f.ruleId) ?? 0) + f.occurrences);
            const pol = eng.policy({ pending: cov.pending, dropped: cov.dropped, final: obs.disposed });
            const lines = [
                `session ${obs.sessionId} · run ${obs.runId} · mode ${obs.cfg.mode} · started ${obs.startedAt.toISOString()}${obs.endedAt ? ` · ended ${obs.endedAt.toISOString()}` : ''}`,
                `requests: ${obs.stats.tracked} observed (document/fetch/xhr; ${obs.stats.firstParty} first-party and ${obs.stats.thirdParty} third-party requests of any type) · pending ${cov.pending}`,
                `events: ${obs.store.size} retained, ${cov.dropped} dropped · coverage ${cov.state} (of what the browser showed; backend-only traffic, service workers and WebSockets are not covered)`,
                `findings: ${cand.length} candidate${sev ? ` (${sev})` : ''} · ${by('expected').length} expected · ${by('suppressed').length} suppressed`,
                rules.size ? `by rule: ${[...rules].map(([k, n]) => `${k} ${n}`).join(', ')}` : '',
                `policy: ${pol.outcome === 'not_enforced' ? `not enforced (${obs.cfg.mode})` : `${pol.outcome}${pol.reasons.length ? ' — ' + pol.reasons.join('; ') : ''}`}`,
                eng.notEvaluated.size ? `not evaluated: ${[...eng.notEvaluated].map(([id, v]) => `${id} — ${v.reason} ×${v.count}`).join('; ')}` : '',
                `payloads: capture ${obs.cfg.capture.payloads}${obs.cfg.capture.payloads === 'json' ? ` · ${obs.stats.bodiesCaptured} captured, ${obs.stats.bodiesSkipped} skipped` : ''}`,
                `first-party origins: ${[...obs.firstParty].join(', ') || 'none yet'}`,
            ];
            return lines.filter(Boolean).join('\n');
        }
        case 'findings': {
            const status = q.status ?? (q.finding ? 'all' : 'candidate');
            const list = eng.findings.filter((f) => (status === 'all' || f.status === status) && (!q.finding || f.id === q.finding) &&
                (!q.batch || f.batchId === q.batch) &&
                (!q.action || f.association.actionId === q.action || !!f.association.candidateActionIds?.includes(q.action)) &&
                (!q.path || !!f.endpoint?.route.includes(q.path))).sort(byImportance);
            if (!list.length)
                return q.finding ? `No finding ${q.finding} in session ${obs.sessionId}.` : `No ${status === 'all' ? '' : status + ' '}findings in session ${obs.sessionId}.`;
            const p = page('findings', list, q);
            const body = p.items.flatMap((f) => (q.details || q.finding ? findingDetail(obs, f, !!q.details) : [`${f.id} ${f.severity.toUpperCase()} ${f.ruleId} ${f.status}${f.statusReason ? ` (${f.statusReason})` : ''} ×${f.occurrences} — ${f.title} — ${obs.actions.describe(f.association)} — ${f.evidenceIds.slice(0, 3).join(',')}`]));
            return `findings ${p.footer} (candidates are leads to verify, not confirmed defects)\n${body.join('\n')}`;
        }
        case 'network': {
            const list = [...obs.requests.values()].filter((r) => (r.tracked || (r.status ?? 0) >= 400 || !!r.failure) && (!q.path || r.path.includes(q.path) || r.url.includes(q.path)) &&
                (!q.batch || r.batchId === q.batch) && (!q.action || r.association.actionId === q.action || !!r.association.candidateActionIds?.includes(q.action)) &&
                (!q.finding || !!eng.findings.find((f) => f.id === q.finding)?.requestIds.includes(r.id)));
            const p = page('network', list, q);
            return `network ${p.footer}\n${p.items.map((r) => requestRow(obs, r) + (q.details && r.body ? `\n    body: ${r.body.state}${r.body.reason ? ` (${r.body.reason})` : ''}${r.body.json !== undefined ? ` ${JSON.stringify(r.body.json).slice(0, 1500)}` : ''}` : '')).join('\n')}`;
        }
        case 'timeline': {
            const rows = [];
            for (const b of obs.actions.batches)
                rows.push({ t: b.startedMs, batch: b.batchId, line: `${b.batchId} ${b.kind}${b.scope ? ` scope=${b.scope}` : ''}${b.ok === false ? ' ✗' : ''}` });
            for (const a of obs.actions.actions)
                rows.push({ t: a.startedMs, action: a.actionId, batch: a.batchId, line: `${a.actionId} ${a.label} ${a.ok === false ? '✗' : '✓'}${a.endedMs !== undefined ? ` (${ms(a.endedMs - a.startedMs)}, ${a.requests} requests)` : ''}` });
            for (const e of obs.store.all())
                rows.push({ t: e.elapsedMs, action: e.action.actionId, batch: e.batchId, line: `  ${eventLine(e)}${e.action.actionId ? ` [${e.action.actionId} ${e.action.confidence}]` : e.action.confidence === 'ambiguous' ? ` [ambiguous ${e.action.candidateActionIds?.join('/')}]` : ''}` });
            const list = rows.filter((r) => (!q.batch || r.batch === q.batch) && (!q.action || r.action === q.action)).sort((a, b) => a.t - b.t);
            const p = page('timeline', list, q);
            return `timeline ${p.footer}${obs.store.dropped ? ` · ${obs.store.dropped} older events dropped` : ''}\n${p.items.map((r) => `+${String(Math.round(r.t)).padStart(6)}ms ${r.line}`).join('\n')}`;
        }
        case 'config':
            return `effective configuration\n${JSON.stringify(describeConfig(obs.cfg), null, 1)}`;
    }
}
