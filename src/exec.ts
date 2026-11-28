// The one place where steps are executed. MCP `open` / `act`, MCP `flow run` and the CLI all go through runBatch,
// so action scopes, observation, detection and policy behave identically with and without a model.
import { Session, sleep, type Step, type RecordedStep } from './session.js';
import { runStep, bind, labelOf } from './runner.js';
import type { Observer } from './observation/observer.js';
import { summarize, type QualityBlock } from './quality/summary.js';
import type { PolicyOutcome } from './quality/engine.js';
import type { ActionRecord, Finding } from './observation/types.js';
import type { SessionEvent } from './session.js';
import { INTERACTIVE } from './correlation/actions.js';
import { PROBED, failed, deadClick, silentFailures, stuckLoading, toldOf, type ActionEffects, type Judging } from './quality/effects.js';
import { mergeProbes, type ProbeData } from './probe.js';
import { effectLine, eventText, FACT } from './facts.js';

/** How long after its action a suspected silent failure or dead click is watched before it is judged (only then). */
const SUSPECT_WAIT_MS = 1000;

/** Steps after which the page is given a bounded moment to settle (the 0.3 set, plus cookies and upload). */
const SETTLE_AFTER = /^(goto|click|dblclick|press|select|check|uncheck|cookies|upload)$/;

export interface BatchOptions {
  kind: 'open' | 'act' | 'flow';
  /** label that expected-response policies can match: the flow name, or the scope given to act */
  scope?: string;
  vars?: Record<string, string>;
  strict?: boolean;
  settleMs?: number;
  finalSettleMs?: number;
  number?: boolean;
  onRecorded?: (r: RecordedStep) => void;
  /** add the fact lines ("  ↳ …") after the steps they belong to (act results; not replays and reports) */
  facts?: boolean;
}
export interface BatchResult {
  ok: boolean;
  /** one line per step that ran */
  lines: string[];
  /** the step lines with their fact lines, when `facts` was asked for; otherwise the same as lines */
  text: string[];
  /** dialogs, downloads and pickers: [0] before the batch, then one list per step that ran */
  events: SessionEvent[][];
  failedAt?: number;
  ms: number;
  batchId: string;
  steps: number;
  assertions: { passed: number; failed: number };
  requestsBefore: number;
}

