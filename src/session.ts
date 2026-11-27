import { chromium, devices, type Browser, type BrowserContext, type Page, type Locator, type Frame, type FrameLocator } from 'playwright';
import { snapshotInPage, domSettleInPage, deepTextInPage, iframeInfoInPage, type SnapItem } from './snapshot.js';
import { loadConfig, type Config, type Mode } from './config.js';
import { Observer } from './observation/observer.js';
import { redactor } from './privacy/redact.js';
import { FLOW_DIR } from './dirs.js';
import { madeDir, removeMadeDirs } from './upload.js';
import { probeInit, mergeProbes, type ProbeData } from './probe.js';

export type Intent = 'click' | 'fill' | 'any';

export interface Step {
  do: string;
  target?: string;
  value?: string;
  timeout?: number;
  /** restrict to an iframe: its title/name/id/src fragment, or a selector chain recorded by fastqa */
  frame?: string | string[];
}

export interface RecordedStep extends Step {
  code?: string; // Playwright code for the locator, used by export
}

/** Timestamped event log used by expect_request / expect_no_errors and reports. */
export interface LogEvent {
  t: number;
  kind: 'pageerror' | 'console' | 'http';
  text: string;
  method?: string;
  url?: string;
  status?: number; // 0 = network failure
  /** request id in the observation layer */
  rid?: string;
}

/** Something the browser did outside the page: a native dialog, a download, a file picker. */
export interface SessionEvent { kind: 'dialog' | 'download' | 'picker'; type?: string; text: string }

/** Thrown in strict locator mode when a target matches more than one element. */
export class AmbiguousTargetError extends Error {}

export interface Evidence {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
}

const env = process.env;
let warnedTls = false;
/** Told once per process, and only when an HTTPS site is actually opened with the 0.3 default still in effect. */
export function warnLegacyTls() {
  if (warnedTls) return;
  warnedTls = true;
  console.error('fastqa: invalid HTTPS certificates are accepted (0.3 default). Add .fastqa/config.json to be secure by default, or set FASTQA_IGNORE_HTTPS_ERRORS.');
}
export const DEFAULT_TIMEOUT = Number(env.FASTQA_TIMEOUT_MS || 5000);

/** Services that attach to every new session (artifacts, discovery, contracts) register here; keeps this module free of them. */
export const sessionHooks = { created: [] as Array<(s: Session) => void> };

export class Session {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  /** last snapshot lines (for diffs) and ref -> selector hints (for stale refs + recording) */
  lastLines: string[] = [];
  hints = new Map<string, { hint: string; code?: string; frame?: string[]; gen?: number }>();
  /** strict locators for the running batch (act strict:true); falls back to locator.strict from the config */
  strictNow?: boolean;
  tape: RecordedStep[] = [];
  evidence: Evidence = { console: [], pageErrors: [], failedRequests: [] };
  inflight = 0;
  pending = new Set<unknown>();
  refBase = 0;
  log: LogEvent[] = [];
  /** start of the current act batch / flow run; expect_request and expect_no_errors look from here */
  mark = 0;
  device?: string;
  /** observation scope of the current browser context; kept after close so evidence stays readable */
  obs!: Observer;
  cfg!: Config;
  /** explicit run option (CLI --mode, flow run mode); overrides the config file */
  mode?: Mode;
  /** per-run options that services read (CLI --bundle, --baseline) */
  options: { bundle?: boolean; baseline?: 'record' | 'check' } = {};
  /** called when a session ends (context closed), before the observer is replaced */
  onEnd?: (obs: Observer) => Promise<void> | void;
  /** origins whose cookie banner was already looked for in this context (see the cookies step) */
  consentAsked = new Set<string>();
  /** folders of files that upload steps made: the page reads a chosen file only when it uses it, so they live as long as the context */
  private madeDirs: string[] = [];
  async uploadDir(): Promise<string> { const d = await madeDir(); this.madeDirs.push(d); return d; }
  /** requests whose response is still arriving (unlike `pending`, which ends at the response headers) */
  private loading = new Set<unknown>();
  private lastLoadAt = Date.now();
  /** How long the page has fetched nothing, in ms: 0 while a response is still arriving. */
  quietFor(): number { return this.loading.size ? 0 : Date.now() - this.lastLoadAt; }
  /** counts main-frame navigations: a ref issued on an older document is stale */
  docGen = 0;
  private detachers: Array<() => void> = [];

  private addLog(e: Omit<LogEvent, 't'>) {
    this.log.push({ t: Date.now(), ...e });
    if (this.log.length > 2000) this.log.splice(0, 500);
  }
  since(t: number) { return this.log.filter((e) => e.t >= t); }

