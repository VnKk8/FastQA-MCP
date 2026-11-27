import { chromium, devices } from 'playwright';
import { snapshotInPage, domSettleInPage, deepTextInPage, iframeInfoInPage } from './snapshot.js';
import { loadConfig } from './config.js';
import { Observer } from './observation/observer.js';
import { redactor } from './privacy/redact.js';
import { FLOW_DIR } from './dirs.js';
/** Thrown in strict locator mode when a target matches more than one element. */
export class AmbiguousTargetError extends Error {
}
const env = process.env;
let warnedTls = false;
/** Told once per process, and only when an HTTPS site is actually opened with the 0.3 default still in effect. */
export function warnLegacyTls() {
    if (warnedTls)
        return;
    warnedTls = true;
    console.error('fastqa: invalid HTTPS certificates are accepted (0.3 default). Add .fastqa/config.json to be secure by default, or set FASTQA_IGNORE_HTTPS_ERRORS.');
}
export const DEFAULT_TIMEOUT = Number(env.FASTQA_TIMEOUT_MS || 5000);
/** Services that attach to every new session (artifacts, discovery, contracts) register here; keeps this module free of them. */
export const sessionHooks = { created: [] };
export class Session {
    browser;
    context;
    page;
    /** last snapshot lines (for diffs) and ref -> selector hints (for stale refs + recording) */
    lastLines = [];
    hints = new Map();
    /** strict locators for the running batch (act strict:true); falls back to locator.strict from the config */
    strictNow;
    tape = [];
    evidence = { console: [], pageErrors: [], failedRequests: [] };
    inflight = 0;
    pending = new Set();
    refBase = 0;
    log = [];
    /** start of the current act batch / flow run; expect_request and expect_no_errors look from here */
    mark = 0;
    device;
    /** observation scope of the current browser context; kept after close so evidence stays readable */
    obs;
    cfg;
    /** explicit run option (CLI --mode, flow run mode); overrides the config file */
    mode;
    /** per-run options that services read (CLI --bundle, --baseline) */
    options = {};
    /** called when a session ends (context closed), before the observer is replaced */
    onEnd;
    /** counts main-frame navigations: a ref issued on an older document is stale */
    docGen = 0;
    detachers = [];
    addLog(e) {
        this.log.push({ t: Date.now(), ...e });
        if (this.log.length > 2000)
            this.log.splice(0, 500);
    }
    since(t) { return this.log.filter((e) => e.t >= t); }
    /** device: a Playwright device name such as "iPhone 13" or "Pixel 7"; switching device opens a new context. */
    async ensure(fresh = false, device) {
        if (device !== undefined && device !== (this.device ?? '')) {
            fresh = true;
            this.device = device || undefined;
        }
        if (fresh)
            await this.closeContext();
        if (!this.context) {
            // Validate configuration before any browser work: an invalid policy is an error, never a silent fallback.
            this.cfg = loadConfig(FLOW_DIR(), this.mode);
            redactor.configure(this.cfg.privacy);
            for (const [k, v] of Object.entries(env))
                if (k.startsWith('FASTQA_VAR_') && v && redactor.isSecretVar(k.slice(11)))
                    redactor.addSecret(v, k.slice(11));
            for (const w of this.cfg.warnings)
                console.error(`fastqa: config: ${w}`);
        }
        if (!this.browser)
            this.browser = await launch();
        if (!this.context) {
            const [w, h] = (env.FASTQA_VIEWPORT || '1280x800').split('x').map(Number);
            const tls = { ignoreHTTPSErrors: this.cfg.browser.ignoreHTTPSErrors };
            this.context = this.browser.contexts()[0] && env.FASTQA_CDP_URL
                ? this.browser.contexts()[0]
                : await this.browser.newContext(this.device ? { ...deviceProfile(this.device), ...tls } : { viewport: { width: w, height: h }, ...tls });
            this.context.setDefaultTimeout(DEFAULT_TIMEOUT);
            this.obs = new Observer(this.cfg, redactor);
            this.obs.environment.browser = `chromium ${this.browser.version()}`;
            if (this.device)
                this.obs.environment.device = this.device;
            for (const h of sessionHooks.created)
                h(this);
            this.attachContext(this.context);
        }
        if (!this.page || this.page.isClosed()) {
            this.page = this.context.pages()[0] ?? (await this.context.newPage());
            this.attachPage(this.page);
        }
        return this.page;
    }
    /**
     * Listeners are bound once per context, at context level, so the first request of a new page or popup is never missed
     * and nothing is registered twice. Each handler feeds the 0.3 buffers (explicit assertions, legacy evidence) and the observer.
     */
    attachContext(ctx) {
        const on = (ev, fn) => { ctx.on(ev, fn); this.detachers.push(() => ctx.off(ev, fn)); };
        const cdp = !!env.FASTQA_CDP_URL;
        const pageOf = (r) => { try {
            return r.frame().page();
        }
        catch {
            return this.page;
        } };
        // Context-level events also carry traffic that page-level listeners (0.3) never saw: requests made by a service
        // worker, and pages fastqa does not drive (other tabs of a browser attached over CDP). Both are ignored.
        const foreign = (r) => {
            try {
                if (r.serviceWorker())
                    return true;
            }
            catch { /* not a worker request */ }
            // In a context fastqa created, every page is one it drives (popups included, even before their 'page' event).
            // Only an attached browser (CDP) has tabs that belong to someone else.
            if (!cdp)
                return false;
            const p = pageOf(r);
            return !!p && !this.attachedPages.has(p);
        };
        const stranger = (p) => cdp && !!p && !this.attachedPages.has(p);
        on('page', (p) => { this.page = p; this.attachPage(p); this.obs.onPage(p, 'page_opened'); });
        on('console', (m) => {
            if (/favicon/.test(m.location()?.url || ''))
                return;
            if (stranger(m.page()))
                return;
            const text = redactor.text(m.text().slice(0, 2000));
            if (m.type() === 'error' || m.type() === 'warning')
                push(this.evidence.console, `[${m.type()}] ${text}`);
            if (m.type() === 'error' && !/Failed to load resource/.test(text))
                this.addLog({ kind: 'console', text });
            const p = m.page() ?? this.page;
            if (p)
                this.obs.onConsole(p, m);
        });
        on('weberror', (w) => {
            if (stranger(w.page()))
                return;
            const e = w.error();
            const msg = redactor.text(String(e?.message || e).slice(0, 2000));
            push(this.evidence.pageErrors, msg);
            this.addLog({ kind: 'pageerror', text: msg });
            const p = w.page() ?? this.page;
            if (p)
                this.obs.onPageError(p, e);
        });
        // A request counts as in flight until its response headers arrive (bodies the app never reads must not block settle).
        on('request', (r) => {
            if (foreign(r))
                return;
            this.pending.add(r);
            this.inflight = this.pending.size;
            const p = pageOf(r);
            if (p)
                this.obs.onRequest(p, r);
        });
        on('response', (res) => {
            const r = res.request();
            if (foreign(r))
                return;
            this.pending.delete(r);
            this.inflight = this.pending.size;
            const p = pageOf(r);
            const rec = p ? this.obs.onResponse(p, res) : undefined;
            const url = rec?.url ?? redactor.networkUrl(r.url());
            if (['fetch', 'xhr', 'document'].includes(r.resourceType()))
                this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: res.status(), text: `${res.status()} ${r.method()} ${url}`, rid: rec?.id });
            if (res.status() >= 400 && !/favicon/.test(r.url()))
                push(this.evidence.failedRequests, `${res.status()} ${r.method()} ${url}`);
        });
        on('requestfinished', (r) => { if (foreign(r))
            return; this.pending.delete(r); this.inflight = this.pending.size; this.obs.onFinished(r); });
        on('requestfailed', (r) => {
            if (foreign(r))
                return;
            this.pending.delete(r);
            this.inflight = this.pending.size;
            const p = pageOf(r);
            const rec = p ? this.obs.onFailed(p, r) : undefined;
            if (/ERR_ABORTED/.test(r.failure()?.errorText ?? ''))
                return; // aborts are recorded by the observer, not reported as failures
            const url = rec?.url ?? redactor.networkUrl(r.url());
            this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: 0, text: `FAILED ${r.method()} ${url}`, rid: rec?.id });
            push(this.evidence.failedRequests, `FAILED ${r.method()} ${url} ${r.failure()?.errorText ?? ''}`);
        });
    }
    attachedPages = new WeakSet();
    attachPage(page) {
        if (this.attachedPages.has(page))
            return;
        this.attachedPages.add(page);
        const nav = (f) => { if (f === page.mainFrame())
            this.docGen++; this.obs.onNavigated(page, f); };
        const closed = () => {
            this.obs.onPage(page, 'page_closed');
            // its open requests will never finish: stop waiting for them
            for (const r of [...this.pending]) {
                try {
                    if (r.frame().page() === page)
                        this.pending.delete(r);
                }
                catch { /* no frame: leave it */ }
            }
            this.inflight = this.pending.size;
            // a popup that closes hands control back to the page that is still open
            if (this.page === page) {
                const open = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
                if (open.length)
                    this.page = open[open.length - 1];
            }
        };
        page.on('framenavigated', nav);
        page.on('close', closed);
        this.detachers.push(() => { page.off('framenavigated', nav); page.off('close', closed); });
    }
    async closeContext() {
        for (const d of this.detachers.splice(0))
            try {
                d();
            }
            catch { /* context already gone */ }
        this.attachedPages = new WeakSet(); // a context that stays open (CDP) must get its page listeners again next time
        if (this.obs && !this.obs.disposed) {
            this.obs.dispose();
            try {
                await this.onEnd?.(this.obs);
            }
            catch (e) {
                console.error(`fastqa: could not finalize session ${this.obs.sessionId}: ${String(e).split('\n')[0]}`);
            }
        }
        if (this.context && !env.FASTQA_CDP_URL)
            await this.context.close().catch(() => { });
        this.context = undefined;
        this.page = undefined;
        this.inflight = 0;
        this.pending.clear();
        this.lastLines = [];
        this.hints.clear();
    }
    async close() {
        await this.closeContext();
        await this.browser?.close().catch(() => { });
        this.browser = undefined;
    }
    /** Wait until network is idle-ish and DOM is quiet. Bounded so it never costs more than ~maxMs. */
    async settle(maxMs = 2000) {
        const page = this.page;
        const start = Date.now();
        await page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => { });
        while (this.inflight > 0 && Date.now() - start < maxMs)
            await sleep(25);
        const left = Math.max(50, maxMs - (Date.now() - start));
        await page.evaluate(domSettleInPage, { quietMs: 80, maxMs: left }).catch(() => { });
    }
    async snapshot(mode = 'interactive', root, max = Number(env.FASTQA_MAX_LINES || 250)) {
        const page = this.page;
        let res;
        for (let i = 0; i < 3 && !res; i++) {
            try {
                res = await page.evaluate(snapshotInPage, { mode, root, max, base: this.refBase });
            }
            catch (e) {
                if (!/context was destroyed|navigat/i.test(String(e)))
                    throw e;
                await page.waitForLoadState('domcontentloaded').catch(() => { });
            }
        }
        if (!res)
            throw new Error('Page kept navigating; could not take a snapshot');
        this.refBase = Math.max(this.refBase, res.maxRef);
        const items = [...res.items];
        let truncated = res.truncated;
        // iframes (same- and cross-origin): each visible frame gets its own indented block
        if (!root) {
            for (const fr of await this.listFrames()) {
                if (items.length >= max) {
                    truncated = true;
                    break;
                }
                try {
                    const r = await fr.frame.evaluate(snapshotInPage, { mode, max: max - items.length, base: this.refBase });
                    this.refBase = Math.max(this.refBase, r.maxRef);
                    const indent = '  '.repeat(fr.chain.length);
                    items.push({ line: `${'  '.repeat(fr.chain.length - 1)}frame ${JSON.stringify(fr.label)} [${fr.chain[fr.chain.length - 1]}]` });
                    for (const it of r.items)
                        items.push({ ...it, line: indent + it.line, frame: fr.chain });
                    truncated ||= r.truncated;
                }
                catch { /* frame navigated or detached mid-snapshot */ }
            }
        }
        for (const it of items)
            if (it.ref && it.hint)
                this.hints.set(it.ref, { hint: it.hint, code: it.code, frame: it.frame, gen: this.docGen });
        return { items, truncated, url: res.url, title: res.title };
    }
    /** Visible child frames with their selector chain from the top page (nested frames supported). */
    async listFrames() {
        const page = this.page;
        const out = [];
        for (const f of page.frames()) {
            if (f === page.mainFrame() || f.isDetached())
                continue;
            const chain = [];
            let label = '';
            let cur = f;
            let ok = true;
            while (cur && cur.parentFrame()) {
                const el = await cur.frameElement().catch(() => null);
                if (!el || !(await el.isVisible().catch(() => false))) {
                    ok = false;
                    break;
                }
                const info = await el.evaluate(iframeInfoInPage).catch(() => null);
                if (!info) {
                    ok = false;
                    break;
                }
                chain.unshift(info.sel);
                if (!label)
                    label = info.label;
                cur = cur.parentFrame();
            }
            if (ok && chain.length)
                out.push({ frame: f, chain, label });
        }
        return out.sort((x, y) => x.chain.length - y.chain.length);
    }
    /** Page or nested FrameLocator for a selector chain. */
    scope(chain) {
        let sc = this.page;
        for (const sel of chain ?? [])
            sc = sc.frameLocator(sel);
        return sc;
    }
    static codePrefix(chain) {
        return 'page' + (chain ?? []).map((sel) => `.frameLocator(${JSON.stringify(sel)})`).join('');
    }
    /** Frames to search for a step: an explicit chain, a fuzzy frame name, or main + every visible frame. */
    async scopesFor(frame) {
        if (Array.isArray(frame))
            return [frame];
        const frames = await this.listFrames();
        if (frame) {
            const f = frame.toLowerCase();
            const hit = frames.filter((x) => x.label.toLowerCase().includes(f) || x.chain.some((c) => c.toLowerCase().includes(f)));
            return hit.length ? hit.map((x) => x.chain) : [[frame]]; // fall back to treating it as an iframe selector
        }
        return [[], ...frames.map((x) => x.chain)];
    }
    /** Visible text across the page, its open shadow roots and all visible iframes, tagged by frame chain. */
    async deepTexts() {
        const page = this.page;
        const out = [{ chain: [], text: await page.evaluate(deepTextInPage).catch(() => '') }];
        for (const fr of await this.listFrames())
            out.push({ chain: fr.chain, text: await fr.frame.evaluate(deepTextInPage).catch(() => '') });
        return out;
    }
    /** Compact text: header + lines */
    static render(res) {
        const lines = res.items.map((i) => i.line);
        return `url: ${redactor.pageUrl(res.url)}\ntitle: ${res.title}\n` + lines.join('\n') + (res.truncated ? '\n… (truncated; use snapshot with root=<css> to scope)' : '');
    }
    /** Diff vs previous snapshot keyed by line content. */
    diff(newLines) {
        const strip = (l) => l.replace(/^e\d+ /, '');
        const before = new Map();
        for (const l of this.lastLines)
            before.set(strip(l), (before.get(strip(l)) || 0) + 1);
        const added = [];
        for (const l of newLines) {
            const k = strip(l);
            const n = before.get(k) || 0;
            if (n > 0)
                before.set(k, n - 1);
            else
                added.push(l);
        }
        const after = new Map();
        for (const l of newLines)
            after.set(strip(l), (after.get(strip(l)) || 0) + 1);
        const removed = [];
        for (const l of this.lastLines) {
            const k = strip(l);
            const n = after.get(k) || 0;
            if (n > 0)
                after.set(k, n - 1);
            else
                removed.push(l);
        }
        return { added, removed };
    }
    /**
     * Resolve a target string to a locator. Works across open shadow DOM (Playwright locators pierce it)
     * and across iframes (searched main frame first, then each visible frame).
     *  - "e12"                 -> ref from the last snapshot (falls back to its recorded selector if the node was re-rendered)
     *  - "css=..", "#id", "[..]", "role=..", "text=..", "xpath=.."  -> raw Playwright selector
     *  - "testid=x"            -> getByTestId
     *  - anything else         -> semantic: label / placeholder / role+name / text, chosen by intent
     */
    async resolve(target, intent, timeout = DEFAULT_TIMEOUT, frame) {
        const t = target.trim();
        const strict = this.strictNow ?? this.cfg?.strictLocators ?? false;
        const fr = (c) => (c && c.length ? c : undefined);
        if (/^e\d+$/.test(t)) {
            const h = this.hints.get(t);
            const sc = this.scope(h?.frame);
            const byRef = sc.locator(`[data-fq="${t}"]`);
            const pre = Session.codePrefix(h?.frame);
            if (await byRef.count()) {
                return { loc: byRef.first(), record: h?.hint ?? `[data-fq="${t}"]`, code: (h?.code ?? `page.locator('[data-fq="${t}"]')`).replace(/^page/, pre), frame: fr(h?.frame) };
            }
            if (!h)
                throw new Error(`Unknown ref ${t}. Take a snapshot first.`);
            if (strict) {
                // The stamped element is gone. Falling back to its recorded selector is only safe when that is still unambiguous.
                if (h.gen !== undefined && h.gen !== this.docGen)
                    throw new Error(`Stale ref ${t}: the page navigated after it was issued. Take a snapshot and use a current ref.`);
                const n = await sc.locator(h.hint).count().catch(() => 0);
                if (n !== 1)
                    throw new Error(`Stale ref ${t}: its element is gone and the recorded selector now matches ${n} elements. Take a snapshot and use a current ref.`);
            }
            return { loc: sc.locator(h.hint).first(), record: h.hint, code: (h.code ?? `page.locator(${JSON.stringify(h.hint)})`).replace(/^page/, pre), frame: fr(h.frame) };
        }
        const deadline = Date.now() + timeout;
        let scopes = await this.scopesFor(frame);
        let polls = 0;
        do {
            // pass 1: exact matches in every scope; pass 2: fuzzy. So an exact button in an iframe beats loose text in the page.
            for (const exactPass of [true, false])
                for (const chain of scopes) {
                    const sc = this.scope(chain);
                    const pre = Session.codePrefix(chain);
                    for (const [loc, code] of this.candidates(sc, t, intent).filter((c) => /exact: true|getByTestId|page\.locator/.test(c[1]) === exactPass)) {
                        const v = loc.filter({ visible: true });
                        const n = await v.count().catch(() => 0);
                        if (n > 0) {
                            // Strict mode never picks one of several matches: it reports the candidates and lets the caller choose a ref.
                            if (n > 1 && strict)
                                throw new AmbiguousTargetError(await this.describeAmbiguous(v, n, t, chain));
                            const raw = !/^(testid=|css=|xpath=|role=|text=|#|\[|\.|\/\/)/.test(t) ? `${code}.first()` : code;
                            return { loc: v.first(), record: t, code: raw.replace(/^page/, pre), frame: fr(chain) };
                        }
                    }
                }
            await sleep(100);
            if (++polls % 5 === 0 && !Array.isArray(frame))
                scopes = await this.scopesFor(frame); // frames may appear late
        } while (Date.now() < deadline);
        throw new Error(`No visible element matches "${t}"${frame ? ` in frame "${frame}"` : ''} (tried ${intent === 'fill' ? 'label, placeholder, textbox' : 'role+name, label, text'} in page, shadow DOM and iframes)`);
    }
    /** Stamps refs on the first matches and describes them compactly, so the caller can retry with an exact ref. */
    async describeAmbiguous(v, n, t, chain) {
        let items = [];
        try {
            items = await v.evaluateAll((els, base) => {
                const w = window;
                w.__fq = w.__fq || { n: 0 };
                w.__fq.n = Math.max(w.__fq.n, base);
                const clean = (s, max) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
                const cssPath = (el) => {
                    const path = [];
                    let cur = el;
                    while (cur && cur.nodeType === 1 && path.length < 8) {
                        if (cur.id) {
                            path.unshift('#' + CSS.escape(cur.id));
                            break;
                        }
                        const tag = cur.tagName.toLowerCase();
                        const p = cur.parentElement;
                        const self = cur;
                        const sib = p ? Array.from(p.children).filter((c) => c.tagName === self.tagName) : [self];
                        path.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(self) + 1})` : tag);
                        cur = p;
                    }
                    return path.join(' > ');
                };
                return els.slice(0, 5).map((el) => {
                    let ref = el.getAttribute('data-fq');
                    if (!ref) {
                        ref = 'e' + (++w.__fq.n);
                        el.setAttribute('data-fq', ref);
                    }
                    const box = el.closest('li,tr,section,article,form,fieldset,[role=row],[role=listitem],.card');
                    return { ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), text: clean(el.innerText || el.getAttribute('aria-label') || el.value, 40), near: clean(box?.innerText, 60), hint: cssPath(el) };
                });
            }, this.refBase);
        }
        catch { /* the page changed while describing: report the count only */ }
        for (const it of items) {
            this.refBase = Math.max(this.refBase, Number(it.ref.slice(1)) || 0);
            this.hints.set(it.ref, { hint: it.hint, code: `page.locator(${JSON.stringify(it.hint)})`, frame: chain.length ? chain : undefined, gen: this.docGen });
        }
        const list = items.map((i) => `${i.ref} ${i.role} ${JSON.stringify(i.text)}${i.near && i.near !== i.text ? ` in ${JSON.stringify(i.near)}` : ''}`).join(' | ');
        return `"${t}" matches ${n} elements and strict mode will not pick one. Use a ref: ${list}${n > items.length ? ` | … ${n - items.length} more` : ''}`;
    }
    candidates(sc, t, intent) {
        if (/^testid=/.test(t)) {
            const id = t.slice(7);
            return [[sc.getByTestId(id), `page.getByTestId(${JSON.stringify(id)})`]];
        }
        if (/^(css=|xpath=|role=|text=|#|\[|\.|\/\/)/.test(t)) {
            const sel = t.replace(/^css=/, '');
            return [[sc.locator(sel), `page.locator(${JSON.stringify(sel)})`]];
        }
        const s = JSON.stringify(t);
        const c = [];
        if (intent === 'fill') {
            c.push([sc.getByLabel(t, { exact: true }), `page.getByLabel(${s}, { exact: true })`], [sc.getByPlaceholder(t, { exact: true }), `page.getByPlaceholder(${s}, { exact: true })`], [sc.getByRole('textbox', { name: t, exact: true }), `page.getByRole('textbox', { name: ${s}, exact: true })`], [sc.getByRole('combobox', { name: t, exact: true }), `page.getByRole('combobox', { name: ${s}, exact: true })`], [sc.getByLabel(t), `page.getByLabel(${s})`], [sc.getByPlaceholder(t), `page.getByPlaceholder(${s})`]);
        }
        else {
            const roles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option', 'combobox'];
            for (const r of roles)
                c.push([sc.getByRole(r, { name: t, exact: true }), `page.getByRole('${r}', { name: ${s}, exact: true })`]);
            c.push([sc.getByLabel(t, { exact: true }), `page.getByLabel(${s}, { exact: true })`]);
            c.push([sc.getByText(t, { exact: true }), `page.getByText(${s}, { exact: true })`]);
            for (const r of ['button', 'link'])
                c.push([sc.getByRole(r, { name: t }), `page.getByRole('${r}', { name: ${s} })`]);
            c.push([sc.getByText(t), `page.getByText(${s})`]);
        }
        return c;
    }
    /** Elements hidden in every screenshot: password fields plus privacy.maskSelectors. A screenshot can still show other secrets. */
    maskLocators() {
        if (!this.page)
            return [];
        return ['input[type=password]', ...(this.cfg?.privacy.maskSelectors ?? [])].map((s) => this.page.locator(s));
    }
    takeEvidence() {
        const e = this.evidence;
        this.evidence = { console: [], pageErrors: [], failedRequests: [] };
        return e;
    }
}
function push(arr, s) { if (arr.length < 50)
    arr.push(s.slice(0, 300)); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deviceProfile(name) {
    const key = Object.keys(devices).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key)
        throw new Error(`Unknown device "${name}". Examples: "iPhone 13", "Pixel 7", "iPad Mini", "Galaxy S9+".`);
    const { defaultBrowserType, ...profile } = devices[key];
    return profile;
}
async function launch() {
    if (env.FASTQA_CDP_URL)
        return chromium.connectOverCDP(env.FASTQA_CDP_URL);
    const headless = !/^(1|true|yes)$/i.test(env.FASTQA_HEADED || '');
    const args = ['--disable-dev-shm-usage', '--no-first-run', '--disable-extensions'];
    const tries = [];
    if (env.FASTQA_CHROME)
        tries.push({ executablePath: env.FASTQA_CHROME });
    tries.push({}); // Playwright-bundled chromium
    tries.push({ channel: 'chrome' }); // installed Google Chrome
    tries.push({ channel: 'msedge' });
    let last;
    for (const t of tries) {
        try {
            return await chromium.launch({ headless, args, ...t });
        }
        catch (e) {
            last = e;
        }
    }
    throw new Error(`Could not launch a browser. Run "npx playwright install chromium" or set FASTQA_CHROME. Last error: ${String(last).split('\n')[0]}`);
}
