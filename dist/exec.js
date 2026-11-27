// The one place where steps are executed. MCP `open` / `act`, MCP `flow run` and the CLI all go through runBatch,
// so action scopes, observation, detection and policy behave identically with and without a model.
import { sleep } from './session.js';
import { runStep, bind, labelOf } from './runner.js';
import { summarize } from './quality/summary.js';
/** Steps after which the page is given a bounded moment to settle (the 0.3 set, plus cookies). */
const SETTLE_AFTER = /^(goto|click|dblclick|press|select|check|uncheck|cookies)$/;
export async function runBatch(session, steps, o) {
    const obs = session.obs;
    const t0 = Date.now();
    const batch = obs.actions.beginBatch(o.kind, o.scope);
    const requestsBefore = obs.stats.tracked;
    session.mark = Date.now();
    session.strictNow = o.strict;
    const lines = [];
    const assertions = { passed: 0, failed: 0 };
    let ok = true;
    let failedAt;
    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const action = obs.actions.beginAction(step.do, labelOf(step), session.page ? obs.pageId(session.page) : undefined);
            let stepOk = false;
            try {
                const r = await runStep(session, bind(step, o.vars ?? {}), step);
                obs.actions.executed(action); // what follows is the settle phase
                stepOk = r.ok;
                lines.push(o.number ? `${String(i + 1).padStart(2)}. ${r.line}` : r.line);
                if (step.do.startsWith('expect_'))
                    assertions[r.ok ? 'passed' : 'failed']++;
                if (r.ok && r.recorded)
                    o.onRecorded?.(r.recorded);
                // the settle belongs to the action: requests it triggers are attributed while it runs
                if (r.ok && SETTLE_AFTER.test(step.do))
                    await session.settle(o.settleMs ?? 1500);
            }
            finally {
                obs.actions.endAction(action, stepOk);
            }
            if (!stepOk) {
                ok = false;
                failedAt = i + 1;
                break;
            }
        }
        if (o.finalSettleMs)
            await session.settle(o.finalSettleMs);
        await runStateChecks(session);
    }
    finally {
        session.strictNow = undefined;
        obs.actions.endBatch(batch, ok);
    }
    return { ok, lines, failedAt, ms: Date.now() - t0, batchId: batch.batchId, steps: steps.length, assertions, requestsBefore };
}
/** Configured UI expectations that follow a matching response (opt-in). Bounded: each check polls for at most its withinMs. */
async function runStateChecks(session) {
    const q = session.obs.quality;
    if (!q.stateChecks.length || !session.page || session.page.isClosed())
        return;
    for (const c of q.stateChecks.splice(0)) {
        const want = c.expectText !== undefined;
        const text = (c.expectText ?? c.expectNoText);
        const end = Date.now() + c.withinMs;
        let seen = false;
        do {
            try {
                seen = (await session.deepTexts()).some((x) => x.text.includes(text));
            }
            catch {
                seen = false;
            }
            if (seen === want)
                break;
            await sleep(50);
        } while (Date.now() < end);
        if (seen !== want)
            q.stateViolation(c, want ? `text ${JSON.stringify(text)} did not appear within ${c.withinMs}ms` : `text ${JSON.stringify(text)} is still visible`);
    }
}
/** The quality section for a tool result: findings not shown yet (including late ones from earlier batches). */
export function qualityOf(obs, requestsBefore = 0) {
    if (!obs || !obs.quality.enabled)
        return undefined;
    return summarize(obs, { requestsBefore });
}
/**
 * Run finalization for replay (MCP flow run and CLI): in strict mode a bounded drain of the requests still pending,
 * then the authoritative policy outcome. Observe mode never waits and never fails a run.
 */
export async function finalize(session) {
    const obs = session.obs;
    if (!obs || !obs.quality.enabled)
        return undefined;
    if (obs.cfg.enforce && obs.cfg.finalizeTimeoutMs > 0) {
        // Only the requests that were open when the run ended are waited for and judged. Traffic that starts later
        // (polling) is not part of this run: it neither delays finalization nor makes it "incomplete".
        const { pending } = await obs.drain(obs.cfg.finalizeTimeoutMs);
        return summarize(obs, { final: true, pending: pending.length });
    }
    return summarize(obs, { final: true });
}
/** Structured mirror of a tool result (opt-in: mcp.structuredContent). Execution, assertions and policy stay separate. */
export function structured(b, q) {
    return {
        execution: b ? { status: b.ok ? 'passed' : 'failed', actionCount: b.failedAt ?? b.steps, durationMs: b.ms, batchId: b.batchId } : undefined,
        assertions: b?.assertions,
        quality: q?.block,
    };
}