  /** device: a Playwright device name such as "iPhone 13" or "Pixel 7"; switching device opens a new context. */
  async ensure(fresh = false, device?: string): Promise<Page> {
    if (device !== undefined && device !== (this.device ?? '')) { fresh = true; this.device = device || undefined; }
    if (fresh) await this.closeContext();
    if (!this.context) {
      // Validate configuration before any browser work: an invalid policy is an error, never a silent fallback.
      this.cfg = loadConfig(FLOW_DIR(), this.mode);
      redactor.configure(this.cfg.privacy);
      for (const [k, v] of Object.entries(env)) if (k.startsWith('FASTQA_VAR_') && v && redactor.isSecretVar(k.slice(11))) redactor.addSecret(v, k.slice(11));
      for (const w of this.cfg.warnings) console.error(`fastqa: config: ${w}`);
    }
    if (!this.browser) this.browser = await launch();
    if (!this.context) {
      const [w, h] = (env.FASTQA_VIEWPORT || '1280x800').split('x').map(Number);
      const tls = { ignoreHTTPSErrors: this.cfg.browser.ignoreHTTPSErrors };
      this.context = this.browser.contexts()[0] && env.FASTQA_CDP_URL
        ? this.browser.contexts()[0]
        : await this.browser.newContext(this.device ? { ...deviceProfile(this.device), ...tls } : { viewport: { width: w, height: h }, ...tls });
      this.context.setDefaultTimeout(DEFAULT_TIMEOUT);
      this.obs = new Observer(this.cfg, redactor);
      this.obs.environment.browser = `chromium ${this.browser.version()}`;
      if (this.device) this.obs.environment.device = this.device;
      for (const h of sessionHooks.created) h(this);
      this.attachContext(this.context);
      // the page probe: what an action did that the final snapshot cannot show (see probe.ts)
      await this.context.addInitScript(probeInit).catch(() => {});
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.attachPage(this.page);
      await this.page.evaluate(probeInit).catch(() => {}); // a page that was open before (attached over CDP)
    }
    return this.page;
  }

  /**
   * What the browser did outside the page since the last takeEvents(): native dialogs (handled exactly as Playwright does
   * when nobody listens: beforeunload accepted, the others dismissed), downloads, and file pickers the page opened.
   */
  private events: SessionEvent[] = [];
  takeEvents(): SessionEvent[] { return this.events.splice(0); }
  /** set while an upload step answers its own file picker, which is not news */
  uploading = false;
  private note(e: SessionEvent) { if (this.events.length < 20) this.events.push(e); }

