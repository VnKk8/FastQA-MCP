export function installServices() { }
export async function exportBundle(_obs) { throw new Error('session bundles are not available in this build step'); }
export async function bugDraft(_obs, _findingId) { return undefined; }
export function discoveryView(_obs, _q) { return 'Discovery is off. Set quality.mode "discovery" or discovery.enabled in .fastqa/config.json.'; }
export async function mergeDiscovery() { return 'No discovery exports found.'; }
export async function recordBaseline(_samples) { return 'baseline: nothing recorded'; }
