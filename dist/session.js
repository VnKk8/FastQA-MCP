import { chromium, devices } from 'playwright';
import { snapshotInPage, domSettleInPage, deepTextInPage, iframeInfoInPage } from './snapshot.js';
const env = process.env;
export const DEFAULT_TIMEOUT = Number(env.FASTQA_TIMEOUT_MS || 5000);
export class Session {
    browser;
    context;
    page;
    /** last snapshot lines (for diffs) and ref -> selector hints (for stale refs + recording) */
    lastLines = [];
    hints = new Map();
    tape = [];
    evidence = { console: [], pageErrors: [], failedRequests: [] };
    inflight = 0;
    pending = new Set();
    refBase = 0;
    log = [];
    /** start of the current act batch / flow run; expect_request and expect_no_errors look from here */
    mark = 0;
    device;
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
        if (!this.browser)
            this.browser = await launch();
        if (!this.context) {
            const [w, h] = (env.FASTQA_VIEWPORT || '1280x800').split('x').map(Number);
            this.context = this.browser.contexts()[0] && env.FASTQA_CDP_URL
                ? this.browser.contexts()[0]
                : await this.browser.newContext(this.device
                    ? { ...deviceProfile(this.device), ignoreHTTPSErrors: true }
                    : { viewport: { width: w, height: h }, ignoreHTTPSErrors: true });
            this.context.setDefaultTimeout(DEFAULT_TIMEOUT);
        }
        if (!this.page || this.page.isClosed()) {
            this.page = this.context.pages()[0] ?? (await this.context.newPage());
            this.attach(this.page);
            this.context.on('page', (p) => { this.page = p; this.attach(p); });
        }
        return this.page;
    }
    attach(page) {
        page.on('console', (m) => {
            if (/favicon/.test(m.location()?.url || ''))
                return;
            if (m.type() === 'error' || m.type() === 'warning')
                push(this.evidence.console, `[${m.type()}] ${m.text()}`);
            if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
                this.addLog({ kind: 'console', text: m.text() });
        });
        page.on('pageerror', (e) => {
            push(this.evidence.pageErrors, String(e?.message || e));
            this.addLog({ kind: 'pageerror', text: String(e?.message || e) });
        });
        // A request counts as in flight until its response headers arrive (bodies the app never reads must not block settle).
        page.on('request', (r) => { this.pending.add(r); this.inflight = this.pending.size; });
        page.on('response', (res) => {
            const r = res.request();
            this.pending.delete(r);
            this.inflight = this.pending.size;
            if (['fetch', 'xhr', 'document'].includes(r.resourceType()))
                this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: res.status(), text: `${res.status()} ${r.method()} ${r.url()}` });
            if (res.status() >= 400 && !/favicon/.test(r.url()))
                push(this.evidence.failedRequests, `${res.status()} ${r.method()} ${r.url()}`);
        });
        page.on('requestfinished', (r) => { this.pending.delete(r); this.inflight = this.pending.size; });
        page.on('requestfailed', (r) => {
            this.pending.delete(r);
            this.inflight = this.pending.size;
            if (/ERR_ABORTED/.test(r.failure()?.errorText ?? ''))
                return; // navigation noise
            this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: 0, text: `FAILED ${r.method()} ${r.url()}` });
            push(this.evidence.failedRequests, `FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`);
        });
    }
    async closeContext() {
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
                this.hints.set(it.ref, { hint: it.hint, code: it.code, frame: it.frame });
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
        return `url: ${res.url}\ntitle: ${res.title}\n` + lines.join('\n') + (res.truncated ? '\n… (truncated; use snapshot with root=<css> to scope)' : '');
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
                        if ((await v.count().catch(() => 0)) > 0) {
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