  /** The frames whose probe is read: the page and its first-party frames (third-party frames are ads and widgets). */
  private probeFrames(): Frame[] {
    const page = this.page;
    if (!page || page.isClosed()) return [];
    const first = (f: Frame) => { try { return this.obs?.firstParty.has(new URL(f.url()).origin) ?? false; } catch { return false; } };
    return [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame() && !f.isDetached() && first(f)).slice(0, 4)];
  }
  /** What the page probes saw since their previous drain (and starts a new window); undefined when none could be read. */
  async probeDrain(): Promise<ProbeData | undefined> {
    return mergeProbes(await Promise.all(this.probeFrames().map((f) => f.evaluate(() => (window as any).__fqProbe?.drain()).catch(() => undefined))));
  }

  /**
   * Listeners are bound once per context, at context level, so the first request of a new page or popup is never missed
   * and nothing is registered twice. Each handler feeds the 0.3 buffers (explicit assertions, legacy evidence) and the observer.
   */
  private attachContext(ctx: BrowserContext) {
    const on = (ev: string, fn: (...a: any[]) => void) => { (ctx as any).on(ev, fn); this.detachers.push(() => (ctx as any).off(ev, fn)); };
    const cdp = !!env.FASTQA_CDP_URL;
    const pageOf = (r: { frame(): Frame }): Page | undefined => { try { return r.frame().page(); } catch { return this.page; } };
    // Context-level events also carry traffic that page-level listeners (0.3) never saw: requests made by a service
    // worker, and pages fastqa does not drive (other tabs of a browser attached over CDP). Both are ignored.
    const foreign = (r: import('playwright').Request): boolean => {
      try { if (r.serviceWorker()) return true; } catch { /* not a worker request */ }
      // In a context fastqa created, every page is one it drives (popups included, even before their 'page' event).
      // Only an attached browser (CDP) has tabs that belong to someone else.
      if (!cdp) return false;
      const p = pageOf(r);
      return !!p && !this.attachedPages.has(p);
    };
    const stranger = (p: Page | null | undefined) => cdp && !!p && !this.attachedPages.has(p);
    on('page', (p: Page) => { this.page = p; this.attachPage(p); this.obs.onPage(p, 'page_opened'); });
    on('console', (m: import('playwright').ConsoleMessage) => {
      if (/favicon/.test(m.location()?.url || '')) return;
      if (stranger(m.page())) return;
      const text = redactor.text(m.text().slice(0, 2000));
      if (m.type() === 'error' || m.type() === 'warning') push(this.evidence.console, `[${m.type()}] ${text}`);
      if (m.type() === 'error' && !/Failed to load resource/.test(text)) this.addLog({ kind: 'console', text });
      const p = m.page() ?? this.page; if (p) this.obs.onConsole(p, m);
    });
    on('weberror', (w: import('playwright').WebError) => {
      if (stranger(w.page())) return;
      const e = w.error(); const msg = redactor.text(String(e?.message || e).slice(0, 2000));
      push(this.evidence.pageErrors, msg);
      this.addLog({ kind: 'pageerror', text: msg });
      const p = w.page() ?? this.page; if (p) this.obs.onPageError(p, e);
    });
    // A request counts as in flight until its response headers arrive (bodies the app never reads must not block settle).
    on('request', (r: import('playwright').Request) => {
      if (foreign(r)) return;
      this.pending.add(r); this.inflight = this.pending.size;
      this.loading.add(r); this.lastLoadAt = Date.now();
      const p = pageOf(r); if (p) this.obs.onRequest(p, r);
    });
    on('response', (res: import('playwright').Response) => {
      const r = res.request();
      if (foreign(r)) return;
      this.pending.delete(r); this.inflight = this.pending.size;
      const p = pageOf(r); const rec = p ? this.obs.onResponse(p, res) : undefined;
      const url = rec?.url ?? redactor.networkUrl(r.url());
      if (['fetch', 'xhr', 'document'].includes(r.resourceType()))
        this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: res.status(), text: `${res.status()} ${r.method()} ${url}`, rid: rec?.id });
      if (res.status() >= 400 && !/favicon/.test(r.url())) push(this.evidence.failedRequests, `${res.status()} ${r.method()} ${url}`);
    });
    on('requestfinished', (r: import('playwright').Request) => { if (foreign(r)) return; this.pending.delete(r); this.inflight = this.pending.size; this.loading.delete(r); this.lastLoadAt = Date.now(); this.obs.onFinished(r); });
    on('requestfailed', (r: import('playwright').Request) => {
      if (foreign(r)) return;
      this.pending.delete(r); this.inflight = this.pending.size; this.loading.delete(r); this.lastLoadAt = Date.now();
      const p = pageOf(r); const rec = p ? this.obs.onFailed(p, r) : undefined;
      if (/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) return; // aborts are recorded by the observer, not reported as failures
      const url = rec?.url ?? redactor.networkUrl(r.url());
      this.addLog({ kind: 'http', method: r.method(), url: r.url(), status: 0, text: `FAILED ${r.method()} ${url}`, rid: rec?.id });
      push(this.evidence.failedRequests, `FAILED ${r.method()} ${url} ${r.failure()?.errorText ?? ''}`);
    });
  }

  private attachedPages = new WeakSet<Page>();
  private attachPage(page: Page) {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    const nav = (f: Frame) => { if (f === page.mainFrame()) this.docGen++; this.obs.onNavigated(page, f); };
    const closed = () => {
      this.obs.onPage(page, 'page_closed');
      // its open requests will never finish: stop waiting for them
      for (const r of [...this.pending] as import('playwright').Request[]) { try { if (r.frame().page() === page) this.pending.delete(r); } catch { /* no frame: leave it */ } }
      for (const r of [...this.loading] as import('playwright').Request[]) { try { if (r.frame().page() === page) this.loading.delete(r); } catch { /* no frame: leave it */ } }
      this.inflight = this.pending.size;
      // a popup that closes hands control back to the page that is still open
      if (this.page === page) { const open = this.context?.pages().filter((p) => !p.isClosed()) ?? []; if (open.length) this.page = open[open.length - 1]; }
    };
    // Native dialogs: recorded for the step's facts and handled exactly as Playwright does when nobody listens:
    // beforeunload is accepted (leaving goes ahead), alert / confirm / prompt are dismissed. Behaviour is unchanged.
    const dialog = (d: import('playwright').Dialog) => {
      const beforeunload = d.type() === 'beforeunload';
      this.note({ kind: 'dialog', type: d.type(), text: redactor.text(d.message().replace(/\s+/g, ' ').trim().slice(0, 80)) });
      (beforeunload ? d.accept() : d.dismiss()).catch(() => {});
    };
    const download = (d: import('playwright').Download) => this.note({ kind: 'download', text: redactor.text(d.suggestedFilename().slice(0, 80)) });
    // Listening also keeps a headed browser from opening the native picker, which would block the run.
    const picker = () => { if (!this.uploading) this.note({ kind: 'picker', text: '' }); };
    page.on('framenavigated', nav); page.on('close', closed); page.on('dialog', dialog); page.on('download', download); page.on('filechooser', picker);
    this.detachers.push(() => { page.off('framenavigated', nav); page.off('close', closed); page.off('dialog', dialog); page.off('download', download); page.off('filechooser', picker); });
  }

  /** maxMs: longest to wait for the context to close (only `close` sets it: the browser is closed right after anyway). */
  async closeContext(maxMs?: number) {
    for (const d of this.detachers.splice(0)) try { d(); } catch { /* context already gone */ }
    this.attachedPages = new WeakSet(); // a context that stays open (CDP) must get its page listeners again next time
    if (this.obs && !this.obs.disposed) {
      this.obs.dispose();
      try { await this.onEnd?.(this.obs); } catch (e) { console.error(`fastqa: could not finalize session ${this.obs.sessionId}: ${String(e).split('\n')[0]}`); }
    }
    if (this.context && !env.FASTQA_CDP_URL) {
      const closing = this.context.close().catch(() => {});
      await (maxMs === undefined ? closing : within(closing, maxMs));
    }
    this.context = undefined; this.page = undefined; this.inflight = 0; this.pending.clear(); this.loading.clear();
    this.lastLines = []; this.hints.clear(); this.consentAsked.clear(); this.events = [];
    await removeMadeDirs(this.madeDirs.splice(0));
  }

  /**
   * Closes the browser and answers when it is gone: 'closed', or 'pending' if it had not exited when the time was up.
   *
   * Playwright's browser.close() resolves only after it has also deleted the browser's temporary profile folder. On Windows
   * that takes as long as another program (antivirus, indexer) holds a file in the folder, long after the browser itself has
   * exited, so waiting for it made the close call hang until clients gave up on it. Here the whole close is awaited as before,
   * but once the browser process has exited the cleanup gets only `graceMs` more, and nothing is waited for longer than
   * `maxMs` in total. Whatever is left keeps running in the background; the next open starts a new browser.
   */
  async close(o: { maxMs?: number; graceMs?: number } = {}): Promise<'closed' | 'pending'> {
    const maxMs = o.maxMs ?? CLOSE_MAX_MS;
    const end = Date.now() + maxMs;
    await this.closeContext(Math.min(maxMs, CLOSE_MAX_MS) / 2);
    const b = this.browser;
    this.browser = undefined;
    if (!b) return 'closed';
    let exited = !b.isConnected();
    const gone = new Promise<void>((r) => { if (exited) r(); else b.once('disconnected', () => { exited = true; r(); }); });
    const whole = b.close().catch(() => {}).then(() => { exited = true; });
    await within(Promise.race([whole, gone.then(() => within(whole, o.graceMs ?? CLOSE_GRACE_MS))]), end - Date.now());
    return exited ? 'closed' : 'pending';
  }

  /** Wait until network is idle-ish and DOM is quiet. Bounded so it never costs more than ~maxMs. */
  async settle(maxMs = 2000) {
    const page = this.page!;
    const start = Date.now();
    await page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => {});
    while (this.inflight > 0 && Date.now() - start < maxMs) await sleep(25);
    const left = Math.max(50, maxMs - (Date.now() - start));
    await page.evaluate(domSettleInPage, { quietMs: 80, maxMs: left }).catch(() => {});
  }

  async snapshot(mode: 'interactive' | 'full' = 'interactive', root?: string, max = Number(env.FASTQA_MAX_LINES || 250)) {
    const page = this.page!;
    let res: Awaited<ReturnType<typeof snapshotInPage>> | undefined;
    for (let i = 0; i < 3 && !res; i++) {
      try { res = await page.evaluate(snapshotInPage, { mode, root, max, base: this.refBase }); }
      catch (e) { if (!/context was destroyed|navigat/i.test(String(e))) throw e; await page.waitForLoadState('domcontentloaded').catch(() => {}); }
    }
    if (!res) throw new Error('Page kept navigating; could not take a snapshot');
    this.refBase = Math.max(this.refBase, res.maxRef);
    const items: SnapItem[] = [...res.items];
    let truncated = res.truncated;
    // iframes (same- and cross-origin): each visible frame gets its own indented block
    if (!root) {
      for (const fr of await this.listFrames()) {
        if (items.length >= max) { truncated = true; break; }
        try {
          const r = await fr.frame.evaluate(snapshotInPage, { mode, max: max - items.length, base: this.refBase });
          this.refBase = Math.max(this.refBase, r.maxRef);
          const indent = '  '.repeat(fr.chain.length);
          items.push({ line: `${'  '.repeat(fr.chain.length - 1)}frame ${JSON.stringify(fr.label)} [${fr.chain[fr.chain.length - 1]}]` });
          for (const it of r.items) items.push({ ...it, line: indent + it.line, frame: fr.chain });
          truncated ||= r.truncated;
        } catch { /* frame navigated or detached mid-snapshot */ }
      }
    }
    for (const it of items) if (it.ref && it.hint) this.hints.set(it.ref, { hint: it.hint, code: it.code, frame: it.frame, gen: this.docGen });
    return { items, truncated, url: res.url, title: res.title, page: res.page };
  }

  /** Visible child frames with their selector chain from the top page (nested frames supported). */
  async listFrames(): Promise<Array<{ frame: Frame; chain: string[]; label: string }>> {
    const page = this.page!;
    const out: Array<{ frame: Frame; chain: string[]; label: string }> = [];
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue;
      const chain: string[] = []; let label = '';
      let cur: Frame | null = f; let ok = true;
      while (cur && cur.parentFrame()) {
        const el = await cur.frameElement().catch(() => null);
        if (!el || !(await el.isVisible().catch(() => false))) { ok = false; break; }
        const info = await el.evaluate(iframeInfoInPage).catch(() => null);
        if (!info) { ok = false; break; }
        chain.unshift(info.sel); if (!label) label = info.label;
        cur = cur.parentFrame();
      }
      if (ok && chain.length) out.push({ frame: f, chain, label });
    }
    return out.sort((x, y) => x.chain.length - y.chain.length);
  }

  /** Page or nested FrameLocator for a selector chain. */
  scope(chain?: string[]): Page | FrameLocator {
    let sc: Page | FrameLocator = this.page!;
    for (const sel of chain ?? []) sc = sc.frameLocator(sel);
    return sc;
  }
  static codePrefix(chain?: string[]) {
    return 'page' + (chain ?? []).map((sel) => `.frameLocator(${JSON.stringify(sel)})`).join('');
  }

  /** Frames to search for a step: an explicit chain, a fuzzy frame name, or main + every visible frame. */
  async scopesFor(frame?: string | string[]): Promise<string[][]> {
    if (Array.isArray(frame)) return [frame];
    const frames = await this.listFrames();
    if (frame) {
      const f = frame.toLowerCase();
      const hit = frames.filter((x) => x.label.toLowerCase().includes(f) || x.chain.some((c) => c.toLowerCase().includes(f)));
      return hit.length ? hit.map((x) => x.chain) : [[frame]]; // fall back to treating it as an iframe selector
    }
    return [[], ...frames.map((x) => x.chain)];
  }

  /** Visible text across the page, its open shadow roots and all visible iframes, tagged by frame chain. */
  async deepTexts(): Promise<Array<{ chain: string[]; text: string }>> {
    const page = this.page!;
    const out = [{ chain: [] as string[], text: await page.evaluate(deepTextInPage).catch(() => '') }];
    for (const fr of await this.listFrames()) out.push({ chain: fr.chain, text: await fr.frame.evaluate(deepTextInPage).catch(() => '') });
    return out;
  }

  /** Compact text: header + lines */
  static render(res: { items: SnapItem[]; truncated: boolean; url: string; title: string; maxRef?: number }) {
    const lines = res.items.map((i) => i.line);
    return `url: ${redactor.pageUrl(res.url)}\ntitle: ${res.title}\n` + lines.join('\n') + (res.truncated ? '\n… (truncated; use snapshot with root=<css> to scope)' : '');
  }

  /** Diff vs previous snapshot keyed by line content. */
  diff(newLines: string[]) {
    const strip = (l: string) => l.replace(/^e\d+ /, '');
    const before = new Map<string, number>();
    for (const l of this.lastLines) before.set(strip(l), (before.get(strip(l)) || 0) + 1);
    const added: string[] = [];
    for (const l of newLines) {
      const k = strip(l); const n = before.get(k) || 0;
      if (n > 0) before.set(k, n - 1); else added.push(l);
    }
    const after = new Map<string, number>();
    for (const l of newLines) after.set(strip(l), (after.get(strip(l)) || 0) + 1);
    const removed: string[] = [];
    for (const l of this.lastLines) {
      const k = strip(l); const n = after.get(k) || 0;
      if (n > 0) after.set(k, n - 1); else removed.push(l);
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
  async resolve(target: string, intent: Intent, timeout = DEFAULT_TIMEOUT, frame?: string | string[]):
    Promise<{ loc: Locator; record: string; code: string; frame?: string[] }> {
    const t = target.trim();
    const strict = this.strictNow ?? this.cfg?.strictLocators ?? false;
    const fr = (c?: string[]) => (c && c.length ? c : undefined);
    if (/^e\d+$/.test(t)) {
      const h = this.hints.get(t);
      const sc = this.scope(h?.frame);
      const byRef = sc.locator(`[data-fq="${t}"]`);
      const pre = Session.codePrefix(h?.frame);
      if (await byRef.count()) {
        return { loc: byRef.first(), record: h?.hint ?? `[data-fq="${t}"]`, code: (h?.code ?? `page.locator('[data-fq="${t}"]')`).replace(/^page/, pre), frame: fr(h?.frame) };
      }
      if (!h) throw new Error(`Unknown ref ${t}. Take a snapshot first.`);
      if (strict) {
        // The stamped element is gone. Falling back to its recorded selector is only safe when that is still unambiguous.
        if (h.gen !== undefined && h.gen !== this.docGen) throw new Error(`Stale ref ${t}: the page navigated after it was issued. Take a snapshot and use a current ref.`);
        const n = await sc.locator(h.hint).count().catch(() => 0);
        if (n !== 1) throw new Error(`Stale ref ${t}: its element is gone and the recorded selector now matches ${n} elements. Take a snapshot and use a current ref.`);
      }
      return { loc: sc.locator(h.hint).first(), record: h.hint, code: (h.code ?? `page.locator(${JSON.stringify(h.hint)})`).replace(/^page/, pre), frame: fr(h.frame) };
    }
    const deadline = Date.now() + timeout;
    let scopes = await this.scopesFor(frame);
    let polls = 0;
    do {
      // pass 1: exact matches in every scope; pass 2: fuzzy. So an exact button in an iframe beats loose text in the page.
      for (const exactPass of [true, false]) for (const chain of scopes) {
        const sc = this.scope(chain);
        const pre = Session.codePrefix(chain);
        for (const [loc, code] of this.candidates(sc, t, intent).filter((c) => /exact: true|getByTestId|page\.locator/.test(c[1]) === exactPass)) {
          const v = loc.filter({ visible: true });
          const n = await v.count().catch(() => 0);
          if (n > 0) {
            // Strict mode never picks one of several matches: it reports the candidates and lets the caller choose a ref.
            if (n > 1 && strict) throw new AmbiguousTargetError(await this.describeAmbiguous(v, n, t, chain));
            const raw = !/^(testid=|css=|xpath=|role=|text=|#|\[|\.|\/\/)/.test(t) ? `${code}.first()` : code;
            return { loc: v.first(), record: t, code: raw.replace(/^page/, pre), frame: fr(chain) };
          }
        }
      }
      await sleep(100);
      if (++polls % 5 === 0 && !Array.isArray(frame)) scopes = await this.scopesFor(frame); // frames may appear late
    } while (Date.now() < deadline);
    throw new Error(`No visible element matches "${t}"${frame ? ` in frame "${frame}"` : ''} (tried ${intent === 'fill' ? 'label, placeholder, textbox' : 'role+name, label, text'} in page, shadow DOM and iframes)`);
  }

  /**
   * Target of an upload step. `input` true: a file input (or its label) that takes the files directly. false: a visible
   * element, such as a styled button or a drop zone, whose click opens the file picker.
   *  - no target           -> the page's only file input (waits for one to appear; several are listed)
   *  - ref "e12"           -> that element (the snapshot also lists hidden file inputs)
   *  - selector or label   -> a file input it names, also a hidden one: styled upload widgets hide the real input
   *  - anything else       -> the visible element, resolved like a click target
   */
  async resolveUpload(target: string | undefined, timeout = DEFAULT_TIMEOUT, frame?: string | string[]):
    Promise<{ loc: Locator; record?: string; code: string; frame?: string[]; input: boolean }> {
    const isInput = (loc: Locator) => loc.evaluate((el: any) => (el.tagName === 'INPUT' && el.type === 'file') || el.control?.type === 'file').catch(() => false);
    const t = target?.trim();
    const fr = (c: string[]) => (c.length ? c : undefined);
    if (t && /^e\d+$/.test(t)) { const r = await this.resolve(t, 'click', timeout, frame); return { ...r, input: await isInput(r.loc) }; }
    const FILE = 'input[type=file]';
    const strict = this.strictNow ?? this.cfg?.strictLocators ?? false;
    const deadline = Date.now() + timeout;
    const q = JSON.stringify;
    // File inputs the target names, visible or not; without a target, every file input. Exact label matches in every
    // frame come before loose ones, as in resolve(). The recorded code keeps the file-input filter, so an exported spec
    // picks the same element.
    const direct = async () => {
      const scopes = await this.scopesFor(frame);
      const passes = t && !/^(testid=|css=|xpath=|#|\[|\.|\/\/)/.test(t) ? [true, false] : [true];
      for (const exact of passes) {
        const hits: Array<{ loc: Locator; code: string; chain: string[]; n: number }> = [];
        for (const chain of scopes) {
          const sc = this.scope(chain); const pre = Session.codePrefix(chain);
          const file = sc.locator(FILE); const fileCode = `${pre}.locator(${q(FILE)})`;
          const [loc, code]: [Locator, string] = !t ? [file, fileCode]
            : /^testid=/.test(t) ? [sc.getByTestId(t.slice(7)).and(file), `${pre}.getByTestId(${q(t.slice(7))}).and(${fileCode})`]
            : /^(css=|xpath=|#|\[|\.|\/\/)/.test(t) ? [sc.locator(t.replace(/^css=/, '')).and(file), `${pre}.locator(${q(t.replace(/^css=/, ''))}).and(${fileCode})`]
            : exact ? [sc.getByLabel(t, { exact: true }).and(file), `${pre}.getByLabel(${q(t)}, { exact: true }).and(${fileCode})`]
            : [sc.getByLabel(t).and(file), `${pre}.getByLabel(${q(t)}).and(${fileCode})`];
          const n = await loc.count().catch(() => 0);
          if (n) hits.push({ loc, code, chain, n });
        }
        if (hits.length) return hits;
      }
      return [];
    };
    if (!t) {
      for (;;) {
        const hits = await direct();
        const total = hits.reduce((a, h) => a + h.n, 0);
        if (total === 1) return { loc: hits[0].loc.first(), code: hits[0].code, frame: fr(hits[0].chain), input: true };
        if (total > 1) {
          const names: string[] = [];
          for (const h of hits) names.push(...await h.loc.evaluateAll((els) => els.map((el: any) => {
            const lab = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.name || el.id || '').replace(/\s+/g, ' ').trim();
            return lab ? JSON.stringify(lab.slice(0, 40)) : '(unnamed)';
          })).catch(() => []));
          throw new Error(`${total} file inputs on the page: ${names.slice(0, 6).join(', ')}${total > 6 ? ', …' : ''}. Choose one with target`);
        }
        if (Date.now() >= deadline) throw new Error('no file input on the page. Give the element that opens the file picker as target');
        await sleep(100);
      }
    }
    // Until the deadline: a file input the target names (it may be added late, and hidden), else a visible element.
    for (;;) {
      const hits = await direct();
      if (hits.length) {
        const h = hits[0];
        if (h.n > 1 && strict) throw new AmbiguousTargetError(`"${t}" matches ${h.n} file inputs and strict mode will not pick one. Use a ref from the snapshot`);
        return { loc: h.loc.first(), record: t, code: h.n > 1 ? `${h.code}.first()` : h.code, frame: fr(h.chain), input: true };
      }
      try {
        const r = await this.resolve(t, 'click', Math.min(300, Math.max(1, deadline - Date.now())), frame);
        return { ...r, input: await isInput(r.loc) };
      } catch (e) {
        if (e instanceof AmbiguousTargetError || Date.now() >= deadline) throw e;
      }
    }
  }

  /** Stamps refs on the first matches and describes them compactly, so the caller can retry with an exact ref. */
  private async describeAmbiguous(v: Locator, n: number, t: string, chain: string[]): Promise<string> {
    let items: Array<{ ref: string; role: string; text: string; near: string; hint: string }> = [];
    try {
      items = await v.evaluateAll((els, base) => {
        const w = window as any; w.__fq = w.__fq || { n: 0 }; w.__fq.n = Math.max(w.__fq.n, base);
        const clean = (s: string | null | undefined, max: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const cssPath = (el: Element) => {
          const path: string[] = []; let cur: Element | null = el;
          while (cur && cur.nodeType === 1 && path.length < 8) {
            if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
            const tag = cur.tagName.toLowerCase(); const p: Element | null = cur.parentElement; const self: Element = cur;
            const sib = p ? Array.from(p.children).filter((c) => c.tagName === self.tagName) : [self];
            path.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(self) + 1})` : tag);
            cur = p;
          }
          return path.join(' > ');
        };
        return els.slice(0, 5).map((el) => {
          let ref = el.getAttribute('data-fq');
          if (!ref) { ref = 'e' + (++w.__fq.n); el.setAttribute('data-fq', ref); }
          const box = el.closest('li,tr,section,article,form,fieldset,[role=row],[role=listitem],.card') as HTMLElement | null;
          return { ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), text: clean((el as HTMLElement).innerText || el.getAttribute('aria-label') || (el as HTMLInputElement).value, 40), near: clean(box?.innerText, 60), hint: cssPath(el) };
        });
      }, this.refBase);
    } catch { /* the page changed while describing: report the count only */ }
    for (const it of items) {
      this.refBase = Math.max(this.refBase, Number(it.ref.slice(1)) || 0);
      this.hints.set(it.ref, { hint: it.hint, code: `page.locator(${JSON.stringify(it.hint)})`, frame: chain.length ? chain : undefined, gen: this.docGen });
    }
    const list = items.map((i) => `${i.ref} ${i.role} ${JSON.stringify(i.text)}${i.near && i.near !== i.text ? ` in ${JSON.stringify(i.near)}` : ''}`).join(' | ');
    return `"${t}" matches ${n} elements and strict mode will not pick one. Use a ref: ${list}${n > items.length ? ` | … ${n - items.length} more` : ''}`;
  }

  private candidates(sc: Page | FrameLocator, t: string, intent: Intent): Array<[Locator, string]> {
    if (/^testid=/.test(t)) { const id = t.slice(7); return [[sc.getByTestId(id), `page.getByTestId(${JSON.stringify(id)})`]]; }
    if (/^(css=|xpath=|role=|text=|#|\[|\.|\/\/)/.test(t)) {
      const sel = t.replace(/^css=/, '');
      return [[sc.locator(sel), `page.locator(${JSON.stringify(sel)})`]];
    }
    const s = JSON.stringify(t);
    const c: Array<[Locator, string]> = [];
    if (intent === 'fill') {
      c.push(
        [sc.getByLabel(t, { exact: true }), `page.getByLabel(${s}, { exact: true })`],
        [sc.getByPlaceholder(t, { exact: true }), `page.getByPlaceholder(${s}, { exact: true })`],
        [sc.getByRole('textbox', { name: t, exact: true }), `page.getByRole('textbox', { name: ${s}, exact: true })`],
        [sc.getByRole('combobox', { name: t, exact: true }), `page.getByRole('combobox', { name: ${s}, exact: true })`],
        [sc.getByLabel(t), `page.getByLabel(${s})`],
        [sc.getByPlaceholder(t), `page.getByPlaceholder(${s})`],
      );
    } else {
      const roles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option', 'combobox'] as const;
      for (const r of roles) c.push([sc.getByRole(r, { name: t, exact: true }), `page.getByRole('${r}', { name: ${s}, exact: true })`]);
      c.push([sc.getByLabel(t, { exact: true }), `page.getByLabel(${s}, { exact: true })`]);
      c.push([sc.getByText(t, { exact: true }), `page.getByText(${s}, { exact: true })`]);
      for (const r of ['button', 'link'] as const) c.push([sc.getByRole(r, { name: t }), `page.getByRole('${r}', { name: ${s} })`]);
      c.push([sc.getByText(t), `page.getByText(${s})`]);
    }
    return c;
  }

  /** Elements hidden in every screenshot: password fields plus privacy.maskSelectors. A screenshot can still show other secrets. */
  maskLocators(): Locator[] {
    if (!this.page) return [];
    return ['input[type=password]', ...(this.cfg?.privacy.maskSelectors ?? [])].map((s) => this.page!.locator(s));
  }

  takeEvidence(): Evidence {
    const e = this.evidence;
    this.evidence = { console: [], pageErrors: [], failedRequests: [] };
    return e;
  }
}

function push(arr: string[], s: string) { if (arr.length < 50) arr.push(s.slice(0, 300)); }
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest `close` waits for the browser process to exit. */
export const CLOSE_MAX_MS = 10_000;
/** After the browser process has exited: how long `close` still waits for Playwright's own cleanup. */
export const CLOSE_GRACE_MS = 2_000;

/** Waits for `p`, but not longer than `ms`. Never rejects; true when `p` settled in time. */
export function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms));
    const done = () => { clearTimeout(timer); resolve(true); };
    p.then(done, done);
  });
}

function deviceProfile(name: string) {
  const key = Object.keys(devices).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) throw new Error(`Unknown device "${name}". Examples: "iPhone 13", "Pixel 7", "iPad Mini", "Galaxy S9+".`);
  const { defaultBrowserType, ...profile } = devices[key] as any;
  return profile;
}

async function launch(): Promise<Browser> {
  if (env.FASTQA_CDP_URL) return chromium.connectOverCDP(env.FASTQA_CDP_URL);
  const headless = !/^(1|true|yes)$/i.test(env.FASTQA_HEADED || '');
  const args = ['--disable-dev-shm-usage', '--no-first-run', '--disable-extensions'];
  const tries: Array<Parameters<typeof chromium.launch>[0]> = [];
  if (env.FASTQA_CHROME) tries.push({ executablePath: env.FASTQA_CHROME });
  tries.push({}); // Playwright-bundled chromium
  tries.push({ channel: 'chrome' }); // installed Google Chrome
  tries.push({ channel: 'msedge' });
  let last: unknown;
  for (const t of tries) {
    try { return await chromium.launch({ headless, args, ...t }); } catch (e) { last = e; }
  }
  throw new Error(`Could not launch a browser. Run "npx playwright install chromium" or set FASTQA_CHROME. Last error: ${String(last).split('\n')[0]}`);
}
