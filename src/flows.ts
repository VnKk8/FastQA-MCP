import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Session, type RecordedStep } from './session.js';
import { runBatch, finalize } from './exec.js';
import { FLOW_DIR, safe, rel, writeAtomic, pruneScreenshots } from './dirs.js';
import { redactor } from './privacy/redact.js';
import { exportBundle } from './services.js';
import { findConsentButton, COOKIE_WAIT_MS } from './cookies.js';
import { uploadFiles, UPLOAD_MAX_BYTES } from './upload.js';
import type { Mode } from './config.js';
import type { Observer } from './observation/observer.js';
import type { Finding } from './observation/types.js';
import type { QualityBlock } from './quality/summary.js';
import type { PolicyOutcome } from './quality/engine.js';

export { FLOW_DIR };
const flowPath = (name: string) => path.join(FLOW_DIR(), 'flows', `${safe(name)}.json`);

export interface Flow {
  name: string;
  created: string;
  /** 2 = written by 1.0 and later. Files without it (0.3) replay unchanged. */
  schema?: number;
  steps: RecordedStep[];
}

export async function saveFlow(name: string, steps: RecordedStep[]): Promise<string> {
  const p = flowPath(name);
  // A secret the user supplied through a {{placeholder}} goes back to that placeholder: the file stays replayable and
  // holds no secret. Each string is cleaned before serialization; values learned from the page never rewrite a flow.
  const clean = (v: unknown): unknown => (typeof v === 'string' ? redactor.knownOnly(v) : Array.isArray(v) ? v.map(clean) : v);
  const flow: Flow = { name, created: new Date().toISOString(), schema: 2, steps: steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, clean(v)])) as unknown as RecordedStep) };
  await writeAtomic(p, JSON.stringify(flow, null, 2));
  return p;
}

export async function loadFlow(name: string): Promise<Flow> {
  return JSON.parse(await fs.readFile(flowPath(name), 'utf8'));
}

