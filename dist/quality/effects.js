/** Steps whose page-side effects are read with the probe. */
export const PROBED = /^(click|dblclick|press|select|check|uncheck|upload)$/;
const READ = /^(GET|HEAD|OPTIONS)$/;
export const failed = (r) => (r.status !== undefined && r.status >= 400) || (!!r.failure && !r.aborted);
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
 * So is a submission the page sent again after it failed (a retry in progress).
 */
export function silentFailures(e, all) {
    if (!PROBED.test(e.action.do) || feedback(e) !== false)
        return [];
    const later = [...all];
    return failures(e).filter((r) => !READ.test(r.method) && !r.navigation && r.association.confidence !== 'ambiguous'
        && !later.some((x) => x !== r && x.method === r.method && x.route === r.route && x.startedMs > r.startedMs));
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
/** Groups of identical submissions (same method, URL and body) sent by the one action, none of which failed. */
export function duplicates(e) {
    const groups = new Map();
    for (const r of e.requests) {
        if (READ.test(r.method) || r.navigation)
            continue;
        const k = `${r.method} ${e.bodyKey(r)}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.values()].filter((g) => g.length > 1 && !g.some(failed));
}
