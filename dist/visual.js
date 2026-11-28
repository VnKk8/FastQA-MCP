// Deterministic visual inspection, only on request (evidence {view:"visual"}): one bounded evaluate in the main frame.
// No screenshots, no vision model, no pixel baseline. Everything it reports is a possible visual issue (a lead), with the
// element and the measured geometry as evidence. Intentional layouts are left alone: scroll containers, ellipsis,
// dialogs, tooltips, sticky headers, animations and hidden elements.
import { oneLine } from './util/text.js';
/** Runs in the page; must be self-contained. `max` bounds the elements inspected per check. */
export async function visualAuditInPage(opts) {
    const W = document.documentElement.clientWidth;
    const H = window.innerHeight;
    const issues = [];
    let truncated = false;
    const clip = (s, n) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    // A field is named by its label, placeholder or name, never by what was typed into it: a typed value can be a
    // password, an OTP or personal data that no downstream pattern recognises. Only a button-like input's value is its
    // label. Collected safely here rather than redacted later.
    const safeName = (el) => {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            const f = el;
            const type = (f.getAttribute('type') || '').toLowerCase();
            if (tag === 'INPUT' && /^(button|submit|reset)$/.test(type))
                return f.value || '';
            const by = el.getAttribute('aria-labelledby');
            const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
            const label = labelled || (f.labels && f.labels[0] ? f.labels[0].textContent || '' : '');
            return label || f.getAttribute('placeholder') || f.getAttribute('name') || (type ? `${type} field` : 'field');
        }
        return el.innerText || '';
    };
    const describe = (el) => {
        const ref = el.getAttribute('data-fq');
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const name = clip(el.getAttribute('aria-label') || safeName(el) || '', 30);
        const id = el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
        return `${role || tag}${name ? ` ${JSON.stringify(name)}` : id ? ` ${clip(id, 40)}` : ''}${ref ? ` ${ref}` : ''}`;
    };
    const visible = (el) => {
        const e = el;
        if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
            return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };
    const style = (el) => getComputedStyle(el);
    // intentional layouts: a scroll container, a fixed or sticky layer, a dialog or tooltip, something that is animating
    const inScroller = (el) => {
        for (let p = el.parentElement, n = 0; p && p !== document.body && n < 25; p = p.parentElement, n++) {
            const s = style(p);
            if (/(auto|scroll)/.test(s.overflowX) || /(auto|scroll)/.test(s.overflowY))
                return true;
        }
        return false;
    };
    const onLayer = (el) => {
        for (let p = el, n = 0; p && p !== document.body && n < 25; p = p.parentElement, n++) {
            const s = style(p);
            if (s.position === 'fixed' || s.position === 'sticky')
                return true;
        }
        return false;
    };
    const transient = (el) => !!el.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[role=tooltip],[popover]') || (el.getAnimations?.({ subtree: false })?.length ?? 0) > 0;
    const all = Array.from(document.body?.querySelectorAll('*') ?? []);
    if (all.length > opts.scan)
        truncated = true;
    const pool = all.slice(0, opts.scan);
    let inspected = 0;
    // 1. the page is wider than the viewport: the elements that stick out (not those inside a scroll container)
    const sw = document.documentElement.scrollWidth;
    if (sw > W + 1) {
        const out = [];
        for (const el of pool) {
            const r = el.getBoundingClientRect();
            if (r.right > W + 1 && r.width > 0 && r.height > 0 && !inScroller(el) && !onLayer(el))
                out.push({ el, right: r.right });
        }
        // outermost offenders only: a child of an offender is the same problem
        const top = out.filter((o) => !out.some((x) => x !== o && x.el.contains(o.el))).sort((a, b) => b.right - a.right).slice(0, 3);
        for (const o of top)
            issues.push({ kind: 'overflow', where: describe(o.el), detail: `reaches ${Math.round(o.right)}px in a ${W}px wide viewport: the page scrolls sideways (${sw}px)` });
    }
    // 2. text cut off without an ellipsis (overflow hidden on an element whose text does not fit)
    let n = 0;
    for (const el of pool) {
        if (n >= opts.max) {
            truncated = true;
            break;
        }
        const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent || '').trim().length > 1);
        if (!own)
            continue;
        const wide = el.scrollWidth > el.clientWidth + 1;
        const tall = el.scrollHeight > el.clientHeight + 4; // a few pixels of descenders are not clipped text
        if ((!wide && !tall) || el.clientWidth === 0)
            continue;
        n++;
        const s = style(el);
        const hidden = (wide && /(hidden|clip)/.test(s.overflowX)) || (tall && /(hidden|clip)/.test(s.overflowY));
        if (!hidden || s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none'))
            continue;
        if (!visible(el) || inScroller(el) || transient(el))
            continue;
        issues.push({ kind: 'clipped', where: describe(el), detail: `text is cut off without an ellipsis (${el.scrollWidth}×${el.scrollHeight}px of content in ${el.clientWidth}×${el.clientHeight}px)` });
        if (issues.filter((i) => i.kind === 'clipped').length >= 5)
            break;
    }
    inspected += n;
    // 3 and 4. controls: overlapping each other, or covered at their center (hit test); viewport only
    const controls = pool.filter((el) => el.matches('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem]'))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W && visible(el); });
    if (controls.length > opts.max)
        truncated = true;
    const ctl = controls.slice(0, opts.max);
    inspected += ctl.length;
    const rects = ctl.map((el) => ({ el, r: el.getBoundingClientRect(), layer: onLayer(el) || transient(el) }));
    // spatial buckets of 100px: only controls that share a bucket are compared (no all-pairs scan)
    const buckets = new Map();
    rects.forEach((x, i) => {
        for (let bx = Math.floor(x.r.left / 100); bx <= Math.floor(x.r.right / 100); bx++)
            for (let by = Math.floor(x.r.top / 100); by <= Math.floor(x.r.bottom / 100); by++) {
                const k = `${bx},${by}`;
                const list = buckets.get(k) ?? [];
                if (list.length < 50)
                    list.push(i);
                buckets.set(k, list);
            }
    });
    const seen = new Set();
    for (const list of buckets.values())
        for (let a = 0; a < list.length; a++)
            for (let b = a + 1; b < list.length; b++) {
                const i = list[a];
                const j = list[b];
                const key = i < j ? `${i}:${j}` : `${j}:${i}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                const A = rects[i];
                const B = rects[j];
                if (A.layer || B.layer || A.el.contains(B.el) || B.el.contains(A.el))
                    continue;
                const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
                const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
                if (w <= 0 || h <= 0)
                    continue;
                const share = (w * h) / Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
                if (share >= 0.25 && issues.filter((x) => x.kind === 'overlap').length < 5)
                    issues.push({ kind: 'overlap', where: `${describe(A.el)} and ${describe(B.el)}`, detail: `overlap by ${Math.round(share * 100)}% of the smaller one` });
            }
    for (const x of rects) {
        if (x.layer || issues.filter((i) => i.kind === 'obstructed').length >= 5)
            continue;
        const cx = x.r.left + x.r.width / 2;
        const cy = x.r.top + x.r.height / 2;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H)
            continue;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || hit === x.el || x.el.contains(hit) || hit.contains(x.el))
            continue;
        if (hit.control === x.el || hit.closest('label') === x.el.labels?.[0])
            continue; // its own label
        if (hit.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[role=tooltip]'))
            continue; // a modal covers on purpose
        issues.push({ kind: 'obstructed', where: describe(x.el), detail: `covered at its center by ${describe(hit)}: a click there lands on the other element` });
    }
    // 5. layout shift so far (buffered entries; reported only with a few shifts and a score that matters)
    try {
        const entries = [];
        const po = new PerformanceObserver((l) => { entries.push(...l.getEntries()); });
        po.observe({ type: 'layout-shift', buffered: true });
        await new Promise((r) => setTimeout(r, 0));
        entries.push(...po.takeRecords());
        po.disconnect();
        const shifts = entries.filter((e) => !e.hadRecentInput);
        const cls = shifts.reduce((a, e) => a + (e.value || 0), 0);
        if (shifts.length >= 3 && cls >= 0.1)
            issues.push({ kind: 'layout-shift', where: 'page', detail: `cumulative layout shift ${cls.toFixed(2)} from ${shifts.length} shifts without user input (${cls >= 0.25 ? 'poor' : 'needs improvement'}; good is < 0.1)` });
    }
    catch { /* no layout-shift support */ }
    return { url: location.href, viewport: { w: W, h: H }, inspected, issues, truncated };
}
/**
 * The report with every page-derived string on one line and bounded: roles, names and refs come from the page, and a
 * page must never be able to forge a line of the result. Use it for both the text and the structured copy.
 */
export function sanitizeVisual(r) {
    return { ...r, url: oneLine(r.url, 300), issues: r.issues.slice(0, 30).map((i) => ({ kind: i.kind, where: oneLine(i.where, 160), detail: oneLine(i.detail, 200) })) };
}
/** Text view: possible visual issues with their evidence, and what was not inspected. Expects a sanitized report. */
export function renderVisual(r) {
    const head = r.issues.length
        ? `visual: ${r.issues.length} possible visual issue${r.issues.length === 1 ? '' : 's'} (leads, not confirmed defects) · ${r.inspected} elements inspected · viewport ${r.viewport.w}×${r.viewport.h}${r.truncated ? ' · bounded: not every element was inspected' : ''}`
        : `visual: no visual issue found by these checks · ${r.inspected} elements inspected · viewport ${r.viewport.w}×${r.viewport.h}${r.truncated ? ' · bounded: not every element was inspected' : ''}`;
    return [
        head,
        ...r.issues.map((i) => `  ${i.kind}: ${i.where} — ${i.detail}`),
        'Checked: sideways overflow, clipped text, overlapping and covered controls, layout shift. Not inspected: iframes, closed shadow roots, content outside the viewport for the hit test. Other devices: open with device and ask again.',
    ].join('\n');
}
