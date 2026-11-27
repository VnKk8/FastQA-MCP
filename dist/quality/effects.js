/** Steps whose page-side effects are read with the probe. */
export const PROBED = /^(click|dblclick|press|select|check|uncheck|upload)$/;
const READ = /^(GET|HEAD|OPTIONS)$/;
/** a submission: a first-party call that is not a read and not a page navigation */
const submission = (r) => !READ.test(r.method) && !r.navigation;
export const failed = (r) => (r.status !== undefined && r.status >= 400) || (!!r.failure && !r.aborted);
/** the call has an outcome: a status, or a transport failure / abort */
const settled = (r) => r.status !== undefined || !!r.failure;
/** The failed first-party calls of the action, documents included (an error page is still a failure). Failures first. */
export function failures(e) {
    return e.requests.filter((r) => failed(r) && !/favicon/.test(r.path));
}
const told = (p) => !!p && (p.messages.length > 0 || p.texts.length > 0 || p.invalid.length > 0 || p.marked > 0 || p.changed);
/** Anything the person would notice, from the action until the judgement. undefined: no probe, no judgement. */
export function feedback(e) {
    if (e.navigatedTo || e.newPage || e.events.length)
        return true;
    if (!e.probe)
        return undefined;
    return told(e.probe) || told(e.after);
}
/**
 * Failed submissions the person was not told about. Reads (GET) are left out: pages retry them, often seconds later.
 * So is a submission the page sent again with the same identity (a retry in progress); an unknown body is never a retry.
 * `sentAgain` comes from the observer's index; a list of requests is still accepted (tests, older callers).
 */
export function silentFailures(e, sentAgain) {
    if (!PROBED.test(e.action.do) || feedback(e) !== false)
        return [];
    const again = typeof sentAgain === 'function' ? sentAgain : retriedIn([...sentAgain], e.bodyKey);
    return failures(e).filter((r) => submission(r) && r.association.confidence !== 'ambiguous' && !again(r));
}
function retriedIn(all, key) {
    return (r) => {
        const k = key(r);
        return !!k && !k.startsWith('unknown:') && all.some((x) => x !== r && x.method === r.method && key(x) === k && x.startedMs > r.startedMs);
    };
}
const changedIn = (p) => !!p && (p.mutations > 0 || p.scrolled || p.changed || p.invalid.length > 0 || p.messages.length > 0 || p.texts.length > 0 || p.marked > 0);
/**
 * A click on a button or link that did nothing at all while it was watched: no request, no navigation, no DOM change,
 * no change to form values or popovers, no dialog, download, file picker or scroll. Links that leave the page by other
 * means (download, mailto:, tel:, blob:) and same-page links are never judged.
 */
