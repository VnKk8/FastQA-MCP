// The short fact lines that follow a step in an act result ("  ↳ …") and the page line of open. Each one replaces a
// call the agent would otherwise make (evidence, snapshot, a retry) and appears only when there is something to say.
import type { RequestRecord } from './observation/types.js';
import type { SessionEvent } from './session.js';
import { deadClick, failed, type ActionEffects } from './quality/effects.js';

const q = JSON.stringify;
const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const FACT = '  ↳ ';

/** A short reason from a failed call's body, only when payload capture made the (sanitized) body available. */
export function reasonOf(r: RequestRecord): string | undefined {
  const j = r.body?.state === 'captured' ? r.body.json : undefined;
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>;
  for (const k of ['error', 'message', 'title', 'code', 'reason']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return clip(v, 60);
    if (v && typeof v === 'object' && typeof (v as any).message === 'string') return clip((v as any).message, 60);
  }
  return undefined;
}

/** A dialog, download or file picker, as the agent reads it. */
export function eventText(ev: SessionEvent): string {
  if (ev.kind === 'download') return `download ${q(ev.text)} started`;
  if (ev.kind === 'picker') return 'a file picker opened (use the upload step)';
  if (ev.type === 'beforeunload') return 'the page asked before leaving (beforeunload); accepted';
  return `${ev.type} ${q(ev.text)} was dismissed`;
}

/**
 * What one action did, in one line; undefined when there is nothing worth a line. `own`: the dialogs, downloads and
 * pickers of this step itself. `gone`: messages that went away in its window or right after it.
 */
export function effectLine(e: ActionEffects, own: SessionEvent[], gone: Set<string>): string | undefined {
  const parts: string[] = [];
  // requests: identical ones grouped, failed ones first; document navigations only when they failed (the navigation
  // itself is said below)
  const shown = e.requests.filter((r) => !r.navigation || failed(r));
  const groups = new Map<string, RequestRecord[]>();
  for (const r of shown) {
    const k = `${r.method} ${r.route} ${r.status ?? (r.aborted ? 'aborted' : r.failure ? 'failed' : 'pending')}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const list = [...groups.entries()].sort((a, b) => Number(b[1].some(failed)) - Number(a[1].some(failed)));
  for (const [k, g] of list.slice(0, 3)) {
    const r = g[0];
    const reason = reasonOf(r);
    const ms = r.endedMs !== undefined || r.responseMs !== undefined ? Math.round((r.responseMs ?? r.endedMs!) - r.startedMs) : undefined;
    parts.push(g.length > 1 ? `${k} ×${g.length}` : `${k}${reason ? ` ${q(reason)}` : ''}${ms !== undefined ? ` ${ms}ms` : ''}`);
  }
  if (list.length > 3) parts.push(`+${list.length - 3} more calls`);
  if (e.navigatedTo) parts.push(`→ ${e.navigatedTo}`);
  if (e.newPage) parts.push('a new tab opened');
  for (const ev of own.slice(0, 3)) parts.push(eventText(ev));
  const p = e.probe;
  if (p) {
    const seen = new Set<string>();
    for (const m of p.messages.filter((m) => gone.has(m.id))) {
      if (seen.has(m.text) || seen.size >= 2) continue;
      seen.add(m.text); parts.push(`${m.kind} ${q(m.text)} came and went`);
    }
    if (p.invalid.length && !e.requests.length && !e.navigatedTo) {
      const fields = p.invalid.slice(0, 4).map((f) => `${q(f.name || 'unnamed field')} (${f.message})`).join(', ');
      parts.push(`nothing sent: the browser blocked the form. Invalid: ${fields}${p.invalid.length > 4 ? `, +${p.invalid.length - 4} more` : ''}`);
    }
  }
  if (deadClick(e)) parts.push(`no effect within ${e.watchedMs}ms: no request, no page change`);
  return parts.length ? FACT + parts.join(' · ') : undefined;
}

/** Snapshot elements whose name is close to a target that matched nothing: "button \"Login\" e12". */
export function closest(target: string, lines: string[], max = 3): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
  const t = norm(target); const tw = words(target);
  if (!t) return [];
  const scored: Array<{ s: number; text: string }> = [];
  for (const l of lines) {
    const m = /^\s*(e\d+) (\S+) "((?:[^"\\]|\\.)*)"/.exec(l);
    if (!m) continue;
    const name = m[3]; const n = norm(name);
    if (!n) continue;
    let s = 0;
    if (n === t) s = 1;
    else if (n.includes(t) || t.includes(n)) s = 0.6 + 0.35 * Math.min(n.length, t.length) / Math.max(n.length, t.length);
    else {
      const nw = words(name); const common = [...tw].filter((w) => nw.has(w)).length;
      s = Math.max(common / Math.max(tw.size, nw.size, 1), 1 - lev(n, t) / Math.max(n.length, t.length));
    }
    if (s >= 0.5) scored.push({ s, text: `${m[2]} ${q(name)} ${m[1]}` });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.text);
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 20) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export interface PageFacts { forms: number; fields: number; required: number; botCheck?: string; captcha: boolean }

/** The one line about a page that open adds, or '' when there is nothing to say. `ideas`: form test ideas available. */
export function pageLine(f?: PageFacts, ideas = 0): string {
  if (!f) return '';
  if (f.botCheck) return `\n↳ bot check: this is not the site's own page (${q(f.botCheck)}). fastqa does not try to get past it`;
  const parts: string[] = [];
  if (f.forms) parts.push(`${f.forms} form${f.forms === 1 ? '' : 's'}, ${f.fields} field${f.fields === 1 ? '' : 's'} (${f.required} required)${ideas ? `, ${ideas} test idea${ideas === 1 ? '' : 's'} in evidence view "forms"` : ''}`);
  if (f.captcha) parts.push('a captcha is shown (fastqa does not solve it)');
  return parts.length ? `\n↳ page: ${parts.join(' · ')}` : '';
}
