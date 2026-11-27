// What one action did, gathered when its batch ends. The QA rules (engine.ts) and the fact lines the agent reads
// (facts.ts) both judge from this, so a finding and the line next to its step never disagree.
import type { ActionRecord, RequestRecord } from '../observation/types.js';
import type { ProbeData } from '../probe.js';
import type { SessionEvent } from '../session.js';

export interface ActionEffects {
  action: ActionRecord;
  /** first-party fetch / XHR / document requests attributed to this action (not ambiguous ones), as known at judgement */
  requests: RequestRecord[];
  /** a key per request (URL and body hash), for repeated identical submissions; never the body itself */
  bodyKey: (r: RequestRecord) => string;
  /** the page's URL changed (redacted path), or undefined */
  navigatedTo?: string;
  newPage: boolean;
  /** dialogs, downloads and file pickers during the action and until the next action that is watched */
  events: SessionEvent[];
  /** the action's own window, from its start until it settled; undefined when no probe could be read */
  probe?: ProbeData;
  /** from the end of its own window until the next watched action started (or the batch ended) */
  gap?: ProbeData;
  /** everything after its own window until the judgement (the gap and later windows) */
  after?: ProbeData;
  /** how long the action was watched for "no effect", in ms */
  watchedMs: number;
}

/** Steps whose page-side effects are read with the probe. */
export const PROBED = /^(click|dblclick|press|select|check|uncheck|upload)$/;
const READ = /^(GET|HEAD|OPTIONS)$/;

export const failed = (r: RequestRecord) => (r.status !== undefined && r.status >= 400) || (!!r.failure && !r.aborted);

/** The failed first-party calls of the action, documents included (an error page is still a failure). Failures first. */
export function failures(e: ActionEffects): RequestRecord[] {
  return e.requests.filter((r) => failed(r) && !/favicon/.test(r.path));
}

const told = (p?: ProbeData) => !!p && (p.messages.length > 0 || p.texts.length > 0 || p.invalid.length > 0 || p.marked > 0 || p.changed);

/** Anything the person would notice, from the action until the judgement. undefined: no probe, no judgement. */
export function feedback(e: ActionEffects): boolean | undefined {
  if (e.navigatedTo || e.newPage || e.events.length) return true;
  if (!e.probe) return undefined;
  return told(e.probe) || told(e.after);
}

/**
 * Failed submissions the person was not told about. Reads (GET) are left out: pages retry them, often seconds later.
 * So is a submission the page sent again after it failed (a retry in progress).
 */
export function silentFailures(e: ActionEffects, all: Iterable<RequestRecord>): RequestRecord[] {
  if (!PROBED.test(e.action.do) || feedback(e) !== false) return [];
  const later = [...all];
  return failures(e).filter((r) => !READ.test(r.method) && !r.navigation && r.association.confidence !== 'ambiguous'
    && !later.some((x) => x !== r && x.method === r.method && x.route === r.route && x.startedMs > r.startedMs));
}

const changedIn = (p?: ProbeData) => !!p && (p.mutations > 0 || p.scrolled || p.changed || p.invalid.length > 0 || p.messages.length > 0 || p.texts.length > 0 || p.marked > 0);

/**
 * A click on a button or link that did nothing at all while it was watched: no request, no navigation, no DOM change,
 * no change to form values or popovers, no dialog, download, file picker or scroll. Links that leave the page by other
 * means (download, mailto:, tel:, blob:) and same-page links are never judged.
 */
export function deadClick(e: ActionEffects): boolean {
  const p = e.probe;
  if (!p || !/^(click|dblclick)$/.test(e.action.do) || !p.click) return false;
  const c = p.click;
  if (c.download || /^(#|mailto:|tel:|sms:|blob:|data:)/i.test(c.href) || c.type === 'reset') return false;
  const control = c.tag === 'button' || ['button', 'link', 'menuitem'].includes(c.role)
    || (c.tag === 'input' && ['submit', 'button', 'image'].includes(c.type))
    || (c.tag === 'a' && !!c.href);
  if (!control) return false;
  return !e.requests.length && !e.navigatedTo && !e.newPage && !e.events.length && !changedIn(p) && !changedIn(e.gap);
}

/** Groups of identical submissions (same method, URL and body) sent by the one action, none of which failed. */
export function duplicates(e: ActionEffects): RequestRecord[][] {
  const groups = new Map<string, RequestRecord[]>();
  for (const r of e.requests) {
    if (READ.test(r.method) || r.navigation) continue;
    const k = `${r.method} ${e.bodyKey(r)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].filter((g) => g.length > 1 && !g.some(failed));
}