export function deadClick(e) {
    const p = e.probe;
    if (!p || !/^(click|dblclick)$/.test(e.action.do) || !p.click)
        return false;
    const c = p.click;
    if (c.download || /^(#|mailto:|tel:|sms:|blob:|data:)/i.test(c.href) || c.type === 'reset')
        return false;
    const control = c.tag === 'button' || ['button', 'link', 'menuitem'].includes(c.role)
        || (c.tag === 'input' && ['submit', 'button', 'image'].includes(c.type))
        || (c.tag === 'a' && !!c.href);
    if (!control)
        return false;
    return !e.requests.length && !e.navigatedTo && !e.newPage && !e.events.length && !changedIn(p) && !changedIn(e.gap);
}
/**
 * Groups of identical submissions (same method, URL and body) sent by the one action, none of which failed. Requests that
 * carry the same idempotency key are a safe retry by design and never a duplicate; unknown bodies never match.
 */
export function duplicates(e) {
    const groups = new Map();
    for (const r of e.requests) {
        if (!submission(r))
            continue;
        const key = e.bodyKey(r);
        if (key.startsWith('idem:') || key.startsWith('unknown:'))
            continue;
        const k = `${r.method} ${key}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.values()].filter((g) => g.length > 1 && !g.some(failed));
}
/** What the person was told right after the action: its own window and the gap until the next action. Not later. */
export function outcomeTold(e) {
    const out = { success: [], error: [], mixed: false, strong: false, validation: false };
    for (const p of [e.probe, e.gap]) {
        if (!p)
            continue;
        if (p.invalid.length || p.marked)
            out.validation = true;
        for (const m of p.messages) {
            if (!m.tone)
                continue;
            if (m.tone === 'mixed') {
                out.mixed = true;
                continue;
            }
            // strong only when classes or data attributes said it; a role (alert, status) says nothing about success or error
            if (m.tone === 'success' || m.tone === 'error') {
                out[m.tone].push(m.text);
                out.strong ||= m.by === 'class';
            }
        }
        for (const t of p.toned ?? []) {
            if (t.tone === 'mixed')
                out.mixed = true;
            else if (t.tone === 'success' || t.tone === 'error') {
                out[t.tone].push(t.text);
                out.strong ||= t.by === 'class';
            }
        }
    }
    out.success = [...new Set(out.success)];
    out.error = [...new Set(out.error)];
    return out;
}
/** Feedback categories of an action, for behaviour signatures: success, error, validation, navigation, new tab, dialog, download. */
export function toldOf(e) {
    const t = outcomeTold(e);
    const out = new Set();
    if (t.success.length && !t.mixed)
        out.add('success');
    if (t.error.length && !t.mixed)
        out.add('error');
    if (t.validation)
        out.add('validation');
    if (e.navigatedTo)
        out.add('navigation');
    if (e.newPage)
        out.add('new tab');
    for (const ev of e.events)
        out.add(ev.kind === 'picker' ? 'file picker' : ev.kind);
    return [...out];
}
/**
 * FALSE-SUCCESS: the submissions of the action failed (none succeeded; none declared expected), and right after the
 * action the page showed a success message and no error message. An unrelated later toast does not count: only the action's own window
 * and the gap until the next action. Contradictory or mixed messages: no finding.
 */
export function falseSuccess(e, j) {
    if (!PROBED.test(e.action.do))
        return undefined;
    const subs = e.requests.filter((r) => submission(r) && r.association.confidence !== 'ambiguous');
    // a failed submission the page sent again (an optimistic UI that retries) may have succeeded later: not this rule
    const bad = subs.filter((r) => failed(r) && !/favicon/.test(r.path) && !j.expected(r) && !j.sentAgain?.(r));
    // a success message after a mixed outcome may well be about the part that worked: that is a partial success, not this
    if (!bad.length || subs.some((r) => r.status !== undefined && r.status < 400 && !r.failure))
        return undefined;
    const t = outcomeTold(e);
    if (!t.success.length || t.error.length || t.mixed || t.validation)
        return undefined;
    return { rec: bad[0], said: t.success[0], strong: t.strong };
}
/**
 * FALSE-FAILURE: every call of the action has an outcome, none failed, at least one was a submission, and right after the
 * action the page showed an error message (not form validation) and no success message. HTTP 2xx is not proof that the
 * business operation succeeded, so this stays a low-confidence lead.
 */
export function falseFailure(e, j) {
    if (!PROBED.test(e.action.do))
        return undefined;
    const subs = e.requests.filter(submission);
    if (!subs.length || e.requests.some((r) => failed(r) || !settled(r)))
        return undefined;
    const t = outcomeTold(e);
    if (!t.error.length || t.success.length || t.mixed || t.validation)
        return undefined;
    // another call that failed meanwhile (background or ambiguous, so not in this action's list) may be what the message
    // is about: then it is no lead. Asked only now, when everything else points to a false failure.
    if (j?.failedSince?.(e.action.startedMs))
        return undefined;
    return { rec: subs[0], said: t.error[0], strong: t.strong };
}
/**
 * A partial success: one action sent submissions to different endpoints with mixed outcomes: at least one succeeded and
 * at least one failed. A failed call sent again successfully to the same endpoint is a retry, not a partial success.
 * Not a finding of its own: it is said in the explanation of the failed call's finding (see summary.ts).
 */
export function partialSuccess(e) {
    const subs = e.requests.filter((r) => submission(r) && r.association.confidence !== 'ambiguous');
    const bad = subs.filter(failed);
    const ok = subs.filter((r) => r.status !== undefined && r.status < 400 && !r.failure);
    const same = (a, b) => a.method === b.method && a.route === b.route;
    const okElsewhere = ok.filter((o) => !bad.some((b) => same(o, b)));
    const badElsewhere = bad.filter((b) => !ok.some((o) => same(o, b)));
    return okElsewhere.length && badElsewhere.length ? { ok: okElsewhere, bad: badElsewhere } : undefined;
}
/**
 * STUCK-LOADING: progress indicators that appeared with the action (not there when it started), were still shown when
 * it had settled, and are still shown at judgement although every call of the action has an outcome. An action without
 * calls, or with a call still pending, is never judged: its loading state is unknown, not stuck.
 */
export function stuckLoading(e) {
    const own = e.probe?.busy ?? [];
    // without the window before the action (it could not be read) an indicator may have been there already: no judgement
    if (!own.length || !e.before || !e.requests.length || !e.requests.every(settled))
        return [];
    const before = new Set(e.before?.busy ?? []);
    const last = new Set(e.last?.busy ?? []);
    return own.filter((id) => !before.has(id) && last.has(id));
}