export async function listFlows(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(FLOW_DIR(), 'flows'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
}

export interface FlowRun {
  name: string; ok: boolean; ms: number; lines: string[]; failedAt?: number; evidence: string[];
  screenshot?: string; shotFile?: string; url?: string; started: string;
  /** steps and explicit assertions only; `ok` also includes the strict policy outcome */
  stepsOk: boolean;
  flow: string;
  sessionId?: string; runId?: string;
  quality?: QualityBlock;
  policy?: PolicyOutcome;
  qualityText?: string;
  findings: Finding[];
  findingLines: string[];
  bundle?: string;
}
export interface RunOptions { mode?: Mode; bundle?: boolean; baseline?: 'record' | 'check'; onSession?: (s: Session) => void; onDone?: (obs: Observer, run: FlowRun) => Promise<void> | void }

/** Observers of the latest flow runs, so `evidence {session}` can drill into a finished replay. */
export const recentRuns: Observer[] = [];

/** Replays a flow in its own isolated browser context. No model involved. Same executor, rules and policy as interactive use. */
export async function runFlow(name: string, vars: Record<string, string> = {}, shared?: Session, opts: RunOptions = {}): Promise<FlowRun> {
  const flow = await loadFlow(name);
  const s = new Session();
  s.mode = opts.mode ?? shared?.mode;
  if (shared?.browser) s.browser = shared.browser; // reuse the running browser process, new context
  s.options = { bundle: opts.bundle, baseline: opts.baseline };
  opts.onSession?.(s);
  const t0 = Date.now();
  const started = new Date().toISOString();
  let lines: string[] = [];
  let stepsOk = true; let failedAt: number | undefined;
  let screenshot: string | undefined; let shotFile: string | undefined; let url: string | undefined;
  let q: Awaited<ReturnType<typeof finalize>>;
  try {
    await s.ensure();
    const b = await runBatch(s, flow.steps, { kind: 'flow', scope: flow.name, vars, number: true });
    lines = b.lines; stepsOk = b.ok; failedAt = b.failedAt;
    q = await finalize(s);
  } catch (e: any) {
    stepsOk = false; lines.push(`✗ ${String(e?.message || e).split('\n')[0]}`);
  }
  const policyFailed = q?.policy.outcome === 'failed';
  if (policyFailed) lines.push(`✗ QA policy (strict) — ${q!.policy.reasons.join('; ')}`);
  const ok = stepsOk && !policyFailed;
  if (!ok && s.page && !s.page.isClosed()) {
    try {
      url = redactor.pageUrl(s.page.url());
      if (s.cfg?.artifacts.screenshots !== false) {
        const buf = await s.page.screenshot({ type: 'jpeg', quality: 60, mask: s.maskLocators() });
        screenshot = buf.toString('base64');
        shotFile = path.join(FLOW_DIR(), 'artifacts', `${safe(name)}-${s.obs.runId}.jpg`);
        await fs.mkdir(path.dirname(shotFile), { recursive: true });
        await fs.writeFile(shotFile, buf);
        await pruneScreenshots(s.cfg.artifacts.maxScreenshots).catch(() => {});
      }
    } catch { /* page gone */ }
  }
  const ev = s.takeEvidence();
  const evidence = [...ev.pageErrors.map((x) => 'pageerror: ' + x), ...ev.console.filter((x) => x.startsWith('[error]')), ...ev.failedRequests];
  const obs: Observer | undefined = s.obs;
  const findings = obs ? [...obs.quality.findings] : [];
  const run: FlowRun = {
    name, flow: flow.name, ok, stepsOk, ms: Date.now() - t0, lines, failedAt, evidence, screenshot, shotFile, url, started,
    sessionId: obs?.sessionId, runId: obs?.runId, quality: q?.block, policy: q?.policy, qualityText: q?.text,
    findings, findingLines: [],
  };
  if (obs) {
    const { findingLine } = await import('./quality/summary.js');
    run.findingLines = findings.filter((f) => f.status === 'candidate').map((f) => findingLine(obs, f));
    recentRuns.push(obs); if (recentRuns.length > 5) recentRuns.shift();
    if (opts.bundle || s.cfg?.artifacts.enabled) {
      try {
        const dir = await exportBundle(obs, { final: true, flow: safe(name), execution: { status: stepsOk ? 'passed' : 'failed', steps: flow.steps.length, failedAt }, policy: q ? { outcome: q.policy.outcome, reasons: q.policy.reasons } : undefined, screenshot: shotFile ? rel(shotFile) : undefined });
        run.bundle = rel(dir);
      } catch (e) { console.error(`fastqa: could not write the session bundle: ${String(e).split('\n')[0]}`); }
    }
    try { await opts.onDone?.(obs, run); } catch (e) { console.error(`fastqa: could not write session artifacts: ${String(e).split('\n')[0]}`); }
  }
  if (shared?.browser) await s.closeContext(); else await s.close();
  return run;
}

// ---------------------------------------------------------------------------------------------------- export

/** What an exported spec enforces compared with fastqa replay. Machine-readable, also written into the spec header. */
export interface ExportParity {
  /** steps exported as executable Playwright code */
  executable: number;
  /** steps that could not be exported faithfully; fastqa replay still enforces them */
  unsupported: Array<{ step: number; do: string; reason: string }>;
  /** behaviour of fastqa replay that an exported spec does not have */
  notExported: string[];
}

const HELPER_STEPS = new Set(['expect_request', 'expect_no_errors', 'expect_accessible', 'cookies', 'upload']);
const q = JSON.stringify;

/** Code for one step. QA assertions are regenerated from the step itself, so flows saved by 0.3 (comment-only code) export correctly too. */
function stepCode(s: RecordedStep): string | undefined {
  const t = s.timeout !== undefined ? `, ${Number(s.timeout)}` : '';
  switch (s.do) {
    case 'expect_request': return `await fq.expectRequest(${q((s.target ?? '').trim())}, ${q((s.value || '<400').trim())}${t});`;
    case 'expect_no_errors': return `await fq.expectNoErrors(${q(/strict/i.test(s.value || '') ? 'strict' : '')}${s.target ? ', ' + q(s.target) : ''});`;
    case 'expect_accessible': return `await fq.expectAccessible(${q((s.value || 'serious').toLowerCase())});`;
    case 'cookies': return `await fq.cookies(${q(s.value === 'reject' ? 'reject' : 'accept')}${t});`;
    default: return s.code;
  }
}

/**
 * The cookies step for exported specs: the detection is the source of findConsentButton, verbatim, so a spec finds the
 * same button as fastqa replay. Only added to specs of flows that use the step.
 */
const cookiesHelper = () => `    /** cookie banner: click its accept / reject button when one shows up; a page without a banner passes */
    async cookies(choice: 'accept' | 'reject', timeout = ${COOKIE_WAIT_MS}) {
      const find: any = ${findConsentButton.toString()};
      const end = Date.now() + timeout;
      for (;;) {
        for (const f of page.frames()) {
          if (f.isDetached()) continue;
          try {
            const el = (await (await f.evaluateHandle(find, choice)).getProperty('el')).asElement();
            if (!el) continue;
            await el.click({ timeout: 2000 }).catch(() => el.evaluate((e: any) => e.click()));
            await el.waitForElementState('hidden', { timeout: 1500 }).catch(() => {});
            return;
          } catch { /* the frame navigated away */ }
        }
        if (Date.now() >= end) return;
        await page.waitForTimeout(200);
      }
    },
`;

/**
 * The upload step for exported specs: the files come from uploadFiles, verbatim, so a spec uploads the same bytes as
 * fastqa replay. Made files are written to the test's output folder; files/<name> is read from the fastqa files folder
 * next to the tests folder. Only added to specs of flows that use the step.
 */
const uploadHelper = () => `    /** file upload: a file input gets the files; any other element is clicked and the file picker gets them */
    async upload(target: import('@playwright/test').Locator, value: string) {
      const make: any = ${uploadFiles.toString()};
      const fs = await import('node:fs'); const path = await import('node:path');
      const dir = test.info().outputPath(\`fastqa-upload-\${Date.now()}\`);
      const paths: string[] = make(value, ${UPLOAD_MAX_BYTES}).map((f: any, i: number) => {
        if (f.folder) return path.join(path.dirname(test.info().file), '..', 'files', ...f.folder.split('/'));
        fs.mkdirSync(path.join(dir, String(i)), { recursive: true });
        fs.writeFileSync(path.join(dir, String(i), f.name), f.buffer);
        return path.join(dir, String(i), f.name);
      });
      // Chromium on Windows cannot open a path of 260 characters or more: send such files as bytes
      const files: any = process.platform === 'win32' && paths.some((p) => p.length >= 260)
        ? paths.map((p) => ({ name: path.basename(p), mimeType: '', buffer: fs.readFileSync(p) }))
        : paths;
      const input = await target.evaluate((el: any) => (el.tagName === 'INPUT' && el.type === 'file') || el.control?.type === 'file').catch(() => false);
      if (input) {
        await expect.poll(() => target.evaluate((el: any) => !!(el.control ?? el).disabled), { message: 'the file input is disabled' }).toBe(false);
        return target.setInputFiles(files);
      }
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), target.click()]);
      await chooser.setFiles(files);
    },
`;

const HELPER = `
// ---- fastqa helpers: the same checks fastqa replay runs, over everything since the test started -----------------
function fastqa(page: import('@playwright/test').Page) {
  type Ev = { kind: 'http' | 'console' | 'pageerror'; text: string; method?: string; url?: string; status?: number };
  const log: Ev[] = [];
  const ctx = page.context();
  const open = new Set<unknown>();
  ctx.on('request', (r) => { if (!r.serviceWorker()) open.add(r); });
  ctx.on('requestfinished', (r) => { open.delete(r); });
  ctx.on('response', (res) => {
    const r = res.request();
    open.delete(r);
    if (r.serviceWorker()) return;
    if (['fetch', 'xhr', 'document'].includes(r.resourceType())) log.push({ kind: 'http', method: r.method(), url: r.url(), status: res.status(), text: \`\${res.status()} \${r.method()} \${r.url()}\` });
  });
  ctx.on('requestfailed', (r) => {
    open.delete(r);
    if (!r.serviceWorker() && !/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) log.push({ kind: 'http', method: r.method(), url: r.url(), status: 0, text: \`FAILED \${r.method()} \${r.url()}\` });
  });
  ctx.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && !/favicon/.test(m.location()?.url || '')) log.push({ kind: 'console', text: m.text() });
  });
  ctx.on('weberror', (w) => { log.push({ kind: 'pageerror', text: String(w.error()?.message || w.error()) }); });
  const matches = (actual: string, expected: string) => {
    const m = /^\\/(.+)\\/([dgimsuy]*)$/.exec(expected);
    if (m) { try { return new RegExp(m[1], m[2]).test(actual); } catch { /* not a regex: substring */ } }
    return actual.includes(expected);
  };
  return {
    /** spec: "POST /api/orders" | "/api/orders" | "/regex/"; want: "200" | "2xx" | "<400" */
    async expectRequest(spec: string, want = '<400', timeout = 5000) {
      const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(.+)$/i.exec(spec);
      const method = m?.[1].toUpperCase(); const urlPart = m ? m[2] : spec;
      const okStatus = (st: number) => /^\\dxx$/i.test(want) ? Math.floor(st / 100) === Number(want[0]) : /^<\\d+$/.test(want) ? st > 0 && st < Number(want.slice(1)) : st === Number(want);
      const hits = () => log.filter((e) => e.kind === 'http' && (!method || e.method === method) && matches(e.url!, urlPart));
      await expect.poll(() => hits().some((h) => okStatus(h.status!)), { timeout, message: \`expect_request \${spec} \${want} — seen: \${hits().map((h) => h.text).slice(-3).join(' ; ') || 'no matching request'}\` }).toBe(true);
    },
    /** JS exceptions, console.error, network failures and HTTP 5xx since the test started; "strict" also counts 4xx */
    async expectNoErrors(mode = '', ignore?: string) {
      // fastqa replay lets the page settle after each action (bounded, 1.5 s) before the next step runs, so a response
      // that arrives a moment after a click is seen. Wait the same way here, or a slow failure would be missed.
      const end = Date.now() + 1500;
      while (open.size > 0 && Date.now() < end) await page.waitForTimeout(25);
      const min = /strict/i.test(mode) ? 400 : 500;
      const bad = log.filter((e) => (e.kind !== 'http' || e.status === 0 || e.status! >= min) && !(ignore && (matches(e.text, ignore) || (!!e.url && matches(e.url, ignore)))));
      expect(bad.map((e) => \`\${e.kind}: \${e.text.slice(0, 120)}\`), 'expect_no_errors').toEqual([]);
    },
    /** axe-core WCAG 2.1 A/AA; level = lowest impact that fails. Needs axe-core installed next to @playwright/test. */
    async expectAccessible(level = 'serious') {
      let source = '';
      try { const axe: any = await import('axe-core'); source = axe.source ?? axe.default?.source; } catch { /* reported below */ }
      if (!source) throw new Error('expect_accessible needs axe-core in this project: npm i -D axe-core');
      const order = ['critical', 'serious', 'moderate', 'minor'];
      const lim = order.indexOf(level) < 0 ? 1 : order.indexOf(level);
      const issues: string[] = [];
      for (const f of page.frames()) {
        if (f.isDetached()) continue;
        try {
          if (!(await f.evaluate(() => typeof (window as any).axe !== 'undefined'))) await f.evaluate(source);
          const res: any[] = await f.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })).violations.map((v: any) => ({ impact: v.impact || 'minor', id: v.id, count: v.nodes.length })));
          for (const v of res) if (order.indexOf(v.impact) <= lim) issues.push(\`[\${v.impact}] \${v.id} ×\${v.count}\`);
        } catch { /* frame navigated away or blocks script injection */ }
      }
      expect(issues, \`expect_accessible \${level}\`).toEqual([]);
    },
  };
}
`;

/**
 * Exports a flow as a Playwright Test spec. Network, error and accessibility assertions are executable (not comments).
 * A step that cannot be exported faithfully is listed in `parity.unsupported`; with strict=true the export is refused instead.
 */
export async function exportFlow(name: string, strict = false): Promise<{ file: string; code: string; parity: ExportParity }> {
  const flow = await loadFlow(name);
  const parity: ExportParity = { executable: 0, unsupported: [], notExported: [
    'automatic QA findings and strict policy (fastqa replay only)',
    'the bounded settle after each action (replay waits up to 1.5 s for pending requests after every click; the spec does so only inside expectNoErrors)',
  ] };
  const lines = flow.steps.map((s, i) => {
    const code = stepCode(s);
    if (!code || /^\/\//.test(code)) {
      const reason = /fastqa:unsupported/.test(code ?? '') ? 'semantic target cannot be exported faithfully' : code ? 'recorded without executable code' : 'no code recorded';
      parity.unsupported.push({ step: i + 1, do: s.do, reason });
      return `  // fastqa:unsupported step ${i + 1}: ${s.do} ${q(s.target ?? '')}${s.value !== undefined ? ' ' + q(s.value) : ''} — ${reason}; enforced by fastqa replay only`;
    }
    parity.executable++;
    return '  ' + code;
  });
  if (strict && parity.unsupported.length) {
    throw new Error(`Export refused (strict): ${parity.unsupported.length} step(s) cannot be exported faithfully — ` + parity.unsupported.map((u) => `step ${u.step} ${u.do} (${u.reason})`).join('; '));
  }
  const needsHelper = flow.steps.some((s) => HELPER_STEPS.has(s.do));
  // the cookies and upload methods go in as the last members of the helper object, only when the flow uses them
  const extra = (flow.steps.some((s) => s.do === 'cookies') ? cookiesHelper() : '') + (flow.steps.some((s) => s.do === 'upload') ? uploadHelper() : '');
  const helper = extra ? HELPER.replace(/\n  \};\n\}\n$/, () => `\n${extra}  };\n}\n`) : HELPER;
  const code = redactor.knownOnly(`import { test, expect } from '@playwright/test';

// Generated by fastqa-mcp from flow ${JSON.stringify(String(flow.name).replace(/[\r\n\u2028\u2029]+/g, ' '))} (${String(flow.created).replace(/[^\w:.+-]/g, '')})
// Templated values read FASTQA_VAR_<name> environment variables.
// fastqa:parity ${JSON.stringify(parity)}
${needsHelper ? helper : ''}
test(${JSON.stringify(flow.name)}, async ({ page }) => {
${needsHelper ? '  const fq = fastqa(page);\n' : ''}${lines.join('\n')}
});
`);
  const file = path.join(FLOW_DIR(), 'tests', `${safe(name)}.spec.ts`);
  await writeAtomic(file, code);
  await writeAtomic(file.replace(/\.spec\.ts$/, '.parity.json'), JSON.stringify({ flow: flow.name, spec: rel(file), ...parity }, null, 2) + '\n');
  return { file, code, parity };
}

