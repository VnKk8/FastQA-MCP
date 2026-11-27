// Runs inside the page. Must be fully self-contained (it is serialized by page.evaluate).
// Produces a compact, one-line-per-element view of the page and stamps stable refs (data-fq="eN").
export function snapshotInPage(opts) {
    const w = window;
    w.__fq = w.__fq || { n: 0 };
    w.__fq.n = Math.max(w.__fq.n, opts.base || 0); // refs stay unique across navigations
    const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
        '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],' +
        '[role=option],[role=switch],[role=combobox],[role=textbox],[role=slider],' +
        '[contenteditable=""],[contenteditable=true]';
    const INFO = 'h1,h2,h3,[role=alert],[role=status],[aria-live=assertive],[aria-live=polite],[role=dialog],dialog[open]';
    const TEXT = 'p,li,td,th,dt,dd,span,div,strong,em,small,b,i,code,pre,blockquote,figcaption,caption';
    const clip = (s, n = 60) => {
        s = (s || '').replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    };
    const q = (s) => JSON.stringify(s);
    const visible = (el) => {
        const anyEl = el;
        if (typeof anyEl.checkVisibility === 'function') {
            if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
                return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    const roleOf = (el) => {
        const explicit = el.getAttribute('role');
        if (explicit)
            return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a')
            return 'link';
        if (tag === 'button' || tag === 'summary')
            return 'button';
        if (tag === 'select')
            return el.multiple ? 'listbox' : 'combobox';
        if (tag === 'textarea')
            return 'textbox';
        if (tag === 'input') {
            const t = (el.type || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image'].includes(t))
                return 'button';
            if (t === 'checkbox')
                return 'checkbox';
            if (t === 'radio')
                return 'radio';
            if (t === 'range')
                return 'slider';
            if (t === 'search')
                return 'searchbox';
            return 'textbox';
        }
        if (/^h[1-6]$/.test(tag))
            return 'heading';
        if (tag === 'dialog')
            return 'dialog';
        if (el.getAttribute('contenteditable') !== null)
            return 'textbox';
        return tag;
    };
    const nameOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria)
            return clip(aria);
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
            const rn = el.getRootNode();
            const t = lb.split(/\s+/).map((id) => (rn.getElementById?.(id) ?? document.getElementById(id))?.textContent || '').join(' ');
            if (t.trim())
                return clip(t);
        }
        const id = el.getAttribute('id');
        if (id) {
            const lab = el.getRootNode().querySelector?.(`label[for="${CSS.escape(id)}"]`);
            if (lab?.textContent?.trim())
                return clip(lab.textContent);
        }
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            const wrap = el.closest('label');
            if (wrap) {
                const clone = wrap.cloneNode(true);
                clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
                if (clone.textContent?.trim())
                    return clip(clone.textContent);
            }
            const ph = el.getAttribute('placeholder');
            if (ph)
                return clip(ph);
            const t = el.type;
            if (['submit', 'button', 'reset'].includes(t))
                return clip(el.value);
        }
        const title = el.getAttribute('title') || el.getAttribute('alt');
        if (title)
            return clip(title);
        const img = el.querySelector('img[alt]');
        const txt = el.innerText || el.textContent || '';
        if (txt.trim())
            return clip(txt);
        if (img)
            return clip(img.getAttribute('alt') || '');
        return '';
    };
    const stateOf = (el, role) => {
        const parts = [];
        const h = el;
        if (role === 'textbox' || role === 'searchbox') {
            const v = el.getAttribute('contenteditable') !== null ? (el.textContent || '') : h.value;
            if (v)
                parts.push(h.type === 'password' ? '=•••' : '=' + q(clip(v, 40)));
        }
        if (role === 'combobox' && el.tagName === 'SELECT') {
            const s = el;
            const opt = s.options[s.selectedIndex];
            if (opt)
                parts.push('=' + q(clip(opt.text, 40)));
            parts.push('options:' + Array.from(s.options).slice(0, 8).map((o) => clip(o.text, 20)).join('|') + (s.options.length > 8 ? '|…' : ''));
        }
        if (role === 'checkbox' || role === 'radio' || role === 'switch') {
            const checked = h.checked ?? el.getAttribute('aria-checked') === 'true';
            if (checked || el.getAttribute('aria-checked') === 'true')
                parts.push('[checked]');
        }
        if (h.disabled || el.getAttribute('aria-disabled') === 'true')
            parts.push('[disabled]');
        if (el.getAttribute('aria-expanded') === 'true')
            parts.push('[expanded]');
        if (el.getAttribute('aria-selected') === 'true')
            parts.push('[selected]');
        if (h.required)
            parts.push('[required]');
        const inv = el.getAttribute('aria-invalid');
        if (inv === 'true')
            parts.push('[invalid]');
        return parts.join(' ');
    };
    const hintOf = (el, role, name) => {
        for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
            const v = el.getAttribute(a);
            if (v) {
                const sel = `[${a}=${q(v)}]`;
                return { hint: sel, code: a === 'data-testid' ? `page.getByTestId(${q(v)})` : `page.locator(${q(sel)})` };
            }
        }
        const id = el.getAttribute('id');
        if (id && !/\d{3,}|^[a-f0-9-]{16,}$|:r/.test(id) && !(el.getRootNode() instanceof ShadowRoot) && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
            const sel = '#' + CSS.escape(id);
            return { hint: sel, code: `page.locator(${q(sel)})` };
        }
        const nm = (el.getAttribute('aria-label') || name).replace(/…$/, '');
        if (nm && !name.endsWith('…')) {
            return {
                hint: `role=${role}[name=${q(nm)}]`,
                code: `page.getByRole(${q(role)}, { name: ${q(nm)}, exact: true })`,
            };
        }
        // last resort: positional css
        const path = [];
        let cur = el;
        while (cur && cur !== document.body && path.length < 5) {
            const p = cur.parentElement;
            const tag = cur.tagName.toLowerCase();
            const sib = p ? Array.from(p.children).filter((c) => c.tagName === cur.tagName) : [];
            path.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(cur) + 1})` : tag);
            cur = p;
        }
        const sel = path.join(' > ');
        return { hint: sel, code: `page.locator(${q(sel)})` };
    };
    // A document that has just been navigated to can have a head and no body yet. The caller waits and tries again
    // (it retries errors that mention navigating), instead of failing on a page that is merely still arriving.
    if (!document.body)
        throw new Error('the document has no body yet: the page is still navigating');
    const root = (opts.root && document.querySelector(opts.root)) || document.body;
    const items = [];
    const seenText = new Set();
    let truncated = false;
    // Deep walk: light DOM in document order, descending into OPEN shadow roots right after their host.
    // (Closed shadow roots are unreachable from page JS by design.)
    const all = [];
    const walk = (node) => {
        for (const child of Array.from(node.children)) {
            all.push(child);
            if (child.shadowRoot)
                walk(child.shadowRoot);
            walk(child);
        }
    };
    walk(root);
    if (root.shadowRoot)
        walk(root.shadowRoot);
    const interactive = new Set(all.filter((e) => e.matches(INTERACTIVE)));
    const info = new Set(all.filter((e) => e.matches(INFO)));
    for (const el of all) {
        if (items.length >= opts.max) {
            truncated = true;
            break;
        }
        const isI = interactive.has(el);
        const isInfo = info.has(el);
        const isText = !isI && !isInfo && opts.mode === 'full' && el.matches(TEXT);
        if (!isI && !isInfo && !isText)
            continue;
        if (!visible(el))
            continue;
        if (isI) {
            // skip interactive elements nested in another interactive element (e.g. span[role=button] inside <a>)
            const parentI = el.parentElement?.closest(INTERACTIVE);
            if (parentI && interactive.has(parentI) && visible(parentI))
                continue;
            const role = roleOf(el);
            const name = nameOf(el);
            let ref = el.getAttribute('data-fq');
            if (!ref) {
                ref = 'e' + (++w.__fq.n);
                el.setAttribute('data-fq', ref);
            }
            const st = stateOf(el, role);
            const { hint, code } = hintOf(el, role, name);
            items.push({ ref, line: `${ref} ${role}${name ? ' ' + q(name) : ''}${st ? ' ' + st : ''}`, hint, code });
            continue;
        }
        if (isInfo) {
            const role = roleOf(el);
            const txt = clip(el.innerText || el.textContent || '', 100);
            if (!txt)
                continue;
            const tag = el.tagName.toLowerCase();
            const label = /^h[1-3]$/.test(tag) ? tag : role === 'dialog' ? 'dialog' : role === 'alert' ? 'alert' : 'status';
            const key = label + txt;
            if (seenText.has(key))
                continue;
            seenText.add(key);
            seenText.add(txt);
            items.push({ line: `${label} ${q(txt)}` });
            continue;
        }
        // full mode: leaf-ish text blocks only (own text, no block children with text)
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join(' ').trim();
        if (own.length < 2)
            continue;
        if (el.closest(INTERACTIVE) || el.closest(INFO))
            continue;
        const txt = clip(el.innerText || own, 100);
        if (seenText.has(txt))
            continue;
        seenText.add(txt);
        items.push({ line: `· ${q(txt)}` });
    }
    return { items, truncated, url: location.href, title: document.title, maxRef: w.__fq.n };
}
// Resolves when the DOM has been quiet for `quietMs`, or after `maxMs`.
export function domSettleInPage(args) {
    return new Promise((resolve) => {
        let timer;
        let finished = false;
        const done = () => { if (finished)
            return; finished = true; obs.disconnect(); resolve(true); };
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, args.quietMs); });
        obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        timer = setTimeout(done, args.quietMs);
        setTimeout(done, args.maxMs);
    });
}
// Visible text of the page including open shadow roots (innerText does not cross shadow boundaries).
export function deepTextInPage() {
    const out = [];
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const walk = (node) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                const p = child.parentElement;
                const t = (child.textContent || '').trim();
                if (t && (!p?.checkVisibility || p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })))
                    out.push(t);
            }
            else if (child.nodeType === 1) {
                const el = child;
                if (skip.has(el.tagName))
                    continue;
                if (el.shadowRoot)
                    walk(el.shadowRoot);
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
                    continue;
                walk(el);
            }
        }
    };
    walk(document.body || document.documentElement);
    return out.join(' ').replace(/\s+/g, ' ');
}
// Runs on an <iframe> element in its parent document: a stable selector + human label for it.
export function iframeInfoInPage(el) {
    const f = el;
    const q = (v) => JSON.stringify(v);
    const label = f.title || f.name || f.getAttribute('aria-label') || f.id || (f.src ? new URL(f.src, location.href).pathname : 'iframe');
    if (f.id)
        return { sel: `iframe#${CSS.escape(f.id)}`, label };
    if (f.name)
        return { sel: `iframe[name=${q(f.name)}]`, label };
    if (f.title)
        return { sel: `iframe[title=${q(f.title)}]`, label };
    const src = f.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('about:'))
        return { sel: `iframe[src=${q(src)}]`, label };
    const all = Array.from(el.getRootNode().querySelectorAll('iframe'));
    return { sel: `iframe >> nth=${all.indexOf(el)}`, label };
}
