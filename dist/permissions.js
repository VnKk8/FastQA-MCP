// Explicit role expectations (expect_permission): authorized QA verification, not security scanning. The caller names the
// operation and whether the current role (a label the caller supplies: flow "role" or --role) should be allowed or denied.
// fastqa never infers permissions from role names, never retries a denied operation, never probes other endpoints and
// stores no credentials, tokens or cookies. Evidence kinds stay apart: the backend's answer, the UI alone, not tested.
/**
 * An operation: an HTTP method in any case followed by a path or URL ("post /api/x", "DELETE /api/users/7"), or a bare
 * path ("/api/x"). Anything else is a control ("Delete user" is a button, not a DELETE request to "user").
 */
export function operationOf(op) {
    const t = op.trim();
    const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:\/|https?:\/\/)\S*)$/i.exec(t);
    if (m)
        return { method: m[1].toUpperCase(), path: m[2] };
    return /^\/\S*$/.test(t) ? { path: t } : undefined;
}
/**
 * What one response says about permission. A status is evidence, not proof of the server's authorization logic, so only
 * the statuses this backend is configured to answer a denial with prove one (403 by default; `permissions.deniedStatuses`).
 * A 401 is a missing or expired session, a 404 a missing or hidden resource, a 405 a wrong method, a redirect usually
 * a login page: unless configured as a denial, each is inconclusive, never a pass.
 */
function category(a, denied) {
    const status = a.status;
    if (status === 0)
        return 'failed';
    if (denied.includes(status))
        return 'denied';
    if (status === 401 || status === 403 || status === 404 || status === 405)
        return 'unclear';
    if (a.redirected || (status >= 300 && status < 400))
        return 'redirected';
    if (status < 300)
        return 'accepted';
    if (status >= 500)
        return 'error';
    return 'rejected';
}
const UNCLEAR = {
    401: 'a 401 is a missing or expired session, not a role decision; if this backend answers role denials with 401, add it to permissions.deniedStatuses',
    403: 'this backend is not configured to answer denials with 403 (permissions.deniedStatuses)',
    404: 'a 404 can mean the resource does not exist as well as that it is hidden; check with a role that may see it, or add 404 to permissions.deniedStatuses',
    405: 'a 405 says the method is wrong, not that the role is refused; add it to permissions.deniedStatuses only if this backend uses it for denials',
};
/** The backend's answer (latest matching response) against the expectation. */
export function judgeBackend(expected, answers, deniedStatuses = [403]) {
    if (!answers.length)
        return { observed: 'no matching request', provenance: 'none', verdict: 'not tested', note: 'perform the operation in this batch first; fastqa does not send it by itself' };
    const last = answers[answers.length - 1];
    const a = typeof last === 'number' ? { status: last } : last;
    const st = a.status;
    const c = category(a, deniedStatuses);
    const observed = st === 0 ? 'no response (network failure)' : `HTTP ${st}${a.redirected ? ' after a redirect' : ''}`;
    if (c === 'error' || c === 'failed')
        return { observed, provenance: 'backend', verdict: 'inconclusive', note: 'a server or network error shows nothing about the permission' };
    if (c === 'rejected')
        return { observed, provenance: 'backend', verdict: 'inconclusive', note: 'refused for another reason (validation or conflict): the permission is not shown' };
    if (c === 'unclear')
        return { observed, provenance: 'backend', verdict: 'inconclusive', note: UNCLEAR[st] };
    if (c === 'redirected')
        return { observed, provenance: 'backend', verdict: 'inconclusive', note: 'the request was redirected (often to a login page): neither an allowance nor a denial is shown' };
    if (expected === 'denied') {
        if (c === 'denied')
            return { observed, provenance: 'backend', verdict: 'pass', note: 'denied by the backend, as expected' };
        return { observed, provenance: 'backend', verdict: 'mismatch', note: 'the backend accepted it; whether data changed is not verified' };
    }
    if (c === 'accepted')
        return { observed, provenance: 'backend', verdict: 'pass', note: 'HTTP success; the effect on the data is not verified' };
    return { observed, provenance: 'backend', verdict: 'mismatch', note: 'denied by the backend' };
}
/** The UI alone: is the control there and usable for this role. Never proof that the backend protects the operation. */
export function judgeUi(expected, state) {
    const observed = state === 'available' ? 'control available' : state === 'disabled' ? 'control disabled' : 'control not shown';
    if (expected === 'denied') {
        return state === 'available'
            ? { observed, provenance: 'ui', verdict: 'mismatch', note: 'the control is offered to this role' }
            : { observed, provenance: 'ui', verdict: 'pass', note: 'UI only: a hidden or disabled control does not prove the endpoint is protected (backend not tested)' };
    }
    return state === 'available'
        ? { observed, provenance: 'ui', verdict: 'pass', note: 'UI only: the operation itself was not performed' }
        : { observed, provenance: 'ui', verdict: 'mismatch', note: `the control is ${state === 'disabled' ? 'disabled' : 'not shown'} for this role` };
}
/** The step line for one check: why it passed or failed, with its provenance. */
export function permissionText(c) {
    const who = c.role ? `role ${JSON.stringify(c.role)}` : 'no role label';
    const head = c.verdict === 'pass' ? `${who}: ${c.expected} as expected`
        : c.verdict === 'mismatch' ? `permission mismatch for ${who}: expected ${c.expected}`
            : c.verdict === 'not tested' ? `not tested for ${who}` : `inconclusive for ${who}: expected ${c.expected}`;
    return `${head} — ${c.observed} [${c.provenance === 'none' ? 'no evidence' : c.provenance}]${c.note ? `; ${c.note}` : ''}`;
}
/** Compact permission matrix (role × operation) for suite results; the provenance of each cell is shown. */
export function renderMatrix(checks) {
    if (!checks.length)
        return [];
    // a control fastqa cannot find reads exactly like one hidden for this role; when no role in the run saw it at all,
    // a wrong label or a wrong page is just as likely, and the matrix says so
    const seen = new Set(checks.filter((c) => c.provenance === 'ui' && c.observed !== 'control not shown').map((c) => c.operation.toLowerCase()));
    const unseen = (c) => c.provenance === 'ui' && c.observed === 'control not shown' && !seen.has(c.operation.toLowerCase());
    const rows = checks.slice(0, 50).map((c) => `  ${c.role || '(no role label)'} · ${c.operation} · expect ${c.expected} · ${c.observed} [${c.provenance === 'none' ? 'no evidence' : c.provenance}] · ${c.verdict.toUpperCase()}${unseen(c) ? ' (not shown for any role in this run: check the label)' : ''}`);
    const bad = checks.filter((c) => c.verdict !== 'pass').length;
    return [`permissions: ${checks.length} check${checks.length === 1 ? '' : 's'}, ${bad ? `${bad} not passed` : 'all passed'} (expected vs observed; UI-only evidence is marked [ui])`, ...rows, ...(checks.length > 50 ? [`  … ${checks.length - 50} more`] : [])];
}