/** Reads a CSV data file (header row = variable names). Looks in .fastqa/data/<name>.csv when given a bare name. */
export async function loadDataset(nameOrPath: string): Promise<Record<string, string>[]> {
  const p = /[\\/]|\.csv$/i.test(nameOrPath) ? path.resolve(nameOrPath) : path.join(FLOW_DIR(), 'data', `${safe(nameOrPath)}.csv`);
  const rows = (await fs.readFile(p, 'utf8')).split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

/** Runs flows, optionally once per dataset row, then writes an HTML report and a JUnit XML file. */
export async function runSuite(names: string[], vars: Record<string, string>, dataset?: string, shared?: Session, opts: RunOptions = {}) {
  const rows = dataset ? await loadDataset(dataset) : [{}];
  const runs: FlowRun[] = [];
  for (const n of names) {
    for (let i = 0; i < rows.length; i++) {
      const r = await runFlow(n, { ...vars, ...rows[i] }, shared, opts);
      if (dataset) r.name = `${n} [row ${i + 1}: ${Object.entries(rows[i]).filter(([k]) => !redactor.isSecretKey(k) && !/key|cc/i.test(k)).map(([, v]) => v).join(', ').slice(0, 40)}]`;
      runs.push(r);
    }
  }
  const { writeReports } = await import('./report.js');
  const { loadConfig } = await import('./config.js');
  const files = await writeReports(runs, FLOW_DIR(), loadConfig(FLOW_DIR(), opts.mode).artifacts.maxReports);
  return { runs, ...files };
}
