// Optional services that attach to a session: artifacts, discovery, contracts, baselines.
// Kept out of session.ts so the core (execution + observation) has no dependency on them.
import type { Observer } from './observation/observer.js';
import type { EvidenceQuery } from './evidence/query.js';

export function installServices() { /* services register their session hooks here */ }

export async function exportBundle(_obs: Observer): Promise<string> { throw new Error('session bundles are not available in this build step'); }
export async function bugDraft(_obs: Observer, _findingId: string): Promise<{ file: string; markdown: string } | undefined> { return undefined; }
export function discoveryView(_obs: Observer, _q: Partial<EvidenceQuery>): string { return 'Discovery is off. Set quality.mode "discovery" or discovery.enabled in .fastqa/config.json.'; }
export async function mergeDiscovery(): Promise<string> { return 'No discovery exports found.'; }
export async function recordBaseline(_samples: Observer[]): Promise<string> { return 'baseline: nothing recorded'; }