export async function runBatch(session: Session, steps: Step[], o: BatchOptions): Promise<BatchResult> {
  const obs = session.obs;
  const t0 = Date.now();
  const batch = obs.actions.beginBatch(o.kind, o.scope);
  const requestsBefore = obs.stats.tracked;
  session.mark = Date.now();
  session.strictNow = o.strict;
  const lines: string[] = [];
  const facts: string[][] = [];
  const events: SessionEvent[][] = [];
  const watched: Array<Watched | undefined> = [];
  // the probe windows in order: each action's own window, and the gap after it until the next one (see probe.ts)
  const windows: ProbeWindow[] = [];
  let lastOwner = -1;
  const drain = async (owner: number, kind: ProbeWindow['kind']) => {
    const data = await session.probeDrain();
    windows.push({ owner, kind, data, at: Date.now() });
    brokenImages(session, owner >= 0 ? watched[owner]?.action : undefined, data);
    return data;
  };
  const earlier = session.takeEvents(); // between the previous batch and this one
  const assertions = { passed: 0, failed: 0 };
  let ok = true; let failedAt: number | undefined;
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const probed = PROBED.test(step.do) && !!session.page;
      const urlBefore = session.page?.url() ?? '';
      const pagesBefore = session.context?.pages().length ?? 0;
      if (probed) await drain(lastOwner, 'gap'); // what happened until now belongs to the previous action's gap
      const action = obs.actions.beginAction(step.do, labelOf(step), session.page ? obs.pageId(session.page) : undefined);
      if (action.interactive) session.lastAction = { id: action.actionId, startedMs: action.startedMs, t: Date.now() };
      // a ref's label is only "e12": the control's name from the snapshot, known before any request of the action starts
      const control = step.target && /^e\d+$/.test(step.target) ? session.hints.get(step.target)?.id?.name : undefined;
      if (control) action.control = control;
      let stepOk = false;
      try {
        const r = await runStep(session, bind(step, o.vars ?? {}), step);
        obs.actions.executed(action); // what follows is the settle phase
        const executedAt = Date.now();
        stepOk = r.ok;
        lines.push(o.number ? `${String(i + 1).padStart(2)}. ${r.line}` : r.line);
        facts[i] = (r.facts ?? []).map((f) => FACT + f);
        if (step.do.startsWith('expect_')) assertions[r.ok ? 'passed' : 'failed']++;
        if (r.ok && r.recorded) o.onRecorded?.(r.recorded);
        // the settle belongs to the action: requests it triggers are attributed while it runs
        if (r.ok && SETTLE_AFTER.test(step.do)) await session.settle(o.settleMs ?? 1500);
        // browser.allowedOrigins: a click, redirect or popup that took the page elsewhere fails the step and stops the batch
        const left = session.takeLeftOrigin();
        if (left && stepOk) {
          stepOk = false;
          lines[lines.length - 1] = left.blocked
            ? `${o.number ? `${String(i + 1).padStart(2)}. ` : ''}✗ ${labelOf(step)} — a navigation to ${left.url} was blocked before its request was sent: outside browser.allowedOrigins; no further steps run (top-level and popup navigations only: not a network sandbox)`
            : `${o.number ? `${String(i + 1).padStart(2)}. ` : ''}✗ ${labelOf(step)} — the page went to ${left.url}, outside browser.allowedOrigins; no further steps run (checked after the navigation: not a network sandbox)`;
        }
        // FQA-07: an armed dialog is judged after the step that follows the "dialog" step (bounded: that step's own settle)
        const arm = session.dialogArm;
        if (arm && step.do !== 'dialog' && ++arm.steps >= 1) {
          session.dialogArm = undefined;
          if (stepOk && (arm.mismatch || !arm.consumed)) {
            stepOk = false;
            const why = arm.mismatch ? `a dialog appeared but its message was ${JSON.stringify(arm.mismatch)}, not one containing ${JSON.stringify(arm.expect)} (dismissed)` : 'the armed dialog did not appear';
            lines[lines.length - 1] = `${o.number ? `${String(i + 1).padStart(2)}. ` : ''}✗ ${labelOf(step)} — ${why}`;
          }
        }
        if (r.ok && INTERACTIVE.test(step.do)) {
          watched[i] = { action, probed, executedAt, endedAt: Date.now(), ...where(session, urlBefore, pagesBefore) };
          if (probed || step.do === 'goto') { await drain(i, 'own'); lastOwner = i; }
        }
      } finally {
        obs.actions.endAction(action, stepOk);
        events[i] = session.takeEvents();
      }
      if (!stepOk) { ok = false; failedAt = i + 1; break; }
    }
    if (o.finalSettleMs) await session.settle(o.finalSettleMs);
    await runStateChecks(session);
    // the gap after the last watched action closes now; a batch of navigations only (open) has nothing to judge
    if (watched.some((w) => w?.probed) && lastOwner >= 0) await drain(lastOwner, 'gap');
    // Silent failures and dead clicks are judged on everything until now. When one is suspected, the page gets one more
    // bounded settle first: a debounced request or a late message is not a false alarm. The normal path never waits.
    let all = judge(session, watched, windows, events);
    if (all.some((e) => suspicious(e, obs))) {
      // a page that is quiet may still have a timer pending (a debounced save, a delayed message): give the latest
      // action one second in all, then let the page settle
      const latest = Math.max(...watched.map((w) => w?.executedAt ?? 0));
      await sleep(Math.max(0, latest + SUSPECT_WAIT_MS - Date.now()));
      await session.settle(1500);
      if (lastOwner >= 0) await drain(lastOwner, 'gap');
      const late = session.takeEvents();
      if (late.length) events[lastOwner >= 0 ? lastOwner : events.length - 1]?.push(...late);
      all = judge(session, watched, windows, events);
    }
    const j: Judging = {
      sentAgain: (r) => obs.sentAgain(r), expected: (r) => obs.quality.isExpected(r),
      // only asked when a FALSE-FAILURE is otherwise supported (rare): a bounded scan of the retained requests
      failedSince: (ms) => { for (const r of obs.requests.values()) if (r.startedMs >= ms && r.firstParty && failed(r)) return true; return false; },
    };
    for (const e of all) {
      // for behaviour signatures: from what was already judged, no page access. Probe data comes from the page: a page
      // that tampers with it must never break a run.
      try { e.action.told = toldOf(e); } catch { /* unreadable probe data: no feedback categories */ }
      if (e.action.do !== 'goto') try { obs.quality.onAction(e, j); } catch { /* a rule must never break a run */ }
    }
    // a failed call's reason comes from its body, when capture is on: give a body that is being read a moment
    const end = Date.now() + 200;
    while (all.some((e) => e.requests.some((r) => failed(r) && r.body?.state === 'pending')) && Date.now() < end) await sleep(20);
  } finally {
    session.strictNow = undefined;
    obs.actions.endBatch(batch, ok);
  }
  let text = lines;
  if (o.facts) {
    const byStep = new Map(judge(session, watched, windows, events).map((e) => [e.action.actionId, e]));
    text = [
      ...(earlier.length ? [`${FACT}before this batch: ${earlier.map(eventText).join(' · ')}`] : []),
      ...lines.flatMap((l, i) => {
        const w = watched[i];
        const e = w ? byStep.get(w.action.actionId) : undefined;
        const eff = e && e.action.do !== 'goto' ? effectLine(e, events[i] ?? [], goneAfter(windows, i)) : undefined;
        const own = !eff && events[i]?.length ? `${FACT}${events[i].map(eventText).join(' · ')}` : undefined;
        return [l, ...(facts[i] ?? []), ...(eff ? [eff] : []), ...(own ? [own] : [])];
      }),
    ];
  }
  return { ok, lines, text, events: [earlier, ...events], failedAt, ms: Date.now() - t0, batchId: batch.batchId, steps: steps.length, assertions, requestsBefore };
}

