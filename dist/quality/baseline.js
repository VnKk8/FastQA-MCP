// Baselines, recorded explicitly and only then compared. Two kinds:
//  - response times per endpoint (PERF-BASELINE): `fastqa-mcp run <flow> --baseline=record --repeat=5`
//  - the observable behaviour of a saved journey: which actions ran, which first-party calls each one made with which
//    status class, what the person was told, the assertions and findings. A reference is observed behaviour, not a
//    specification: a difference is a change to investigate, never a defect by itself.
// Both are scoped: application origin, environment label, device and role label. An unknown environment or role stays
// "unknown"; it is never guessed from credentials. Checking never writes; only an explicit record does.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FLOW_DIR, writeAtomic } from '../dirs.js';
/** "https://shop.test | env staging | desktop | role viewer" */
export const scopeKey = (s) => `${s.origin || 'unknown origin'} | env ${s.env || 'unknown'} | ${s.device || 'desktop'} | role ${s.role || 'unknown'}`;
export const baselinePath = () => path.join(FLOW_DIR(), 'baselines', 'perf.json');
export const behaviourPath = () => path.join(FLOW_DIR(), 'baselines', 'behaviour.json');
const DEFAULTS = { factor: 2, minDeltaMs: 200, minSamples: 5 };
const key = (method, route) => `${method} ${route}`;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const machine = () => `${process.platform} ${process.arch} node ${process.version}`;
/** The scope of a finished session: its first-party origins (sorted), device and the labels given for the run. */
export function scopeOf(obs, o = {}) {
    const label = (v) => (typeof v === 'string' ? v : '');
    return { origin: [...obs.firstParty].sort().join(' '), env: o.env ?? label(obs.environment.env), device: String(obs.environment.device ?? 'desktop'), role: o.role ?? label(obs.environment.role) };
}
/**
 * Durations of successful first-party API calls per endpoint (method + normalized path), across the given sessions.
 * Failed calls are left out: an error is not a latency sample. (Identical successful calls, such as one GraphQL query
 * sent twice, are normal samples.)
 */
export function collectDurations(observers) {
    const out = new Map();
    for (const o of observers) {
        for (const r of o.requests.values()) {
            if (!r.tracked || !r.firstParty || r.resourceType === 'document' || r.endedMs === undefined || r.failure || (r.status ?? 0) >= 400)
                continue;
            const k = key(r.method, r.route);
            const list = out.get(k) ?? [];
            list.push(r.endedMs - r.startedMs);
            out.set(k, list);
        }
    }
    return out;
}
function readPerf() {
    try {
        const f = JSON.parse(readFileSync(baselinePath(), 'utf8'));
        return f?.schemaVersion === 1 || f?.schemaVersion === 2 ? f : undefined;
    }
    catch {
        return undefined;
    }
}
/** Records response-time baselines per scope. Other scopes in the file are kept; a 1.0 file is kept as "legacy". */
export async function recordBaseline(observers, o = {}) {
    const minSamples = o.minSamples ?? DEFAULTS.minSamples;
    // samples are grouped by their own scope: runs against two hosts never pool into one entry
    const groups = new Map();
    for (const obs of observers) {
        const k = scopeKey(scopeOf(obs, o));
        groups.set(k, [...(groups.get(k) ?? []), obs]);
    }
    const prev = readPerf();
    const file = prev?.schemaVersion === 2 ? prev : {
        schemaVersion: 2, note: 'Response times per scope (origin, environment, device, role). Compare runs on the same machine, browser and network.', scopes: {},
        ...(prev?.schemaVersion === 1 ? { legacy: { recordedAt: prev.recordedAt, machine: prev.environment, entries: prev.entries } } : {}),
    };
    const lines = [];
    for (const [scope, obs] of groups) {
        const entries = {};
        const thin = [];
        for (const [k, list] of collectDurations(obs)) {
            if (list.length < minSamples) {
                thin.push(`${k} (${list.length})`);
                continue;
            }
            const s = [...list].sort((a, b) => a - b);
            entries[k] = { samples: s.length, medianMs: +pct(s, 0.5).toFixed(1), p95Ms: +pct(s, 0.95).toFixed(1) };
        }
        file.scopes[scope] = { recordedAt: new Date().toISOString(), machine: machine(), entries };
        const n = Object.keys(entries).length;
        lines.push(`baseline: recorded ${n} endpoint${n === 1 ? '' : 's'} for ${scope} to ${baselinePath()}`);
        if (thin.length)
            lines.push(`baseline: skipped (fewer than ${minSamples} samples; use --repeat): ${thin.slice(0, 8).join(', ')}${thin.length > 8 ? ` +${thin.length - 8} more` : ''}`);
    }
    if (!groups.size)
        lines.push('baseline: no samples to record');
    await writeAtomic(baselinePath(), JSON.stringify(file, null, 2) + '\n');
    return lines.join('\n');
}
const warnedLegacy = { done: false };
/**
 * Limits for one scope. undefined when no baseline exists for it, or the file cannot be read: then nothing is compared.
 * A 1.0 file (no scope) is still compared as before, with a one-time warning that it cannot tell hosts apart.
 */
