// Small helpers for text that came from the page under test. Such text is data: it is bounded, kept on one line and
// stripped of control characters, so it can never start a line of its own in a result (a forged "QA: clean", say).

// C0 controls (tab included), DEL, C1 controls, line and paragraph separators, bidi overrides and isolates.
// Built from code points so no invisible character has to sit in the source.
const range = (a: number, b: number) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const CONTROLS = new RegExp(`[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}${range(0x2028, 0x2029)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]+`, 'g');

/** One line, no control characters, at most `max` characters (an ellipsis marks a cut). */
export function oneLine(s: unknown, max = 300): string {
  let t = String(s ?? '').replace(CONTROLS, ' ').replace(/ {2,}/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}

/** Quoted untrusted text: one line, bounded, JSON-quoted so the reader sees where it starts and ends. */
export function quoted(s: unknown, max = 60): string {
  return JSON.stringify(oneLine(s, max));
}