interface Watched { action: ActionRecord; probed: boolean; executedAt: number; endedAt: number; navigatedTo?: string; newPage: boolean }
interface ProbeWindow { owner: number; kind: 'own' | 'gap'; data?: ProbeData; at: number }

/** Where the page went during the action: a new URL (redacted, path only on the same origin), a new tab. */
function where(session: Session, urlBefore: string, pagesBefore: number): { navigatedTo?: string; newPage: boolean } {
  const page = session.page;
  const strip = (u: string) => u.split('#')[0];
  let navigatedTo: string | undefined;
  if (page && !page.isClosed() && strip(page.url()) !== strip(urlBefore)) {
    const now = session.obs.redactor.pageUrl(page.url());
    try { const a = new URL(now); const b = new URL(urlBefore); navigatedTo = a.origin === b.origin ? a.pathname + a.search : now; } catch { navigatedTo = now; }
  }
  return { navigatedTo, newPage: (session.context?.pages().length ?? 0) > pagesBefore };
}

/** The effects of every watched action, from the windows and events known now. */
function judge(session: Session, watched: Array<Watched | undefined>, windows: ProbeWindow[], events: SessionEvent[][]): ActionEffects[] {
  const out: ActionEffects[] = [];
  watched.forEach((w, i) => {
    if (!w) return;
    const ownAt = windows.findIndex((x) => x.kind === 'own' && x.owner === i);
    const gaps = windows.filter((x) => x.kind === 'gap' && x.owner === i);
    // the events of this step and of the passive steps after it, until the next watched step
    let next = watched.findIndex((x, j) => j > i && !!x && x.probed);
    if (next < 0) next = events.length;
    const evs = events.slice(i, next).flat();
    const until = gaps.length ? gaps[gaps.length - 1].at : ownAt >= 0 ? windows[ownAt].at : w.endedAt;
    out.push({
      action: w.action, requests: session.obs.requestsOf(w.action.actionId), bodyKey: session.obs.bodyKey,
      navigatedTo: w.navigatedTo, newPage: w.newPage, events: evs,
      probe: ownAt >= 0 ? windows[ownAt].data : undefined,
      gap: mergeProbes(gaps.map((g) => g.data)),
      after: ownAt >= 0 ? mergeProbes(windows.slice(ownAt + 1).map((x) => x.data)) : undefined,
      // the drain right before the action (what the page already showed) and the action's own latest one: an indicator a
      // later action shows is never blamed on this one
      before: ownAt > 0 && windows[ownAt - 1].kind === 'gap' ? windows[ownAt - 1].data : undefined,
      last: gaps.length ? gaps[gaps.length - 1].data : undefined,
      watchedMs: Math.max(0, until - w.executedAt),
    });
  });
  return out;
}

