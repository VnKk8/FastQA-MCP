// Explicit role expectations (expect_permission): authorized QA verification, not security scanning. The caller names the
// operation and whether the current role (a label the caller supplies: flow "role" or --role) should be allowed or denied.
// fastqa never infers permissions from role names, never retries a denied operation, never probes other endpoints and
// stores no credentials, tokens or cookies. Evidence kinds stay apart: the backend's answer, the UI alone, not tested.

export type Expectation = 'allowed' | 'denied';
export type Provenance = 'backend' | 'ui' | 'none';
export type Verdict = 'pass' | 'mismatch' | 'inconclusive' | 'not tested';
export interface PermissionCheck {
  role: string; operation: string; expected: Expectation;
  observed: string; provenance: Provenance; verdict: Verdict; note?: string;
}

/**
 * An operation: an HTTP method in any case followed by a path or URL ("post /api/x", "DELETE /api/users/7"), or a bare
 * path ("/api/x"). Anything else is a control ("Delete user" is a button, not a DELETE request to "user").
 */
export function operationOf(op: string): { method?: string; path: string } | undefined {
  const t = op.trim();
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:\/|https?:\/\/)\S*)$/i.exec(t);
  if (m) return { method: m[1].toUpperCase(), path: m[2] };
  return /^\/\S*$/.test(t) ? { path: t } : undefined;
}

/** What one response says about permission. A status is evidence, not proof of the server's authorization logic. */
function category(status: number): 'accepted' | 'denied' | 'hidden' | 'rejected' | 'error' | 'failed' {
  if (status === 0) return 'failed';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404 || status === 405) return 'hidden';
  if (status < 400) return 'accepted';
  if (status >= 500) return 'error';
  return 'rejected';
}

/** The backend's answer (latest matching response) against the expectation. */
export function judgeBackend(expected: Expectation, statuses: number[]): Pick<PermissionCheck, 'observed' | 'provenance' | 'verdict' | 'note'> {
  if (!statuses.length) return { observed: 'no matching request', provenance: 'none', verdict: 'not tested', note: 'perform the operation in this batch first; fastqa does not send it by itself' };
  const st = statuses[statuses.length - 1];
  const c = category(st);
  const observed = st === 0 ? 'no response (network failure)' : `HTTP ${st}`;
  if (c === 'error' || c === 'failed') return { observed, provenance: 'backend', verdict: 'inconclusive', note: 'a server or network error shows nothing about the permission' };
  if (c === 'rejected') return { observed, provenance: 'backend', verdict: 'inconclusive', note: 'refused for another reason (validation or conflict): the permission is not shown' };
  if (expected === 'denied') {
    if (c === 'denied') return { observed, provenance: 'backend', verdict: 'pass', note: 'denied by the backend, as expected' };
    if (c === 'hidden') return { observed, provenance: 'backend', verdict: 'pass', note: `treated as denied: the backend hides the resource (${st})` };
    return { observed, provenance: 'backend', verdict: 'mismatch', note: 'the backend accepted it; whether data changed is not verified' };
  }
  if (c === 'accepted') return { observed, provenance: 'backend', verdict: 'pass', note: 'HTTP success; the effect on the data is not verified' };
  return { observed, provenance: 'backend', verdict: 'mismatch', note: c === 'denied' ? 'denied by the backend' : `refused by the backend (${st})` };
}

/** The UI alone: is the control there and usable for this role. Never proof that the backend protects the operation. */
export function judgeUi(expected: Expectation, state: 'available' | 'disabled' | 'hidden'): Pick<PermissionCheck, 'observed' | 'provenance' | 'verdict' | 'note'> {
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
export function permissionText(c: PermissionCheck): string {
  const who = c.role ? `role ${JSON.stringify(c.role)}` : 'no role label';
  const head = c.verdict === 'pass' ? `${who}: ${c.expected} as expected`
    : c.verdict === 'mismatch' ? `permission mismatch for ${who}: expected ${c.expected}`
    : c.verdict === 'not tested' ? `not tested for ${who}` : `inconclusive for ${who}: expected ${c.expected}`;
  return `${head} — ${c.observed} [${c.provenance === 'none' ? 'no evidence' : c.provenance}]${c.note ? `; ${c.note}` : ''}`;
}

/** Compact permission matrix (role × operation) for suite results; the provenance of each cell is shown. */
export function renderMatrix(checks: PermissionCheck[]): string[] {
  if (!checks.length) return [];
  // a control fastqa cannot find reads exactly like one hidden for this role; when no role in the run saw it at all,
  // a wrong label or a wrong page is just as likely, and the matrix says so
  const seen = new Set(checks.filter((c) => c.provenance === 'ui' && c.observed !== 'control not shown').map((c) => c.operation.toLowerCase()));
  const unseen = (c: PermissionCheck) => c.provenance === 'ui' && c.observed === 'control not shown' && !seen.has(c.operation.toLowerCase());
  const rows = checks.slice(0, 50).map((c) => `  ${c.role || '(no role label)'} · ${c.operation} · expect ${c.expected} · ${c.observed} [${c.provenance === 'none' ? 'no evidence' : c.provenance}] · ${c.verdict.toUpperCase()}${unseen(c) ? ' (not shown for any role in this run: check the label)' : ''}`);
  const bad = checks.filter((c) => c.verdict !== 'pass').length;
  return [`permissions: ${checks.length} check${checks.length === 1 ? '' : 's'}, ${bad ? `${bad} not passed` : 'all passed'} (expected vs observed; UI-only evidence is marked [ui])`, ...rows, ...(checks.length > 50 ? [`  … ${checks.length - 50} more`] : [])];
}
