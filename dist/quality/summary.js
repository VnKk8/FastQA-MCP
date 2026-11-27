import { sevRank } from '../observation/types.js';
import { byImportance } from './engine.js';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export function findingLine(obs, f, again = false) {
    const where = `${f.late ? 'late · ' : ''}${obs.actions.describe(f.association)}`;
    const title = f.title.length > 160 ? f.title.slice(0, 159) + '…' : f.title;
    return `${f.id} ${f.severity.toUpperCase()} ${f.ruleId} ${title} — ${where} — ${f.evidenceIds.slice(-2).join(',') || 'no event retained'}${f.occurrences > 1 ? ` ×${f.occurrences}` : ''}${again ? ' (again)' : ''}`;
}
/**
 * Builds the block for what was not shown yet. `final` = run finalization (CLI / flow run), where `pending` is the
 * number of requests the bounded drain was still waiting for (later traffic such as polling does not count).
 */
export function summarize(obs, o = {}) {
    const live = obs.coverage();
    const pending = o.pending ?? live.pending;
    const state = live.state === 'disabled' ? 'disabled' : pending || live.dropped ? 'partial' : 'complete';
    const q = obs.quality;
    obs.actions.markReported();
    if (!q.enabled) {
        const policy = { outcome: 'not_enforced', failing: [], reasons: [] };
        return { policy, fresh: [], text: '', block: { status: 'not_evaluated', policyOutcome: 'not_enforced', coverage: 'disabled', observedRequests: 0, pendingRequests: 0, droppedEvents: 0, newCount: 0, recurringCount: 0, moreAvailable: false, infoCount: 0, rulesNotEvaluated: 0, findings: [] } };
    }
    const { fresh, recurring } = q.takeNew();
    const again = new Set(recurring.map((f) => f.id));
    const visible = (f) => sevRank(f.severity) >= sevRank('low');
    const shown = [...fresh, ...recurring].filter(visible).sort(byImportance);
    const info = fresh.length + recurring.length - shown.length;
    const inline = shown.slice(0, obs.cfg.inlineFindings);
    const observed = obs.stats.tracked - (o.requestsBefore ?? 0);
    // interactive: what this result shows (new and recurring); final: every candidate of the session
    const policy = q.policy({ findings: o.final ? undefined : [...fresh, ...recurring], pending, dropped: live.dropped, final: !!o.final });
    const nNew = shown.filter((f) => !again.has(f.id)).length;
    const nAgain = shown.length - nNew;
    const block = {
        status: shown.length ? 'findings' : state === 'partial' ? 'partial' : 'clean',
        policyOutcome: policy.outcome, coverage: state,
        observedRequests: observed, pendingRequests: pending, droppedEvents: live.dropped,
        newCount: nNew, recurringCount: nAgain, highestSeverity: shown[0]?.severity, moreAvailable: shown.length > inline.length,
        infoCount: info, rulesNotEvaluated: q.notEvaluated.size,
        findings: inline.map((f) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, confidence: f.confidence, summary: f.title, association: f.association, evidenceIds: f.evidenceIds.slice(-4), occurrences: f.occurrences, late: f.late, again: again.has(f.id) || undefined })),
    };
    const tail = [`${plural(observed, 'request')} observed`];
    if (state === 'partial')
        tail.push(`coverage partial (${[pending ? `${pending} pending` : '', live.dropped ? `${live.dropped} events dropped` : ''].filter(Boolean).join(', ')})`);
    if (info)
        tail.push(`${info} info`);
    if (q.notEvaluated.size)
        tail.push(`${plural(q.notEvaluated.size, 'rule')} not evaluated`);
    if (q.findingsDropped)
        tail.push(`${q.findingsDropped} findings over the limit not kept`);
    const lines = [];
    if (shown.length) {
        const what = [nNew ? plural(nNew, 'new candidate finding') : '', nAgain ? `${plural(nAgain, 'known finding')} seen again` : ''].filter(Boolean).join(', ');
        lines.push(`QA: ${what} (highest ${shown[0].severity.toUpperCase()}) · ${tail.join(' · ')}`);
        for (const f of inline)
            lines.push('  ' + findingLine(obs, f, again.has(f.id)));
        if (block.moreAvailable)
            lines.push(`  +${shown.length - inline.length} more`);
        lines.push('  → leads, not confirmed defects: check them with evidence {view:"findings"} before reporting success');
    }
    else {
        lines.push(`QA: ${state === 'partial' ? 'no findings so far' : 'clean'} · ${tail.join(' · ')}`);
    }
    if (policy.outcome === 'failed')
        lines.push(`QA policy (strict): FAILED — ${policy.reasons.join('; ')}`);
    else if (policy.outcome === 'provisional')
        lines.push(`QA policy (strict): provisional — ${policy.reasons.join('; ')}`);
    else if (policy.outcome === 'passed')
        lines.push('QA policy (strict): passed');
    return { block, text: lines.join('\n'), policy, fresh: shown };
}
