// The compact quality block that rides along with open / act / flow results.
// Clean interactions cost one short line. Details stay local until the agent asks for them through `evidence`.
import type { Observer } from '../observation/observer.js';
import type { Association, Finding, Severity } from '../observation/types.js';
import { sevRank } from '../observation/types.js';
import type { PolicyOutcome } from './engine.js';

export interface QualityBlock {
  /** clean = nothing found within the observed scope; it is not a statement about the whole system */
  status: 'clean' | 'findings' | 'partial' | 'not_evaluated';
  policyOutcome: PolicyOutcome['outcome'];
  coverage: 'complete' | 'partial' | 'disabled';
  observedRequests: number;
  pendingRequests: number;
  droppedEvents: number;
  newCount: number;
  highestSeverity?: Severity;
  moreAvailable: boolean;
  repeats: number;
  infoCount: number;
  rulesNotEvaluated: number;
  findings: Array<{
    id: string; ruleId: string; severity: Severity; confidence: Finding['confidence']; summary: string;
    association: Association; evidenceIds: string[]; late?: boolean;
  }>;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function findingLine(obs: Observer, f: Finding): string {
  const where = `${f.late ? 'late · ' : ''}${obs.actions.describe(f.association)}`;
  const title = f.title.length > 160 ? f.title.slice(0, 159) + '…' : f.title;
  return `${f.id} ${f.severity.toUpperCase()} ${f.ruleId} ${title} — ${where} — ${f.evidenceIds.slice(0, 2).join(',') || 'no event retained'}${f.occurrences > 1 ? ` ×${f.occurrences}` : ''}`;
}

/** Builds the block for the findings that were not shown yet. `final` = run finalization (CLI / flow run). */
export function summarize(obs: Observer, o: { requestsBefore?: number; final?: boolean } = {}): { block: QualityBlock; text: string; policy: PolicyOutcome; fresh: Finding[] } {
  const cov = obs.coverage();
  const q = obs.quality;
  if (!q.enabled) {
    const policy: PolicyOutcome = { outcome: 'not_enforced', failing: [], reasons: [] };
    return { policy, fresh: [], text: '', block: { status: 'not_evaluated', policyOutcome: 'not_enforced', coverage: 'disabled', observedRequests: 0, pendingRequests: 0, droppedEvents: 0, newCount: 0, moreAvailable: false, repeats: 0, infoCount: 0, rulesNotEvaluated: 0, findings: [] } };
  }
  const { fresh, repeats } = q.takeNew();
  const shown = fresh.filter((f) => sevRank(f.severity) >= sevRank('low'));
  const info = fresh.length - shown.length;
  const inline = shown.slice(0, obs.cfg.inlineFindings);
  const observed = obs.stats.tracked - (o.requestsBefore ?? 0);
  const policy = q.policy({ findings: o.final ? undefined : fresh, pending: cov.pending, dropped: cov.dropped, final: !!o.final });
  const block: QualityBlock = {
    status: shown.length ? 'findings' : cov.state === 'partial' ? 'partial' : 'clean',
    policyOutcome: policy.outcome, coverage: cov.state,
    observedRequests: observed, pendingRequests: cov.pending, droppedEvents: cov.dropped,
    newCount: shown.length, highestSeverity: shown[0]?.severity, moreAvailable: shown.length > inline.length,
    repeats, infoCount: info, rulesNotEvaluated: q.notEvaluated.size,
    findings: inline.map((f) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, confidence: f.confidence, summary: f.title, association: f.association, evidenceIds: f.evidenceIds.slice(0, 4), late: f.late })),
  };

  const tail: string[] = [`${plural(observed, 'request')} observed`];
  if (cov.state === 'partial') tail.push(`coverage partial (${[cov.pending ? `${cov.pending} pending` : '', cov.dropped ? `${cov.dropped} events dropped` : ''].filter(Boolean).join(', ')})`);
  if (repeats) tail.push(`${plural(repeats, 'repeat')} of known findings`);
  if (info) tail.push(`${info} info`);
  if (q.notEvaluated.size) tail.push(`${plural(q.notEvaluated.size, 'rule')} not evaluated`);
  const lines: string[] = [];
  if (shown.length) {
    lines.push(`QA: ${plural(shown.length, 'new candidate finding')} (highest ${shown[0].severity.toUpperCase()}) · ${tail.join(' · ')}`);
    for (const f of inline) lines.push('  ' + findingLine(obs, f));
    if (block.moreAvailable) lines.push(`  +${shown.length - inline.length} more`);
    lines.push('  → leads, not confirmed defects: check them with evidence {view:"findings"} before reporting success');
  } else {
    lines.push(`QA: ${cov.state === 'partial' ? 'no findings so far' : 'clean'} · ${tail.join(' · ')}`);
  }
  if (policy.outcome === 'failed') lines.push(`QA policy (strict): FAILED — ${policy.reasons.join('; ')}`);
  else if (policy.outcome === 'provisional') lines.push(`QA policy (strict): provisional — ${policy.reasons.join('; ')}`);
  else if (policy.outcome === 'passed') lines.push('QA policy (strict): passed');
  return { block, text: lines.join('\n'), policy, fresh };
}
