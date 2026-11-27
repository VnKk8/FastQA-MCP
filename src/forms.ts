// Form test ideas from the constraints a page declares (required, type, min/max/step, minlength/maxlength, pattern,
// options, accept). Read from snapshot lines fastqa already has: no extra page traversal, nothing is filled or submitted.
// These are suggestions for checks, with their provenance: what the HTML declares is a client constraint; whether the
// server enforces it is not known until a check shows it.
import { redactor } from './privacy/redact.js';

export interface Field {
  ref: string; role: string; name: string;
  required: boolean; disabled: boolean;
  type?: string; min?: string; max?: string; step?: string; minlength?: number; maxlength?: number; pattern?: string;
  options?: string[]; accept?: string; multiple?: boolean;
  /** the browser's validation message, when the snapshot showed one */
  invalid?: string;
}
export interface Idea { field: string; ref: string; what: string; values: string[] }
export interface FormIdeas { fields: number; ideas: Idea[]; omitted: number; notEditable: string[] }

/** Ideas shown at most; the rest are counted. */
export const MAX_IDEAS = 20;
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'file']);
const SENSITIVE = /pass|pwd|secret|token|otp|pin\b|cvv|cvc|card ?number|iban|ssn/i;

/** The fields of snapshot lines (`e15 textbox "Email" [required] type:email`). Lines that are not fields are skipped. */
export function parseFields(lines: string[]): Field[] {
  const out: Field[] = [];
  for (const l of lines) {
    const m = /^\s*(e\d+) (\S+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(l);
    if (!m || !FIELD_ROLES.has(m[2])) continue;
    let name = ''; try { name = m[3] ? JSON.parse(`"${m[3]}"`) : ''; } catch { name = m[3] ?? ''; }
    const rest = m[4] ?? '';
    const tok = (k: string) => { const t = new RegExp(`(?:^| )${k}:("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(rest); if (!t) return undefined; try { return t[1].startsWith('"') ? JSON.parse(t[1]) : t[1]; } catch { return t[1]; } };
    const num = (k: string) => { const v = tok(k); return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined; };
    // options can contain spaces ("United States"): they run until the next [state] or the end of the line
    const opts = /(?:^| )options:(.*?)(?= \[|$)/.exec(rest)?.[1];
    out.push({
      ref: m[1], role: m[2], name,
      required: /\[required\]/.test(rest), disabled: /\[disabled\]/.test(rest),
      type: tok('type'), min: tok('min'), max: tok('max'), step: tok('step'), minlength: num('minlength'), maxlength: num('maxlength'), pattern: tok('pattern'),
      options: opts ? opts.split('|').filter((o) => o && o !== '…') : undefined,
      accept: tok('accept'), multiple: /\[multiple\]/.test(rest), invalid: tok('invalid'),
    });
  }
  return out;
}

const q = JSON.stringify;
const isNum = (s?: string) => s !== undefined && /^-?\d+(\.\d+)?$/.test(s);
const decimals = (s: string) => (s.split('.')[1] ?? '').length;
const fmt = (n: number, d: number) => String(Number(n.toFixed(d)));
function addDays(iso: string, days: number): string | undefined {
  if (!/^\d{4}-\d\d-\d\d$/.test(iso)) return undefined;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** Ideas for one field, most useful first. Sensitive fields get length ideas only, never values. */
function ideasFor(f: Field): Idea[] {
  const label = f.name || f.ref;
  const out: Idea[] = [];
  const add = (what: string, values: string[] = []) => out.push({ field: label, ref: f.ref, what, values });
  const secret = SENSITIVE.test(f.name) || redactor.isSecretKey(f.name);
  if (f.role === 'checkbox' || f.role === 'switch' || f.role === 'radio') {
    if (f.required) add('required: leave it unchecked and submit; the form should refuse');
    return out;
  }
  if (f.role === 'file') {
    const acc = (f.accept ?? '').toLowerCase();
    const inside = /image|\.png|\.jpe?g|\.gif|\.webp/.test(acc) ? 'photo.png' : /pdf/.test(acc) ? 'doc.pdf' : /text|\.txt|\.csv/.test(acc) ? 'data.csv' : undefined;
    const outside = /text|\.txt/.test(acc) ? 'virus.exe' : 'notes.txt';
    if (acc) add(`accept ${acc}: one accepted file, one that is not (the browser does not stop the second; the page or server should)`, [inside ?? 'a file of an accepted type', outside]);
    if (f.multiple) add('several files at once', [inside ? `${inside.replace('.', '-1.')}|${inside.replace('.', '-2.')}` : 'a.png|b.png']);
    add('size: the page declares no size limit; try one large file only if a limit is known (e.g. "big.jpg:6MB")');
    if (f.required) add('required: submit with no file chosen');
    return out;
  }
  if (f.role === 'combobox' || f.role === 'listbox') {
    if (f.options?.length) add(`options seen: ${f.options.slice(0, 5).map((o) => q(o)).join(', ')}${f.options.length > 5 ? ', …' : ''}; try the first and the last`, [f.options[0], f.options[f.options.length - 1]].filter((v, i, a) => a.indexOf(v) === i));
    if (f.required) add('required: keep the empty choice, if there is one, and submit');
    return out;
  }
  // text-like inputs
  if (f.required) add('required: empty, and only spaces', ['', '   ']);
  const t = (f.type ?? '').toLowerCase();
  if (t === 'number' || f.role === 'slider') {
    const step = isNum(f.step) ? Number(f.step) : undefined;
    const d = Math.max(decimals(f.min ?? '0'), decimals(f.max ?? '0'), decimals(f.step ?? '1'));
    const delta = step && step > 0 ? step : d ? 10 ** -d : 1;
    if (isNum(f.min)) add(`min ${f.min}: just below, at`, [fmt(Number(f.min) - delta, d), f.min!]);
    if (isNum(f.max)) add(`max ${f.max}: at, just above`, [f.max!, fmt(Number(f.max) + delta, d)]);
    if (step && step > 0 && (isNum(f.min) || isNum(f.max))) add(`step ${f.step}: a value between two steps`, [fmt((isNum(f.min) ? Number(f.min) : 0) + step / 2, d + 1)]);
    return out;
  }
  if (t === 'date') {
    if (f.min) { const b = addDays(f.min, -1); add(`min ${f.min}: the day before, the day itself`, b ? [b, f.min] : [f.min]); }
    if (f.max) { const a = addDays(f.max, 1); add(`max ${f.max}: the day itself, the day after`, a ? [f.max, a] : [f.max]); }
    return out;
  }
  if (['time', 'datetime-local', 'month', 'week'].includes(t)) {
    if (f.min || f.max) add(`${t} limits ${f.min ?? '-'} … ${f.max ?? '-'}: at each limit; values outside need a manual check of the format`, [f.min, f.max].filter((v): v is string => !!v));
    return out;
  }
  if (!secret && t === 'email') add('type email: a valid address, one the browser rejects', ['user@example.test', 'user@']);
  if (!secret && t === 'url') add('type url: a valid URL, one the browser rejects', ['https://example.test', 'example']);
  if (f.maxlength !== undefined) add(`maxlength ${f.maxlength}: exactly ${f.maxlength} characters, then ${f.maxlength + 1} (the field keeps ${f.maxlength}; an emoji counts as 2)`, secret ? [] : ['x'.repeat(Math.min(f.maxlength, 40)) + (f.maxlength > 40 ? `… (${f.maxlength} in all)` : '')]);
  if (f.minlength !== undefined && f.minlength > 0) add(`minlength ${f.minlength}: ${f.minlength - 1} character${f.minlength - 1 === 1 ? '' : 's'}, then ${f.minlength}`);
  if (f.pattern) add(`pattern ${f.pattern}: one value that matches and one that does not (fastqa does not generate values for patterns)`);
  return out;
}

/** Test ideas for the fields of a page, bounded. Disabled fields are listed, not tested. */
export function formIdeas(lines: string[], max = MAX_IDEAS): FormIdeas {
  const fields = parseFields(lines);
  const notEditable = fields.filter((f) => f.disabled).map((f) => f.name || f.ref);
  const all = fields.filter((f) => !f.disabled).flatMap(ideasFor);
  const required = fields.filter((f) => f.required && !f.disabled).length;
  if (required >= 2) all.push({ field: '(form)', ref: '', what: `all ${required} required fields empty, then submit: each should be flagged`, values: [] });
  return { fields: fields.length, ideas: all.slice(0, max), omitted: Math.max(0, all.length - max), notEditable };
}

/** The text view of the ideas, grouped by field. */
export function renderFormIdeas(r: FormIdeas): string {
  if (!r.fields) return 'forms: no form fields in the current snapshot (open the page with the form, or take a snapshot, then ask again)';
  const head = `forms: ${r.ideas.length + r.omitted} test idea${r.ideas.length + r.omitted === 1 ? '' : 's'} for ${r.fields} field${r.fields === 1 ? '' : 's'}${r.omitted ? ` (${r.ideas.length} shown, ${r.omitted} more)` : ''} — from the constraints the page declares; nothing was filled or submitted`;
  const byField = new Map<string, Idea[]>();
  for (const i of r.ideas) byField.set(`${i.field}${i.ref ? ` (${i.ref})` : ''}`, [...(byField.get(`${i.field}${i.ref ? ` (${i.ref})` : ''}`) ?? []), i]);
  const lines = [...byField].map(([f, list]) => `${q(f).slice(1, -1)}: ${list.map((i) => `${i.what}${i.values.length ? ` → ${i.values.map((v) => q(v)).join(', ')}` : ''}`).join('; ')}`);
  return [
    head,
    ...lines,
    ...(r.notEditable.length ? [`not editable here (disabled): ${r.notEditable.slice(0, 8).map((n) => q(n)).join(', ')}`] : []),
    'Provenance: client constraints declared in the page; server enforcement is not verified. Check the safe ones first (fill, then expect the field\'s invalid:"…" message); a submission that creates data is a separate, deliberate test.',
  ].join('\n');
}
