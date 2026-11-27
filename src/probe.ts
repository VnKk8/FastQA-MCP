// A small listener installed in every document of the browser context (addInitScript). It records what happened in the
// page between two drain() calls: DOM changes, text that appeared or was revealed, messages (alerts, status lines,
// dialogs, toasts) that appeared or went, forms the browser refused to submit, form state and open popovers, the
// element a click landed on, images that could not be shown. fastqa drains it when an action starts and when it has
// settled: one evaluate each, about 1 ms. Must be fully self-contained: it is serialized into the page.

/**
 * What a message says about the outcome. From its classes and ARIA role first; its text only when the classes say nothing
 * (English always, plus a few common languages when the page declares one). 'mixed' = the text points both ways, which
 * never supports a finding. Absent = no tone could be told.
 */
export type Tone = 'success' | 'error' | 'warning' | 'mixed';
export interface ProbeMessage { id: string; kind: string; text: string; tone?: Tone; /** class: from classes or data attributes (strong); words: from its text only (weak) */ by?: 'class' | 'words' }
export interface ProbeData {
  /** DOM mutations in the window */
  mutations: number;
  /** text that appeared or was revealed in the window, clipped (a sign that the person was shown something) */
  texts: string[];
  /** alerts, status lines, dialogs and toasts that appeared or changed their text in the window */
  messages: ProbeMessage[];
  /** messages (by id) that disappeared in the window; one re-rendered with the same text did not disappear */
  gone: string[];
  /** fields the browser reported invalid in the window (a submission was blocked, or reportValidity) */
  invalid: Array<{ name: string; message: string }>;
  /** fields the page itself marked aria-invalid in the window */
  marked: number;
  /** form values, checked states, open popovers or open dialogs differ from the previous drain */
  changed: boolean;
  /** the element the last trusted click of the window landed on */
  click?: { tag: string; role: string; type: string; href: string; download: boolean };
  scrolled: boolean;
  /** images that failed to load or decode in the window (absolute URLs) */
  images: string[];
  /** notices that became visible in the window (error / alert / flash areas) with a tone, from class or text; at most 6 */
  toned?: Array<{ tone: Tone; text: string; by?: 'class' | 'words' }>;
  /** ids of the progress indicators (spinner, progressbar, aria-busy) visible at the drain; at most 10 */
  busy?: string[];
}