export function loadBaseline(cfg, scope) {
    const file = readPerf();
    if (!file)
        return undefined;
    let entries;
    if (file.schemaVersion === 1) {
        entries = file.entries;
        if (!warnedLegacy.done) {
            warnedLegacy.done = true;
            console.error('fastqa: baselines/perf.json was recorded by 1.0 without a scope (origin, environment, device, role); it is compared anyway. Record it again to scope it.');
        }
    }
    else if (scope) {
        entries = file.scopes[scope]?.entries;
    }
    else {
        // no scope known yet (interactive session): only an unambiguous file is used
        const all = Object.values(file.scopes);
        entries = all.length === 1 ? all[0].entries : undefined;
    }
    if (!entries)
        return undefined;
    const e0 = entries;
    const o = { ...DEFAULTS, ...cfg.performance?.baseline };
    return {
        limitFor(method, route) {
            const e = e0[key(method, route)];
            if (!e || e.samples < o.minSamples)
                return undefined;
            return { limitMs: Math.max(e.p95Ms * o.factor, e.medianMs + o.minDeltaMs), medianMs: e.medianMs, samples: e.samples };
        },
    };
}
/**
 * A baseline looked up lazily by scope: once per scope key, misses included (no file read per request). The key is
 * asked at each lookup (cheap) and the baseline loaded again only when it changed, e.g. a flow reached a second origin.
 */
