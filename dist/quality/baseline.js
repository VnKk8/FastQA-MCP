// Environment-specific response-time baselines. Recorded explicitly (`fastqa-mcp run <flow> --baseline=record --repeat=5`)
// and only then compared. An endpoint without enough samples is never judged: timing noise is not a defect.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FLOW_DIR, writeAtomic } from '../dirs.js';
export const baselinePath = () => path.join(FLOW_DIR(), 'baselines', 'perf.json');
const DEFAULTS = { factor: 2, minDeltaMs: 200, minSamples: 5 };
const key = (method, route) => `${method} ${route}`;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
/** Durations of successful first-party API calls per endpoint (method + normalized path), across the given sessions. */
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
export async function recordBaseline(observers, minSamples = DEFAULTS.minSamples) {
    const entries = {};
    const thin = [];
    for (const [k, list] of collectDurations(observers)) {
        if (list.length < minSamples) {
            thin.push(`${k} (${list.length})`);
            continue;
        }
        const s = [...list].sort((a, b) => a - b);
        entries[k] = { samples: s.length, medianMs: +pct(s, 0.5).toFixed(1), p95Ms: +pct(s, 0.95).toFixed(1) };
    }
    const file = {
        schemaVersion: 1, recordedAt: new Date().toISOString(), environment: `${process.platform} ${process.arch} node ${process.version}`,
        note: 'Response times of this environment only. Compare runs on the same machine, browser and network.', entries,
    };
    await writeAtomic(baselinePath(), JSON.stringify(file, null, 2) + '\n');
    const n = Object.keys(entries).length;
    return `baseline: recorded ${n} endpoint${n === 1 ? '' : 's'} to ${baselinePath()}` +
        (thin.length ? `\nbaseline: skipped (fewer than ${minSamples} samples; use --repeat): ${thin.slice(0, 8).join(', ')}${thin.length > 8 ? ` +${thin.length - 8} more` : ''}` : '');
}
/** undefined when no baseline file exists or it cannot be read: then nothing is compared. */
export function loadBaseline(cfg) {
    let file;
    try {
        file = JSON.parse(readFileSync(baselinePath(), 'utf8'));
    }
    catch {
        return undefined;
    }
    if (file?.schemaVersion !== 1 || typeof file.entries !== 'object')
        return undefined;
    const o = { ...DEFAULTS, ...cfg.performance?.baseline };
    return {
        limitFor(method, route) {
            const e = file.entries[key(method, route)];
            if (!e || e.samples < o.minSamples)
                return undefined;
            return { limitMs: Math.max(e.p95Ms * o.factor, e.medianMs + o.minDeltaMs), medianMs: e.medianMs, samples: e.samples };
        },
    };
}
