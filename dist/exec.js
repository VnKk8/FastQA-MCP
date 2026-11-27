// The one place where steps are executed. MCP `open` / `act`, MCP `flow run` and the CLI all go through runBatch,
// so action scopes, observation, detection and policy behave identically with and without a model.
import { sleep } from './session.js';
import { runStep, bind, labelOf } from './runner.js';
import { summarize } from './quality/summary.js';
import { INTERACTIVE } from './correlation/actions.js';
import { PROBED, failed, deadClick, silentFailures } from './quality/effects.js';
import { mergeProbes } from './probe.js';
import { effectLine, eventText, FACT } from './facts.js';
/** How long after its action a suspected silent failure or dead click is watched before it is judged (only then). */
const SUSPECT_WAIT_MS = 1000;
/** Steps after which the page is given a bounded moment to settle (the 0.3 set, plus cookies and upload). */
const SETTLE_AFTER = /^(goto|click|dblclick|press|select|check|uncheck|cookies|upload)$/;
export async function runBatch(session, steps, o) {
    const obs = session.obs;
    const t0 = Date.now();
    const batch = obs.actions.beginBatch(o.kind, o.scope);
    const requestsBefore = obs.stats.tracked;
    session.mark = Date.now();
    session.strictNow = o.strict;
    const lines = [];
    const facts = [];
    const events = [];
    const watched = [];
    // the probe windows in order: each action's own window, and the gap after it until the next one (see probe.ts)
    const windows = [];
    let lastOwner = -1;
    const drain = async (owner, kind) => {
        const data = await session.probeDrain();
        windows.push({ owner, kind, data, at: Date.now() });
        brokenImages(session, owner >= 0 ? watched[owner]?.action : undefined, data);
        return data;
    };
    const earlier = session.takeEvents(); // between the previous batch and this one
    const assertions = { passed: 0, failed: 0 };
    let ok = true;
    let failedAt;
    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const probed = PROBED.test(step.do) && !!session.page;
            const urlBefore = session.page?.url() ?? '';
            const pagesBefore = session.context?.pages().length ?? 0;
            if (probed)
                await drain(lastOwner, 'gap'); // what happened until now belongs to the previous action's gap
            const action = obs.actions.beginAction(step.do, labelOf(step), session.page ? obs.pageId(session.page) : undefined);
            let stepOk = false;
            try {
                const r = await runStep(session, bind(step, o.vars ?? {}), step);
                obs.actions.executed(action); // what follows is the settle phase
                const executedAt = Date.now();
                stepOk = r.ok;
                lines.push(o.number ? `${String(i + 1).padStart(2)}. ${r.line}` : r.line);
                facts[i] = (r.facts ?? []).map((f) => FACT + f);
                if (step.do.startsWith('expect_'))
                    assertions[r.ok ? 'passed' : 'failed']++;
                if (r.ok && r.recorded)
                    o.onRecorded?.(r.recorded);
                // the settle belongs to the action: requests it triggers are attributed while it runs
                if (r.ok && SETTLE_AFTER.test(step.do))
                    await session.settle(o.settleMs ?? 1500);
                if (r.ok && INTERACTIVE.test(step.do)) {
                    watched[i] = { action, probed, executedAt, endedAt: Date.now(), ...where(session, urlBefore, pagesBefore) };
                    if (probed || step.do === 'goto') {
                        await drain(i, 'own');
                        lastOwner = i;
                    }
                }
            }
            finally {
                obs.actions.endAction(action, stepOk);
                events[i] = session.takeEvents();
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
        // the gap after the last watched action closes now; a batch of navigations only (open) has nothing to judge
        if (watched.some((w) => w?.probed) && lastOwner >= 0)
            await drain(lastOwner, 'gap');
        // Silent failures and dead clicks are judged on everything until now. When one is suspected, the page gets one more
        // bounded settle first: a debounced request or a late message is not a false alarm. The normal path never waits.
        let all = judge(session, watched, windows, events);
        if (all.some((e) => suspicious(e, obs))) {
            // a page that is quiet may still have a timer pending (a debounced save, a delayed message): give the latest
            // action one second in all, then let the page settle
            const latest = Math.max(...watched.map((w) => w?.executedAt ?? 0));
            await sleep(Math.max(0, latest + SUSPECT_WAIT_MS - Date.now()));
            await session.settle(1500);
            if (lastOwner >= 0)
                await drain(lastOwner, 'gap');
            const late = session.takeEvents();
            if (late.length)
                events[lastOwner >= 0 ? lastOwner : events.length - 1]?.push(...late);
            all = judge(session, watched, windows, events);
        }
        for (const e of all)
            if (e.action.do !== 'goto')
                try {
                    obs.quality.onAction(e, obs.requests.values());
                }
                catch { /* a rule must never break a run */ }
        // a failed call's reason comes from its body, when capture is on: give a body that is being read a moment
        const end = Date.now() + 200;
        while (all.some((e) => e.requests.some((r) => failed(r) && r.body?.state === 'pending')) && Date.now() < end)
            await sleep(20);
    }
    finally {
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
/** Where the page went during the action: a new URL (redacted, path only on the same origin), a new tab. */
function where(session, urlBefore, pagesBefore) {
    const page = session.page;
    const strip = (u) => u.split('#')[0];
    let navigatedTo;
    if (page && !page.isClosed() && strip(page.url()) !== strip(urlBefore)) {
        const now = session.obs.redactor.pageUrl(page.url());
        try {
            const a = new URL(now);
            const b = new URL(urlBefore);
            navigatedTo = a.origin === b.origin ? a.pathname + a.search : now;
        }
        catch {
            navigatedTo = now;
        }
    }
    return { navigatedTo, newPage: (session.context?.pages().length ?? 0) > pagesBefore };
}
/** The effects of every watched action, from the windows and events known now. */
function judge(session, watched, windows, events) {
    const out = [];
    watched.forEach((w, i) => {
        if (!w)
            return;
        const ownAt = windows.findIndex((x) => x.kind === 'own' && x.owner === i);
        const gaps = windows.filter((x) => x.kind === 'gap' && x.owner === i);
        // the events of this step and of the passive steps after it, until the next watched step
        let next = watched.findIndex((x, j) => j > i && !!x && x.probed);
        if (next < 0)
            next = events.length;
        const evs = events.slice(i, next).flat();
        const until = gaps.length ? gaps[gaps.length - 1].at : ownAt >= 0 ? windows[ownAt].at : w.endedAt;
        out.push({
            action: w.action, requests: session.obs.requestsOf(w.action.actionId), bodyKey: session.obs.bodyKey,
            navigatedTo: w.navigatedTo, newPage: w.newPage, events: evs,
            probe: ownAt >= 0 ? windows[ownAt].data : undefined,
            gap: mergeProbes(gaps.map((g) => g.data)),
            after: ownAt >= 0 ? mergeProbes(windows.slice(ownAt + 1).map((x) => x.data)) : undefined,
            watchedMs: Math.max(0, until - w.executedAt),
        });
    });
    return out;
}
const suspicious = (e, obs) => e.action.do !== 'goto' && (deadClick(e) || silentFailures(e, obs.requests.values()).length > 0);
/** The ids of messages that went away in action i's own window or in the gap right after it. */
function goneAfter(windows, i) {
    return new Set(windows.filter((x) => x.owner === i).flatMap((x) => x.data?.gone ?? []));
}
/** First-party images the page could not show, whose request (after redirects) did not fail: a failed one is a NET finding. */
function brokenImages(session, action, data) {
    const obs = session.obs;
    for (const src of data?.images ?? []) {
        let origin = '';
        try {
            origin = new URL(src).origin;
        }
        catch {
            continue;
        }
        if (!obs.firstParty.has(origin))
            continue;
        const url = obs.redactor.networkUrl(src);
        let failedLoad = false;
        for (const r of obs.requests.values()) {
            if (r.url !== url)
                continue;
            for (let x = r, n = 0; x && n < 10; x = x.redirectedTo ? obs.requests.get(x.redirectedTo) : undefined, n++)
                if (failed(x))
                    failedLoad = true;
            if (failedLoad)
                break;
        }
        if (!failedLoad)
            obs.quality.brokenImage(url, action ? { actionId: action.actionId, confidence: 'inferred', reason: 'the image failed while the action ran and settled' } : { confidence: 'unattributed', reason: 'no action in progress' });
    }
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