const suspicious = (e: ActionEffects, obs: Observer) => {
  try {
    return e.action.do !== 'goto' && (deadClick(e) || silentFailures(e, (r) => obs.sentAgain(r)).length > 0 || stuckLoading(e).length > 0);
  } catch { return false; } // probe data the page tampered with: no extra wait, no judgement
};

/** The ids of messages that went away in action i's own window or in the gap right after it. */
function goneAfter(windows: ProbeWindow[], i: number): Set<string> {
  return new Set(windows.filter((x) => x.owner === i).flatMap((x) => x.data?.gone ?? []));
}

/** First-party images the page could not show, whose request (after redirects) did not fail: a failed one is a NET finding. */
function brokenImages(session: Session, action: ActionRecord | undefined, data?: ProbeData) {
  const obs = session.obs;
  for (const src of data?.images ?? []) {
    let origin = ''; try { origin = new URL(src).origin; } catch { continue; }
    if (!obs.firstParty.has(origin)) continue;
    const url = obs.redactor.networkUrl(src);
    // the latest request for this URL, from the observer's index, and the redirects it led to
    let failedLoad = false;
    for (let x = obs.latestFor(url), n = 0; x && n < 10 && !failedLoad; x = x.redirectedTo ? obs.requests.get(x.redirectedTo) : undefined, n++) if (failed(x)) failedLoad = true;
    if (!failedLoad) obs.quality.brokenImage(url, action ? { actionId: action.actionId, confidence: 'inferred', reason: 'the image failed while the action ran and settled' } : { confidence: 'unattributed', reason: 'no action in progress' });
  }
}

/** Configured UI expectations that follow a matching response (opt-in). Bounded: each check polls for at most its withinMs. */
async function runStateChecks(session: Session) {
  const q = session.obs.quality;
  if (!q.stateChecks.length || !session.page || session.page.isClosed()) return;
  for (const c of q.stateChecks.splice(0)) {
    const want = c.expectText !== undefined;
    const text = (c.expectText ?? c.expectNoText)!;
    const end = Date.now() + c.withinMs;
    let seen = false;
    do {
      try { seen = (await session.deepTexts()).some((x) => x.text.includes(text)); } catch { seen = false; }
      if (seen === want) break;
      await sleep(50);
    } while (Date.now() < end);
    if (seen !== want) q.stateViolation(c, want ? `text ${JSON.stringify(text)} did not appear within ${c.withinMs}ms` : `text ${JSON.stringify(text)} is still visible`);
  }
}

export interface QualityResult { block: QualityBlock; text: string; policy: PolicyOutcome; fresh: Finding[] }

/**
 * The quality section for a tool result: findings not shown yet (including late ones from earlier batches).
 * `assertions` (act results): the QA line also says whether anything was verified, so a run of steps is never read as a test.
 */
export function qualityOf(obs: Observer | undefined, requestsBefore = 0, assertions?: { passed: number; failed: number }): QualityResult | undefined {
  if (!obs || !obs.quality.enabled) return undefined;
  return summarize(obs, { requestsBefore, assertions });
}

/**
 * Run finalization for replay (MCP flow run and CLI): in strict mode a bounded drain of the requests still pending,
 * then the authoritative policy outcome. Observe mode never waits and never fails a run.
 */
export async function finalize(session: Session): Promise<QualityResult | undefined> {
  const obs = session.obs;
  if (!obs || !obs.quality.enabled) return undefined;
  if (obs.cfg.enforce && obs.cfg.finalizeTimeoutMs > 0) {
    // Only the requests that were open when the run ended are waited for and judged. Traffic that starts later
    // (polling) is not part of this run: it neither delays finalization nor makes it "incomplete".
    const { pending } = await obs.drain(obs.cfg.finalizeTimeoutMs);
    return summarize(obs, { final: true, pending: pending.length });
  }
  return summarize(obs, { final: true });
}

/** Structured mirror of a tool result (opt-in: mcp.structuredContent). Execution, assertions and policy stay separate. */
export function structured(b: BatchResult | undefined, q: QualityResult | undefined) {
  return {
    execution: b ? { status: b.ok ? 'passed' : 'failed', actionCount: b.failedAt ?? b.steps, durationMs: b.ms, batchId: b.batchId } : undefined,
    assertions: b?.assertions,
    quality: q?.block,
  };
}
