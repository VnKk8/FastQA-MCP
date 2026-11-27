// A small listener installed in every document of the browser context (addInitScript). It records what happened in the
// page between two drain() calls: DOM changes, text that appeared or was revealed, messages (alerts, status lines,
// dialogs, toasts) that appeared or went, forms the browser refused to submit, form state and open popovers, the
// element a click landed on, images that could not be shown. fastqa drains it when an action starts and when it has
// settled: one evaluate each, about 1 ms. Must be fully self-contained: it is serialized into the page.
export function probeInit() {
    const w = window;
    if (w.__fqProbe)
        return;
    // messages that are reported ("came and went"); NOTE adds elements that only count as "the person was told"
    const MSG = '[role=alert],[role=status],[role=alertdialog],[role=dialog],dialog,[aria-live=assertive],[aria-live=polite],[class*=toast],[class*=snackbar],[class*=Toast],[class*=Snackbar]';
    const NOTE = `${MSG},[class*=error],[class*=Error],[class*=invalid-feedback],[class*=alert],[class*=notice],[class*=notification],[class*=flash],.help-block`;
    const SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/;
    const frame = Math.random().toString(36).slice(2, 7);
    const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const shown = (el) => { if (!el || !el.isConnected)
        return false; const e = el; return typeof e.checkVisibility !== 'function' || e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); };
    const textOf = (el) => clip(el.innerText || el.textContent || '', 80);
    const kindOf = (el) => el.getAttribute('role') || (el.tagName === 'DIALOG' ? 'dialog' : /toast|snackbar/i.test(String(el.className)) ? 'toast' : 'status');
    const nameOf = (el) => clip(el.labels?.[0]?.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.name || el.id || '', 40);
    let seq = 0;
    const ids = new WeakMap();
    const idOf = (el) => { let id = ids.get(el); if (!id) {
        id = `${frame}:${++seq}`;
        ids.set(el, id);
    } return id; };
    /** a laxer test for a message just inserted: rendered at all (a toast fading in from opacity 0 counts) */
    const rendered = (el) => { const e = el; return el.isConnected && (typeof e.checkVisibility !== 'function' || e.checkVisibility({ checkVisibilityCSS: true })); };
    /** messages believed visible: since the last drain or appeared in this window. Bounded: the oldest is forgotten. */
    const tracked = new Map();
    const track = (id, el, text, seen) => {
        const was = tracked.get(id);
        if (!was && tracked.size >= 300)
            tracked.delete(tracked.keys().next().value);
        tracked.set(id, { el, text, seen: seen || !!was?.seen });
    };
    let notes = new Set(); // NOTE elements visible at the last drain
    let lastState;
    const win = {
        mutations: 0, texts: [], messages: new Map(),
        invalid: [], marked: 0, click: undefined, scrolled: false, images: [],
    };
    const groups = new Set();
    const addText = (t) => { if (t && win.texts.length < 10 && !win.texts.includes(t))
        win.texts.push(t); };
    const noteMessage = (el) => {
        const text = textOf(el);
        if (!text)
            return;
        const id = idOf(el);
        if (win.messages.size < 20 || win.messages.has(id))
            win.messages.set(id, { kind: kindOf(el), text });
        track(id, el, text, rendered(el));
    };
    new MutationObserver((records) => {
        win.mutations += records.length;
        let budget = 40;
        for (const r of records) {
            if (budget <= 0)
                break;
            if (r.type === 'attributes') {
                const el = r.target;
                if (r.attributeName === 'aria-invalid' && el.getAttribute('aria-invalid') === 'true')
                    win.marked++;
                // a pre-rendered message revealed by a class, style or hidden change is something the person sees
                if (/^(class|style|hidden|open|aria-hidden)$/.test(r.attributeName || '') && el.textContent?.trim()) {
                    budget--;
                    if (shown(el)) {
                        addText(clip(el.textContent, 60));
                        if (el.matches?.(MSG))
                            noteMessage(el);
                    }
                }
                continue;
            }
            budget--;
            const nodes = r.type === 'childList' ? Array.from(r.addedNodes) : [r.target];
            for (const n of nodes) {
                const el = (n.nodeType === 1 ? n : n.parentElement);
                if (!el || SKIP.test(el.tagName))
                    continue;
                // inserted text counts even before it is visible: a toast that fades in from opacity 0 is still shown
                addText(clip(n.textContent || '', 60));
                const msg = el.closest?.(MSG);
                if (msg)
                    noteMessage(msg);
                else if (n.nodeType === 1)
                    el.querySelectorAll?.(MSG).forEach((m) => noteMessage(m));
            }
        }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    // The browser fires "invalid" for every option of a required radio group: report the group once, by its legend or name.
    addEventListener('invalid', (e) => {
        const el = e.target;
        let name = nameOf(el);
        if (el.type === 'radio' && el.name) {
            const key = `${el.form?.id ?? ''}|${el.name}`;
            if (groups.has(key))
                return;
            groups.add(key);
            name = clip(el.closest('fieldset')?.querySelector('legend')?.textContent || el.name, 40);
        }
        if (win.invalid.length < 8)
            win.invalid.push({ name, message: clip(el.validationMessage || '', 70) });
    }, true);
    addEventListener('click', (e) => {
        if (!e.isTrusted)
            return;
        const t = e.target;
        const el = t?.closest?.('a,button,input,select,textarea,label,summary,[role]') ?? t;
        if (!el?.tagName)
            return;
        win.click = { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', type: String(el.type || '').toLowerCase(), href: el.getAttribute('href') || '', download: el.hasAttribute('download') };
    }, true);
    addEventListener('scroll', () => { win.scrolled = true; }, { capture: true, passive: true });
    addEventListener('error', (e) => {
        const el = e.target;
        if (el?.tagName !== 'IMG' || win.images.length >= 20)
            return;
        const src = el.currentSrc || el.src;
        if (src && !win.images.includes(src))
            win.images.push(src);
    }, true);
    /** a short fingerprint of what a click can change without touching the DOM tree: values, checks, popovers, dialogs */
    const state = () => {
        let h = 0;
        const add = (s) => { for (let i = 0; i < s.length; i++)
            h = (h * 31 + s.charCodeAt(i)) | 0; };
        const fields = document.querySelectorAll('input,select,textarea');
        for (let i = 0; i < fields.length && i < 500; i++) {
            const f = fields[i];
            add(f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? '1' : '0') : String(f.value ?? ''));
        }
        let pop = 0;
        try {
            pop = document.querySelectorAll(':popover-open').length;
        }
        catch { /* no popover API */ }
        return `${h}|${pop}|${document.querySelectorAll('dialog[open]').length}`;
    };
    w.__fqProbe = {
        drain() {
            // messages and notes visible now, compared with the last drain: catches what became visible without new nodes
            const now = new Map();
            const all = document.querySelectorAll(MSG);
            for (let i = 0; i < all.length && now.size < 100; i++) {
                const el = all[i];
                const text = textOf(el);
                if (text && shown(el))
                    now.set(idOf(el), { el, text });
            }
            for (const [id, m] of now) {
                const before = tracked.get(id);
                if (!before || before.text !== m.text) {
                    if (win.messages.size < 20)
                        win.messages.set(id, { kind: kindOf(m.el), text: m.text });
                }
                track(id, m.el, m.text, true);
            }
            const visibleTexts = new Set(Array.from(now.values(), (m) => m.text));
            const gone = [];
            for (const [id, m] of [...tracked]) {
                if (now.has(id) || shown(m.el))
                    continue;
                tracked.delete(id);
                // never shown: not "gone". Re-rendered with the same text: still there for the person.
                if (m.seen && !visibleTexts.has(m.text))
                    gone.push(id);
            }
            const noteEls = new Set();
            const n = document.querySelectorAll(NOTE);
            for (let i = 0; i < n.length && noteEls.size < 100; i++) {
                const el = n[i];
                if (el.textContent?.trim() && shown(el))
                    noteEls.add(el);
            }
            for (const el of noteEls)
                if (!notes.has(el))
                    addText(clip(el.textContent || '', 60));
            notes = noteEls;
            const s = state();
            const changed = lastState !== undefined && s !== lastState;
            lastState = s;
            const out = {
                mutations: win.mutations, texts: win.texts, invalid: win.invalid, marked: win.marked, click: win.click, scrolled: win.scrolled, images: win.images,
                messages: Array.from(win.messages, ([id, m]) => ({ id, kind: m.kind, text: m.text })), gone, changed,
            };
            win.mutations = 0;
            win.texts = [];
            win.messages = new Map();
            win.invalid = [];
            win.marked = 0;
            win.click = undefined;
            win.scrolled = false;
            win.images = [];
            groups.clear();
            return out;
        },
    };
}
/** Merges probe windows (several frames, or several windows in a row) into one. */
export function mergeProbes(parts) {
    const got = parts.filter((p) => !!p);
    if (!got.length)
        return undefined;
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
    };
}
