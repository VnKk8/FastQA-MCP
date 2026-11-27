// Optional services that attach to a session: artifacts, discovery, contracts, baselines.
// Kept out of session.ts so the core (execution + observation) has no dependency on them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sessionHooks } from './session.js';
import { BundleStream, streams, writeBundle, writeBugDraft, sessionsDir } from './evidence/bundle.js';
import { loadBaseline, recordBaseline as record } from './quality/baseline.js';
import { DiscoveryGraph, mergeDiscovery as merge, renderDiscovery } from './discovery/graph.js';
import { loadContracts } from './contract/openapi.js';
import { FLOW_DIR, writeAtomic } from './dirs.js';
import { redactor } from './privacy/redact.js';
import { VERSION } from './version.js';
const bundled = new WeakSet();
const graphs = new WeakMap();
/** contract warnings are printed once per process, not once per flow run */
const warned = new Set();
let installed = false;
export function installServices() {
    if (installed)
        return;
    installed = true;
    sessionHooks.created.push((s) => {
        const obs = s.obs;
        const cfg = s.cfg;
        obs.environment.fastqa = VERSION;
        if (cfg.artifacts.enabled) {
            const st = new BundleStream(obs, cfg.artifacts.maxBytesPerRun * 0.8);
            streams.set(obs, st);
            obs.sinks.push(st);
        }
        if (cfg.discovery.enabled) {
            const g = new DiscoveryGraph({
                sessionId: obs.sessionId, pathTemplates: cfg.discovery.pathTemplates,
                describeAction: (id) => { const a = obs.actions.get(id); return a ? { label: a.label, kind: a.do } : undefined; },
                scopeOf: (b) => obs.actions.scopeOf(b),
                batchKind: (b) => obs.actions.batches.find((x) => x.batchId === b)?.kind,
            });
            graphs.set(obs, g);
            obs.sinks.push(g);
        }
        if (cfg.contracts.length) {
            // Local files only, resolved inside the fastqa dir or the project root. A document that cannot be used is a warning, never a crash.
            const { checker, warnings } = loadContracts(cfg.contracts, FLOW_DIR());
            obs.quality.contract = checker;
            for (const w of warnings)
                if (!warned.has(w)) {
                    warned.add(w);
                    console.error(`fastqa: ${w}`);
                }
            if (warnings.length)
                obs.environment.contractWarnings = warnings;
        }
        if (s.options.baseline === 'check' || cfg.performance?.baseline)
            obs.quality.baseline = loadBaseline(cfg);
        // a session that ends (close, fresh context) leaves its bundle behind when artifacts are on
        s.onEnd = async (o) => { if ((cfg.artifacts.enabled || s.options.bundle) && !bundled.has(o))
            await exportBundle(o); };
    });
}
export async function exportBundle(obs, extra = {}) {
    bundled.add(obs);
    const g = graphs.get(obs);
    return writeBundle(obs, { ...extra, environment: { ...obs.environment, ...extra.environment }, discovery: g ? { endpoints: g.export(), journeys: g.journeys() } : undefined });
}
export async function bugDraft(obs, findingId) {
    return writeBugDraft(obs, findingId, { environment: obs.environment });
}
export function discoveryView(obs, q) {
    const g = graphs.get(obs);
    if (!g)
        return 'Discovery is off for this session. Set quality.mode "discovery" (or discovery.enabled) in .fastqa/config.json and open a fresh context.';
    return renderDiscovery(g.export(), { path: q.path, limit: q.limit });
}
/** Explicit merge of the sanitized discovery exports of saved session bundles into .fastqa/discovery.json. */
export async function mergeDiscovery() {
    const root = sessionsDir();
    const names = await fs.readdir(root).catch(() => []);
    const exports = [];
    for (const n of names.sort()) {
        try {
            const d = JSON.parse(await fs.readFile(path.join(root, n, 'discovery', 'endpoints.json'), 'utf8'));
            if (d?.schemaVersion === 1 && d.kind === 'fastqa-discovery')
                exports.push(d);
        }
        catch { /* no discovery export in this bundle */ }
    }
    if (!exports.length)
        return `No discovery exports found in ${root}. Run with quality.mode "discovery" and artifacts enabled (or --bundle).`;
    const merged = merge(exports);
    const file = path.join(FLOW_DIR(), 'discovery.json');
    await writeAtomic(file, redactor.text(JSON.stringify(merged, null, 2)) + '\n');
    return `Merged ${exports.length} session export${exports.length === 1 ? '' : 's'} into ${file}: ${merged.routes.length} routes, ${merged.endpoints.length} endpoints, ${merged.edges.length} edges.\n` +
        'This lists observed activity only: it is not a coverage measure and says nothing about pages or endpoints that were not visited.';
}
export const recordBaseline = (samples) => record(samples);