export function memoBaseline(scope, load, onMiss) {
    let cached;
    return {
        limitFor(method, route) {
            const k = scope();
            if (!cached || cached.key !== k) {
                cached = { key: k, base: load(k) };
                if (!cached.base)
                    onMiss?.(k);
            }
            return cached.base?.limitFor(method, route);
        },
    };
}
const statusClass = (r) => r.failure ? (r.aborted ? 'aborted' : 'failed') : r.status === undefined ? 'pending' : `${Math.floor(r.status / 100)}xx`;
/** The compact signature of a finished run: actions in order, their first-party API calls and feedback. No bodies, no values. */
export function signatureOf(obs, b) {
    const actions = [];
    for (const a of obs.actions.actions) {
        if (b.batchId && a.batchId !== b.batchId)
            continue;
        if (!a.interactive || actions.length >= 200)
            continue;
        const calls = {};
        for (const r of obs.requestsOf(a.actionId)) {
            if (r.navigation || r.resourceType === 'document')
                continue;
            const k = `${r.method} ${r.route}`;
            const c = statusClass(r);
            calls[k] = calls[k] && calls[k] !== c ? [...new Set([...calls[k].split(','), c])].sort().join(',') : c;
            if (Object.keys(calls).length >= 30)
                break;
        }
        actions.push({ label: a.label, calls, told: [...(a.told ?? [])].sort() });
    }
    const findings = [...new Set(obs.quality.findings.filter((f) => f.status === 'candidate').map((f) => f.ruleId))].sort();
    return { version: 1, actions, assertions: b.assertions, findings, coverage: obs.coverage().state };
}
export function readBehaviour() {
    try {
        const f = JSON.parse(readFileSync(behaviourPath(), 'utf8'));
        return f?.schemaVersion === 1 && f.kind === 'fastqa-behaviour' ? f : undefined;
    }
    catch {
        return undefined;
    }
}
const journeyKey = (scope, flow) => `${scope} | flow ${flow}`;
/** Records references from finished runs (grouped by scope and flow). Other journeys in the file are kept. */
export async function recordBehaviour(runs) {
    const file = readBehaviour() ?? { schemaVersion: 1, kind: 'fastqa-behaviour', note: 'Observed behaviour per journey and scope: a reference to compare with, not a specification.', journeys: {} };
    const groups = new Map();
    for (const r of runs) {
        if (!r.signature || !r.stepsOk || r.signature.coverage !== 'complete')
            continue; // an incomplete or failed run is not a reference
        const k = journeyKey(r.scope, r.flow);
        groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const lines = [];
    for (const [k, list] of groups) {
        const first = list[0].signature;
        // samples whose action sequence differs from the first are not pooled: a journey that changed shape is not one reference
        const same = list.filter((r) => r.signature.actions.map((a) => a.label).join('\n') === first.actions.map((a) => a.label).join('\n'));
        const ref = {
            scope: list[0].scope, flow: list[0].flow, recordedAt: new Date().toISOString(), samples: same.length,
            actions: first.actions.map((a) => ({ label: a.label, calls: {}, told: {} })),
            assertions: first.assertions, findings: {},
        };
        for (const r of same) {
            r.signature.actions.forEach((a, i) => {
                const into = ref.actions[i];
                for (const [call, classes] of Object.entries(a.calls)) {
                    const c = (into.calls[call] ??= { seen: 0, classes: {} });
                    c.seen++;
                    for (const cl of classes.split(','))
                        c.classes[cl] = (c.classes[cl] ?? 0) + 1;
                }
                for (const t of a.told)
                    into.told[t] = (into.told[t] ?? 0) + 1;
            });
            for (const f of r.signature.findings)
                ref.findings[f] = (ref.findings[f] ?? 0) + 1;
        }
        file.journeys[k] = ref;
        lines.push(`behaviour: recorded the reference of flow ${ref.flow} (${ref.samples} sample${ref.samples === 1 ? '' : 's'}${same.length < list.length ? `, ${list.length - same.length} with other steps left out` : ''}) for ${ref.scope}`);
    }
    if (!groups.size)
        lines.push('behaviour: nothing recorded (only complete runs whose steps passed become a reference)');
    else
        await writeAtomic(behaviourPath(), JSON.stringify(file, null, 2) + '\n');
    return lines.join('\n');
}
export function compareBehaviour(file, flow, scope, sig) {
    const ref = file?.journeys[journeyKey(scope, flow)];
    if (!ref) {
        const other = file ? Object.values(file.journeys).filter((j) => j.flow === flow).map((j) => j.scope) : [];
        return { status: 'no reference', lines: [`behaviour: no reference for flow ${flow} in ${scope}${other.length ? ` (references exist for: ${other.slice(0, 3).join('; ')}; different scopes are never compared)` : ''}`] };
    }
    if (sig.coverage !== 'complete')
        return { status: 'not comparable', lines: ['behaviour: not comparable: the observation of this run is incomplete (pending requests or dropped events)'] };
    if (sig.actions.map((a) => a.label).join('\n') !== ref.actions.map((a) => a.label).join('\n')) {
        return { status: 'not comparable', lines: [`behaviour: not comparable: the steps of flow ${flow} differ from the reference (${sig.actions.length} actions now, ${ref.actions.length} then)`] };
    }
    const out = [];
    const most = (n) => n * 2 > ref.samples; // seen in more than half of the samples
    sig.actions.forEach((a, i) => {
        const r = ref.actions[i];
        for (const [call, c] of Object.entries(r.calls)) {
            if (!(call in a.calls) && most(c.seen))
                out.push(`${a.label}: ${call} not observed within the captured window (seen in ${c.seen}/${ref.samples} samples)`);
        }
        for (const [call, classes] of Object.entries(a.calls)) {
            const was = r.calls[call];
            if (!was) {
                out.push(`${a.label}: ${call} → ${classes} is new (not in the reference)`);
                continue;
            }
            for (const cl of classes.split(','))
                if (!was.classes[cl])
                    out.push(`${a.label}: ${call} → ${cl} (reference: ${Object.entries(was.classes).map(([k, n]) => `${k} in ${n}/${ref.samples}`).join(', ')})`);
        }
        for (const [t, n] of Object.entries(r.told))
            if (!a.told.includes(t) && most(n))
                out.push(`${a.label}: no ${t} feedback (seen in ${n}/${ref.samples} samples)`);
        for (const t of a.told)
            if (!r.told[t])
                out.push(`${a.label}: ${t} feedback is new`);
    });
    if (sig.assertions.failed > ref.assertions.failed)
        out.push(`assertions: ${sig.assertions.failed} failed (reference: ${ref.assertions.failed})`);
    for (const f of sig.findings)
        if (!ref.findings[f])
            out.push(`finding ${f} is new (not in the reference)`);
    if (!out.length)
        return { status: 'same', lines: [`behaviour: same as the reference (${ref.samples} sample${ref.samples === 1 ? '' : 's'}, recorded ${ref.recordedAt.slice(0, 10)})`] };
    return {
        status: 'deviations',
        lines: [`behaviour: ${out.length} observable deviation${out.length === 1 ? '' : 's'} from the reference (changes to investigate, not defects; the reference is unchanged)`, ...out.slice(0, 10).map((l) => `  - ${l}`), ...(out.length > 10 ? [`  - … ${out.length - 10} more`] : [])],
    };
}