export function probeInit() {
  const w = window as any;
  if (w.__fqProbe) return;
  // messages that are reported ("came and went"); NOTE adds elements that only count as "the person was told"
  const MSG = '[role=alert],[role=status],[role=alertdialog],[role=dialog],dialog,[aria-live=assertive],[aria-live=polite],[class*=toast],[class*=snackbar],[class*=Toast],[class*=Snackbar]';
  const NOTE = `${MSG},[class*=error],[class*=Error],[class*=invalid-feedback],[class*=alert],[class*=notice],[class*=notification],[class*=flash],.help-block`;
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/;
  const frame = Math.random().toString(36).slice(2, 7);
  const clip = (s: string, n: number) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const shown = (el?: Element | null) => { if (!el || !el.isConnected) return false; const e = el as any; return typeof e.checkVisibility !== 'function' || e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); };
  const textOf = (el: Element) => clip((el as HTMLElement).innerText || el.textContent || '', 80);
  const kindOf = (el: Element) => el.getAttribute('role') || (el.tagName === 'DIALOG' ? 'dialog' : /toast|snackbar/i.test(String((el as any).className)) ? 'toast' : 'status');
  const nameOf = (el: any) => clip(el.labels?.[0]?.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.name || el.id || '', 40);
  // Tone of a message: its classes and data attributes first (alert-success, toast--error, MuiAlert-standardError), then
  // its words. Text patterns are a weak signal and are only read inside message and notice elements, never arbitrary text.
  // candidates; then: aria-busy, an indeterminate progress bar (no value: a step meter is not loading), or a class token
  // that is a spinner / loader / loading word ("file-uploader" and "downloader" are not)
  const BUSY = '[role=progressbar],[aria-busy=true],progress,[class*=pin],[class*=oad]';
  const BUSY_TOKEN = /^(spinner|loader|loading)([-_].*)?$|[-_](spinner|loader|loading)$/i;
  const isBusy = (el: Element) => {
    if (el.getAttribute('aria-busy') === 'true') return true;
    if (el.getAttribute('role') === 'progressbar' || el.tagName === 'PROGRESS') return !el.hasAttribute('aria-valuenow') && !el.hasAttribute('value');
    const cls = typeof (el as any).className === 'string' ? (el as any).className : '';
    return cls.split(/\s+/).some((t: string) => BUSY_TOKEN.test(t));
  };
  const lang = String(document.documentElement?.lang || '').slice(0, 2).toLowerCase();
  const OK_EN = /\b(success(ful(ly)?)?|saved|created|updated|added|deleted|removed|sent|submitted|thank you|thanks|completed?|confirmed)\b/i;
  const BAD_EN = /\b(errors?|failed|failure|could ?n[o']t|cannot|can't|unable|try again|invalid|denied|not allowed|forbidden|went wrong|problem|declined|rejected|expired)\b/i;
  // a negation turns a success word into a failure: "Changes not saved", "Message wasn't sent", "nicht gespeichert"
  const NEG_EN = /\b(not|never|no longer|cannot|can't|couldn't|wasn't|weren't|isn't|aren't|didn't|hasn't|haven't|failed to|unable to|unsaved)\b/i;
  const LOCAL: Record<string, [RegExp, RegExp, RegExp]> = {
    de: [/erfolgreich|gespeichert|erstellt|aktualisiert|gesendet|vielen dank/i, /fehler|fehlgeschlagen|nicht möglich|ungültig|verweigert|erneut versuchen/i, /\bnicht\b|\bkein/i],
    fr: [/succès|réussi|enregistré|créé|mis à jour|envoyé|merci/i, /erreur|échec|échoué|impossible|invalide|refusé|réessayer/i, /\bpas\b|\bn'a\b|\bne\b/i],
    es: [/éxito|guardado|creado|actualizado|enviado|gracias/i, /error|falló|fallido|no se pudo|inválido|denegado|inténtelo de nuevo/i, /\bno\b/i],
    pt: [/sucesso|salvo|criado|atualizado|enviado|obrigado/i, /erro|falhou|falha|não foi possível|inválido|negado|tente novamente/i, /\bnão\b/i],
    it: [/successo|salvato|creato|aggiornato|inviato|grazie/i, /errore|fallito|impossibile|non valido|negato|riprova/i, /\bnon\b/i],
    bg: [/успешно|запазен|създаден|обновен|изпратен|благодарим/i, /грешка|неуспешн|невалид|отказан|опитайте отново/i, /(^|\s)(не|няма)(\s|$)/i],
  };
  /** the tone and where it came from: "class" (classes, data attributes) is strong evidence, "words" is weak */
  const toneOf = (el: Element, text: string): { tone: string; by: string } => {
    const cls = `${typeof (el as any).className === 'string' ? (el as any).className : ''} ${el.getAttribute('data-type') || ''} ${el.getAttribute('data-variant') || ''} ${el.getAttribute('data-severity') || ''} ${el.getAttribute('data-status') || ''}`;
    if (/error|danger|fail|negative|critical|invalid/i.test(cls)) return { tone: 'error', by: 'class' };
    if (/success|positive/i.test(cls)) return { tone: 'success', by: 'class' };
    if (/warn/i.test(cls)) return { tone: 'warning', by: 'class' };
    const loc = LOCAL[lang];
    let ok = OK_EN.test(text) || (!!loc && loc[0].test(text));
    let bad = BAD_EN.test(text) || (!!loc && loc[1].test(text));
    if (ok && (NEG_EN.test(text) || (!!loc && loc[2].test(text)))) { ok = false; bad = true; }
    return { tone: ok && bad ? 'mixed' : ok ? 'success' : bad ? 'error' : '', by: 'words' };
  };

  let seq = 0;
  const ids = new WeakMap<Element, string>();
  const idOf = (el: Element) => { let id = ids.get(el); if (!id) { id = `${frame}:${++seq}`; ids.set(el, id); } return id; };
  /** a laxer test for a message just inserted: rendered at all (a toast fading in from opacity 0 counts) */
  const rendered = (el: Element) => { const e = el as any; return el.isConnected && (typeof e.checkVisibility !== 'function' || e.checkVisibility({ checkVisibilityCSS: true })); };
  /** messages believed visible: since the last drain or appeared in this window. Bounded: the oldest is forgotten. */
  const tracked = new Map<string, { el: Element; text: string; seen: boolean }>();
  const track = (id: string, el: Element, text: string, seen: boolean) => {
    const was = tracked.get(id);
    if (!was && tracked.size >= 300) tracked.delete(tracked.keys().next().value as string);
    tracked.set(id, { el, text, seen: seen || !!was?.seen });
  };
  let notes = new Set<Element>(); // NOTE elements visible at the last drain
  let lastState: string | undefined;

  const win = {
    mutations: 0, texts: [] as string[], messages: new Map<string, { kind: string; text: string; tone: string; by: string }>(),
    invalid: [] as Array<{ name: string; message: string }>, marked: 0, click: undefined as ProbeData['click'], scrolled: false, images: [] as string[],
    toned: [] as Array<{ tone: string; text: string; by: string }>,
  };
  const groups = new Set<string>();
  const addText = (t: string) => { if (t && win.texts.length < 10 && !win.texts.includes(t)) win.texts.push(t); };
  const noteMessage = (el: Element) => {
    const text = textOf(el);
    if (!text) return;
    const id = idOf(el);
    if (win.messages.size < 20 || win.messages.has(id)) win.messages.set(id, { kind: kindOf(el), text, ...toneOf(el, text) });
    track(id, el, text, rendered(el));
  };

  new MutationObserver((records) => {
    win.mutations += records.length;
    let budget = 40;
    for (const r of records) {
      if (budget <= 0) break;
      if (r.type === 'attributes') {
        const el = r.target as Element;
        if (r.attributeName === 'aria-invalid' && el.getAttribute('aria-invalid') === 'true') win.marked++;
        // a pre-rendered message revealed by a class, style or hidden change is something the person sees
        if (/^(class|style|hidden|open|aria-hidden)$/.test(r.attributeName || '') && el.textContent?.trim()) {
          budget--;
          if (shown(el)) { addText(clip(el.textContent, 60)); if (el.matches?.(MSG)) noteMessage(el); }
        }
        continue;
      }
      budget--;
      const nodes: Node[] = r.type === 'childList' ? Array.from(r.addedNodes) : [r.target];
      for (const n of nodes) {
        const el = (n.nodeType === 1 ? n : n.parentElement) as Element | null;
        if (!el || SKIP.test(el.tagName)) continue;
        // inserted text counts even before it is visible: a toast that fades in from opacity 0 is still shown
        addText(clip(n.textContent || '', 60));
        const msg = el.closest?.(MSG);
        if (msg) noteMessage(msg);
        else if (n.nodeType === 1) el.querySelectorAll?.(MSG).forEach((m) => noteMessage(m));
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });

  // The browser fires "invalid" for every option of a required radio group: report the group once, by its legend or name.
  addEventListener('invalid', (e) => {
    const el = e.target as any;
    let name = nameOf(el);
    if (el.type === 'radio' && el.name) {
      const key = `${el.form?.id ?? ''}|${el.name}`;
      if (groups.has(key)) return;
      groups.add(key);
      name = clip(el.closest('fieldset')?.querySelector('legend')?.textContent || el.name, 40);
    }
    if (win.invalid.length < 8) win.invalid.push({ name, message: clip(el.validationMessage || '', 70) });
  }, true);
  addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = e.target as Element | null;
    const el = t?.closest?.('a,button,input,select,textarea,label,summary,[role]') ?? t;
    if (!el?.tagName) return;
    win.click = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type: String((el as any).type || '').toLowerCase(), href: el.getAttribute('href') || '', download: el.hasAttribute('download') };
  }, true);
  addEventListener('scroll', () => { win.scrolled = true; }, { capture: true, passive: true });
  addEventListener('error', (e) => {
    const el = e.target as any;
    if (el?.tagName !== 'IMG' || win.images.length >= 20) return;
    const src = el.currentSrc || el.src;
    if (src && !win.images.includes(src)) win.images.push(src);
  }, true);

  /** a short fingerprint of what a click can change without touching the DOM tree: values, checks, popovers, dialogs */
  const state = () => {
    let h = 0; const add = (s: string) => { for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
    const fields = document.querySelectorAll('input,select,textarea');
    for (let i = 0; i < fields.length && i < 500; i++) {
      const f = fields[i] as any;
      add(f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? '1' : '0') : String(f.value ?? ''));
    }
    let pop = 0; try { pop = document.querySelectorAll(':popover-open').length; } catch { /* no popover API */ }
    return `${h}|${pop}|${document.querySelectorAll('dialog[open]').length}`;
  };

  w.__fqProbe = {
    drain(): ProbeData {
      // messages and notes visible now, compared with the last drain: catches what became visible without new nodes
      const now = new Map<string, { el: Element; text: string }>();
      const all = document.querySelectorAll(MSG);
      for (let i = 0; i < all.length && now.size < 100; i++) { const el = all[i]; const text = textOf(el); if (text && shown(el)) now.set(idOf(el), { el, text }); }
      for (const [id, m] of now) {
        const before = tracked.get(id);
        if (!before || before.text !== m.text) { if (win.messages.size < 20) win.messages.set(id, { kind: kindOf(m.el), text: m.text, ...toneOf(m.el, m.text) }); }
        track(id, m.el, m.text, true);
      }
      const visibleTexts = new Set(Array.from(now.values(), (m) => m.text));
      const gone: string[] = [];
      for (const [id, m] of [...tracked]) {
        if (now.has(id) || shown(m.el)) continue;
        tracked.delete(id);
        // never shown: not "gone". Re-rendered with the same text: still there for the person.
        if (m.seen && !visibleTexts.has(m.text)) gone.push(id);
      }
      const noteEls = new Set<Element>();
      const n = document.querySelectorAll(NOTE);
      for (let i = 0; i < n.length && noteEls.size < 100; i++) { const el = n[i]; if (el.textContent?.trim() && shown(el)) noteEls.add(el); }
      for (const el of noteEls) {
        if (notes.has(el)) continue;
        const text = clip(el.textContent || '', 60);
        addText(text);
        const { tone, by } = toneOf(el, text);
        if (tone && win.toned.length < 6) win.toned.push({ tone, text, by });
      }
      notes = noteEls;
      // progress indicators visible now (a spinner that never goes away is a finding only when it outlives its requests)
      const busy: string[] = [];
      const b = document.querySelectorAll(BUSY);
      for (let i = 0; i < b.length && i < 300 && busy.length < 10; i++) { const el = b[i]; if (el.tagName !== 'IMG' && el !== document.body && el !== document.documentElement && isBusy(el) && shown(el)) busy.push(idOf(el)); }
      const s = state();
      const changed = lastState !== undefined && s !== lastState;
      lastState = s;
      const out: ProbeData = {
        mutations: win.mutations, texts: win.texts, invalid: win.invalid, marked: win.marked, click: win.click, scrolled: win.scrolled, images: win.images,
        messages: Array.from(win.messages, ([id, m]) => (m.tone ? { id, kind: m.kind, text: m.text, tone: m.tone as Tone, by: m.by as 'class' | 'words' } : { id, kind: m.kind, text: m.text })), gone, changed,
        ...(win.toned.length ? { toned: win.toned as ProbeData['toned'] } : {}),
        ...(busy.length ? { busy } : {}),
      };
      win.mutations = 0; win.texts = []; win.messages = new Map(); win.invalid = []; win.marked = 0; win.click = undefined; win.scrolled = false; win.images = []; win.toned = [];
      groups.clear();
      return out;
    },
  };
}

/** Merges probe windows (several frames, or several windows in a row) into one. */
export function mergeProbes(parts: Array<ProbeData | undefined>): ProbeData | undefined {
  const got = parts.filter((p): p is ProbeData => !!p);
  if (!got.length) return undefined;
  return {
    mutations: got.reduce((a, p) => a + p.mutations, 0),
    texts: got.flatMap((p) => p.texts).slice(0, 10),
    messages: got.flatMap((p) => p.messages),
    gone: got.flatMap((p) => p.gone),
    invalid: got.flatMap((p) => p.invalid),
    marked: got.reduce((a, p) => a + p.marked, 0),
    changed: got.some((p) => p.changed),
    click: got.find((p) => p.click)?.click,
    scrolled: got.some((p) => p.scrolled),
    images: got.flatMap((p) => p.images),
    ...(got.some((p) => p.toned?.length) ? { toned: got.flatMap((p) => p.toned ?? []).slice(0, 6) } : {}),
    ...(got.some((p) => p.busy?.length) ? { busy: [...new Set(got.flatMap((p) => p.busy ?? []))].slice(0, 20) } : {}),
  };
}
