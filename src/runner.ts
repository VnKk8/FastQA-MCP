import { auditA11y } from './a11y.js';
import { Session, DEFAULT_TIMEOUT, sleep, AmbiguousTargetError, warnLegacyTls, type Step, type RecordedStep, type Identity } from './session.js';
import { redactor } from './privacy/redact.js';
import { dismissCookies, describeOutcome, COOKIE_CHOICES, COOKIE_WAIT_MS, COOKIE_RECHECK_MS, type CookieChoice } from './cookies.js';
import { prepareUpload, accepts, sendAsBytes, asBytes } from './upload.js';
import { judgeBackend, judgeUi, permissionText, operationOf, type PermissionCheck } from './permissions.js';
import type { FileChooser, Locator } from 'playwright';

/** How long an upload step waits for the file picker once its click on an element that is not a file input has landed. */
const CHOOSER_WAIT_MS = 2000;

export const STEP_KINDS = [
  'goto', 'click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'wait', 'cookies', 'upload', 'dialog',
  'expect_text', 'expect_no_text', 'expect_url', 'expect_title', 'expect_value',
  'expect_visible', 'expect_hidden', 'expect_enabled', 'expect_disabled', 'expect_count',
  'expect_request', 'expect_no_errors', 'expect_accessible', 'expect_permission',
] as const;

export interface StepResult {
  ok: boolean;
  ms: number;
  line: string;
  recorded?: RecordedStep;
  /** facts for the agent about this step (act results only): what a field holds, why a step failed */
  facts?: string[];
}

const q = JSON.stringify;
/** Steps that search their target (or, for expect_text, the text) inside a `within` container. */
const WITHIN_STEPS = /^(click|dblclick|hover|check|uncheck|fill|type|select|press|wait|expect_text|expect_no_text|expect_value|expect_visible|expect_hidden|expect_enabled|expect_disabled)$/;

async function poll(check: () => Promise<boolean>, timeout: number, interval = 50): Promise<boolean> {
  const end = Date.now() + timeout;
  do {
    try { if (await check()) return true; } catch (e) { if (e instanceof AmbiguousTargetError) throw e; /* otherwise retry */ }
    await sleep(interval);
  } while (Date.now() < end);
  return false;
}

function matches(actual: string, expected: string): boolean {
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(expected); // "/api/login" is a path, "/api.*login/i" is a regex
  if (m) { try { return new RegExp(m[1], m[2]).test(actual); } catch { /* not a valid regex: substring */ } }
  return actual.includes(expected);
}

function need(s: Step, field: 'target' | 'value') {
  if (s[field] === undefined || s[field] === '') throw new Error(`"${s.do}" needs "${field}"`);
  return s[field]!;
}

/** How a step is shown to the model and in reports. Built from the template, so values bound from env never echo back. */
export function labelOf(L: Step): string {
  return `${L.do}${L.target ? ' ' + q(L.target) : ''}${L.within ? ` within ${q(L.within)}` : ''}${L.value !== undefined && L.do !== 'fill' && L.do !== 'type' ? ' ' + q(L.value) : L.value !== undefined ? ' ' + q(maskish(L)) : ''}`;
}

export async function runStep(session: Session, s: Step, tmpl?: Step): Promise<StepResult> {
  // V(): how a value appears in exported code. Templated values ({{x}}) become env lookups, never literals.
  const V = (bound: string) => (tmpl?.value && /\{\{\w+\}\}/.test(tmpl.value) ? envLiteral(tmpl.value) : q(bound));
  const page = session.page!;
  const t0 = Date.now();
  const timeout = s.timeout ?? DEFAULT_TIMEOUT;
  const label = labelOf(tmpl ?? s);
  let recorded: RecordedStep | undefined = { ...s };
  let note = '';
  const facts: string[] = [];
  let target: Locator | undefined; // the element the step acted on, to explain a failure
  // the container limit and the recorded identity go with every target lookup, and back into the recording
  const opt = { within: s.within, identity: s.id };
  const keep = (r: { within?: string; identity?: Identity; [k: string]: unknown }) => ({ within: r.within ?? s.within, id: r.identity ?? s.id });
  try {
    // `within` is a hard limit: a step that cannot honour it refuses it instead of ignoring it
    if (s.within && (!WITHIN_STEPS.test(s.do) || (/^(press|wait)$/.test(s.do) && !s.target))) throw new Error(`"within" is not supported by "${s.do}"${s.target ? '' : ' without a target'}`);
    switch (s.do) {
      case 'goto': {
        const url = need(s, 'value');
        const allowed = session.cfg?.browser.allowedOrigins ?? [];
        if (allowed.length) {
          let o = ''; try { o = new URL(url).origin; } catch { /* reported by goto */ }
          if (o && !allowed.includes(o)) throw new Error(`origin ${o} is not in browser.allowedOrigins (${allowed.join(', ')})`);
        }
        if (session.cfg?.browser.legacyTls && /^https:/i.test(url)) warnLegacyTls();
        session.obs?.noteFirstParty(url); // what the agent explicitly opens is first party
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 15000) }); }
        catch (e: any) {
          if (/ERR_CERT|SSL/i.test(String(e?.message))) throw new Error(`${String(e.message).split('\n')[0]} — to accept invalid certificates set browser.ignoreHTTPSErrors: true in .fastqa/config.json`);
          throw e;
        }
        session.obs?.noteFirstParty(page.url()); // and where that navigation ended up (e.g. http -> https)
        recorded.code = `await page.goto(${q(url)});`;
        break;
      }
      case 'click': case 'dblclick': case 'hover': case 'check': case 'uncheck': {
        const r = await session.resolve(need(s, 'target'), 'click', timeout, s.frame, opt);
        target = r.loc;
        if (s.do === 'click') await r.loc.click({ timeout });
        if (s.do === 'dblclick') await r.loc.dblclick({ timeout });
        if (s.do === 'hover') await r.loc.hover({ timeout });
        if (s.do === 'check') await r.loc.check({ timeout });
        if (s.do === 'uncheck') await r.loc.uncheck({ timeout });
        recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await ${r.code}.${s.do}();` };
        break;
      }
      case 'fill': case 'type': case 'select': {
        const value = s.value ?? '';
        const r = await session.resolve(need(s, 'target'), 'fill', timeout, s.frame, opt);
        // A placeholder value typed into a password-like field is a secret: hide it wherever it shows up later.
        const used = boundVars.get(s);
        if (used?.length && s.do !== 'select' && (/pass|pwd|secret|token/i.test(s.target || '') || await r.loc.evaluate((el) => (el as HTMLInputElement).type === 'password').catch(() => false))) {
          for (const [k, v] of used) redactor.addSecret(v, k);
        }
        if (s.do === 'fill') {
          try { await r.loc.fill(value, { timeout }); }
          catch (e: any) {
            if (!/Input of type "file" cannot be filled/.test(String(e?.message))) throw e;
            throw new Error(`${q(s.target)} is a file input: use the upload step, e.g. {"do":"upload","target":${q(s.target)},"value":"photo.png"}`);
          }
          // a field that keeps something else than was typed (maxlength, an input mask, a number field) is a fact
          // the agent would otherwise only find by reading the value back. Never for passwords or secret values.
          if (!used?.length && !/pass|pwd|secret|token/i.test(s.target || '')) {
            const held = await r.loc.evaluate((el: any) => (el.type === 'password' || el.value === undefined ? null : { v: String(el.value), ml: el.maxLength })).catch(() => null);
            if (held && held.v !== value) {
              const cut = held.ml > 0 && value.length > held.ml && held.v === value.slice(0, held.ml);
              facts.push(`field holds ${q(held.v.length > 60 ? held.v.slice(0, 59) + '…' : held.v)}${cut ? ` (maxlength ${held.ml})` : ''}`);
            }
          }
        }
        if (s.do === 'type') { await r.loc.click({ timeout }); await r.loc.pressSequentially(value, { delay: 10 }); }
        if (s.do === 'select') {
          try { await r.loc.selectOption({ label: value }, { timeout: Math.min(timeout, 1500) }); }
          catch { await r.loc.selectOption(value, { timeout }); }
        }
        const method = s.do === 'select' ? 'selectOption' : s.do === 'type' ? 'pressSequentially' : 'fill';
        recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await ${r.code}.${method}(${V(value)});` };
        break;
      }
      case 'press': {
        const key = need(s, 'value');
        if (s.target) {
          const r = await session.resolve(s.target, 'fill', timeout, s.frame, opt);
          await r.loc.press(key, { timeout });
          recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await ${r.code}.press(${q(key)});` };
        } else {
          await page.keyboard.press(key);
          recorded.code = `await page.keyboard.press(${q(key)});`;
        }
        break;
      }
      case 'dialog': {
        // FQA-07: arm the handling of the next native dialog (alert / confirm / prompt) before the step that opens it.
        // value: "accept", "dismiss" or "accept:<prompt text>"; target: optional text the message must contain. Unarmed
        // dialogs are still dismissed and reported, so a destructive confirm is never accepted implicitly.
        const v = (s.value || '').trim();
        const m = /^(accept|dismiss)(?::([\s\S]*))?$/i.exec(v);
        if (!m) throw new Error(`"dialog" needs value "accept", "dismiss" or "accept:<prompt text>", got ${q(s.value)}`);
        const action = m[1].toLowerCase() as 'accept' | 'dismiss';
        const promptText = action === 'accept' ? m[2] : undefined;
        session.armDialog({ action, promptText, expect: s.target?.trim() || undefined });
        note = `the next dialog will be ${action === 'accept' ? 'accepted' : 'dismissed'}${s.target ? ` if its message contains ${q(s.target)}` : ''}`;
        recorded.code = `page.once('dialog', async (d) => { ${s.target ? `expect(d.message()).toContain(${q(s.target)}); ` : ''}await d.${action}(${promptText !== undefined ? q(promptText) : ''}); });`;
        break;
      }
      case 'wait': {
        if (s.target) {
          const r = await session.resolve(s.target, 'any', timeout, s.frame, opt);
          await r.loc.waitFor({ state: 'visible', timeout });
          recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await ${r.code}.waitFor();` };
        } else {
          const ms = Math.min(Number(s.value || 500), 10000);
          await sleep(ms);
          recorded.code = `await page.waitForTimeout(${ms});`;
        }
        break;
      }
      case 'cookies': {
        // Cookie banner: click its accept / reject button. A page without a banner passes: the line says what happened.
        const choice = need(s, 'value').toLowerCase() as CookieChoice;
        if (!COOKIE_CHOICES.includes(choice)) throw new Error(`"cookies" needs value "accept" or "reject", got ${q(s.value)}`);
        let origin = ''; try { origin = new URL(page.url()).origin; } catch { /* about:blank */ }
        // A site gets the full wait for its banner once per browser context. Later pages of it get a short one: the answer is
        // usually remembered, but a page can still show its banner a moment after loading.
        const out = await dismissCookies(page, choice, s.timeout ?? (session.consentAsked.has(origin) ? COOKIE_RECHECK_MS : COOKIE_WAIT_MS), () => session.quietFor());
        session.consentAsked.add(origin);
        note = describeOutcome(out, choice);
        recorded = { do: 'cookies', value: choice, code: `await fq.cookies(${q(choice)});` };
        break;
      }
      case 'upload': {
        // The files are ready (or the value refused) before any waiting for the target.
        const files = await prepareUpload(s.value ?? '', () => session.uploadDir());
        const paths = files.map((f) => f.path);
        // paths when the browser can open them (fast, no size limit); otherwise the bytes themselves
        const payload = sendAsBytes(paths, { platform: process.platform, cdpUrl: process.env.FASTQA_CDP_URL }) ? await asBytes(files) : paths;
        const r = await session.resolveUpload(s.target, timeout, s.frame);
        let accept = '';
        if (r.input) {
          // setInputFiles ignores `disabled`; a person cannot choose a file there, so neither can the step
          const disabled = () => r.loc.evaluate((el: any) => !!(el.control ?? el).disabled);
          if (!(await poll(async () => !(await disabled()), timeout))) throw new Error('the file input is disabled');
          accept = await r.loc.evaluate((el: any) => (el.control ?? el).accept || '').catch(() => '');
          await r.loc.setInputFiles(payload, { timeout });
        } else {
          // a styled button or drop zone: its click opens the file picker, which gets the files. The wait for the picker
          // starts when the click has landed, so a button that takes a while to become clickable is not misjudged.
          let fc: FileChooser | undefined; let wake = () => {};
          const onChooser = (c: FileChooser) => { fc = c; wake(); };
          page.on('filechooser', onChooser);
          session.uploading = true; // this picker is the step's own, not news for the facts
          try {
            await r.loc.click({ timeout });
            if (!fc) await new Promise<void>((res) => { wake = res; setTimeout(res, CHOOSER_WAIT_MS); });
          } finally { page.off('filechooser', onChooser); session.uploading = false; }
          const chooser = fc as FileChooser | undefined;
          if (!chooser) throw new Error(`clicking ${q(s.target)} opened no file picker. Target the file input itself: the snapshot lists it as "file", hidden ones too`);
          accept = await chooser.element().evaluate((el: any) => el.accept || '').catch(() => '');
          await chooser.setFiles(payload, { timeout });
        }
        note = files.length ? files.map((f) => `${f.name} (${f.detail}${accepts(accept, f.name) ? '' : `; not in accept=${q(accept)}`})`).join(', ') : 'selection cleared';
        recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await fq.upload(${r.code}, ${V(s.value ?? '')});` };
        break;
      }
      case 'expect_text': case 'expect_no_text': {
        const text = need(s, 'value');
        const want = s.do === 'expect_text';
        let hitChain: string[] | undefined;
        let sample = '';
        let noBox = false;
        const ok = await poll(async () => {
          if (s.target) {
            const r = await session.resolve(s.target, 'any', 500, s.frame, opt);
            sample = await r.loc.innerText({ timeout: 500 });
            hitChain = r.frame;
            return matches(sample, text) === want;
          }
          // within a container: only its text counts (another row saying the same is not this row); a container that is
          // not there proves nothing either way
          if (s.within) {
            const pool = await session.withinTexts(s.within, s.frame);
            noBox = !pool.length;
            if (noBox) return false;
            sample = pool.map((x) => x.text).join(' | ');
            const hit = pool.find((x) => matches(x.text, text));
            hitChain = hit?.chain.length ? hit.chain : undefined;
            return !!hit === want;
          }
          // whole page: main document + open shadow roots + every visible iframe
          const texts = await session.deepTexts();
          const frameFilter = s.frame ? new Set((await session.scopesFor(s.frame)).map((c) => c.join(' >> '))) : null;
          const pool = frameFilter ? texts.filter((x) => frameFilter.has(x.chain.join(' >> '))) : texts;
          sample = pool.map((x) => x.text).join(' | ');
          const hit = pool.find((x) => matches(x.text, text));
          hitChain = hit?.chain.length ? hit.chain : undefined;
          return !!hit === want;
        }, timeout);
        if (!ok && noBox) throw new Error(`no container shows ${q(s.within)}, so ${q(text)} could not be checked within it`);
        if (!ok) throw new Error(want ? `text ${q(text)} not found${s.within ? ` within ${q(s.within)}` : ''}. Visible text starts: ${q(sample.slice(0, 300))}` : `text ${q(text)} is still present${s.within ? ` within ${q(s.within)}` : ''}`);
        const sc = Session.codePrefix(hitChain);
        const tx = regexOrString(text);
        recorded = { ...s, frame: hitChain ?? (Array.isArray(s.frame) ? s.frame : undefined) };
        recorded.code = s.within && !s.target
          ? `// fastqa:unsupported ${s.do} ${q(text)} within ${q(s.within)} (container text check; enforced by fastqa replay only)`
          : want
            ? `await expect(${sc}.getByText(${tx}).first()).toBeVisible();`
            : `await expect(${sc}.getByText(${tx})).toHaveCount(0);`;
        break;
      }
      case 'expect_url': {
        const v = need(s, 'value');
        if (!(await poll(async () => matches(page.url(), v), timeout))) throw new Error(`url is ${q(page.url())}, expected ${q(v)}`);
        recorded.code = `await expect(page).toHaveURL(${isRe(v) ? v : 'new RegExp(' + q(escapeRe(v)) + ')'});`;
        break;
      }
      case 'expect_title': {
        const v = need(s, 'value');
        if (!(await poll(async () => matches(await page.title(), v), timeout))) throw new Error(`title is ${q(await page.title())}`);
        recorded.code = `await expect(page).toHaveTitle(${isRe(v) ? v : 'new RegExp(' + q(escapeRe(v)) + ')'});`;
        break;
      }
      case 'expect_value': {
        const v = s.value ?? '';
        const r = await session.resolve(need(s, 'target'), 'fill', timeout, s.frame, opt);
        let actual = '';
        const ok = await poll(async () => { actual = await r.loc.inputValue({ timeout: 300 }); return matches(actual, v) || (v === '' && actual === ''); }, timeout);
        if (!ok) throw new Error(`value is ${q(actual)}, expected ${q(v)}`);
        recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await expect(${r.code}).toHaveValue(${regexOrString(v)});` };
        break;
      }
      case 'expect_visible': case 'expect_enabled': case 'expect_disabled': {
        const r = await session.resolve(need(s, 'target'), 'any', timeout, s.frame, opt);
        if (s.do === 'expect_enabled' && !(await poll(() => r.loc.isEnabled(), timeout))) throw new Error('element is disabled');
        if (s.do === 'expect_disabled' && !(await poll(() => r.loc.isDisabled(), timeout))) throw new Error('element is enabled');
        const m = s.do === 'expect_visible' ? 'toBeVisible' : s.do === 'expect_enabled' ? 'toBeEnabled' : 'toBeDisabled';
        recorded = { ...s, target: r.record, frame: r.frame, ...keep(r), code: `await expect(${r.code}).${m}();` };
        break;
      }
      case 'expect_hidden': {
        const target = need(s, 'target');
        const ok = await poll(async () => {
          try { const r = await session.resolve(target, 'any', 1, s.frame, opt); return !(await r.loc.isVisible()); }
          catch { return true; }
        }, timeout);
        if (!ok) throw new Error('element is still visible');
        // Only a raw selector can be exported faithfully: a semantic target is resolved by several strategies at run time.
        recorded.code = /^(css=|#|\[|\.|testid=)/.test(target) && !s.frame && !s.within
          ? (/^testid=/.test(target) ? `await expect(page.getByTestId(${q(target.slice(7))})).toBeHidden();` : `await expect(page.locator(${q(target.replace(/^css=/, ''))})).toBeHidden();`)
          : `// fastqa:unsupported expect_hidden ${q(target)} (semantic target; enforced by fastqa replay only)`;
        break;
      }
      case 'expect_count': {
        const sel = need(s, 'target');
        const n = Number(need(s, 'value'));
        const loc = page.locator(sel.replace(/^css=/, ''));
        let c = -1;
        if (!(await poll(async () => (c = await loc.count()) === n, timeout))) throw new Error(`count is ${c}, expected ${n}`);
        recorded.code = `await expect(page.locator(${q(sel.replace(/^css=/, ''))})).toHaveCount(${n});`;
        break;
      }
      case 'expect_request': {
        // target: "POST /api/orders" | "/api/orders" | "/regex/"; value: "200" | "2xx" | "<400" (default: < 400)
        const spec = need(s, 'target').trim();
        const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(spec);
        const method = m?.[1].toUpperCase();
        const urlPart = m ? m[2] : spec;
        const want = (s.value || '<400').trim();
        const okStatus = (st: number) =>
          /^\dxx$/i.test(want) ? Math.floor(st / 100) === Number(want[0]) :
          /^<\d+$/.test(want) ? st > 0 && st < Number(want.slice(1)) :
          st === Number(want);
        let seen: string[] = [];
        // FQA-06: by default only the requests of the latest action count, and the latest of them decides, so a success
        // of an earlier action can never pass an assertion about a later one. Requests attributed to that action come
        // first; a request the correlation could not attribute (third party, ambiguous) counts only when it started
        // after the action did. scope "batch" keeps the 1.0.3 meaning: any matching request since the batch started.
        const batchScope = s.scope === 'batch' || !session.lastAction;
        const la = session.lastAction;
        const mine = () => new Set((la && session.obs ? session.obs.requestsOf(la.id) : []).map((r) => r.id));
        const ok = await poll(async () => {
          const all = session.since(session.mark).filter((e) => e.kind === 'http' && (!method || e.method === method) && matches(e.url!, urlPart));
          let hits = all;
          if (!batchScope) {
            const ids = mine();
            const attributed = all.filter((h) => h.rid && ids.has(h.rid));
            hits = attributed.length ? attributed : all.filter((h) => !h.rid && h.t >= la!.t);
          }
          seen = (hits.length ? hits : all).map((h) => h.text);
          const ok = batchScope ? hits.filter((h) => okStatus(h.status!)) : hits.slice(-1).filter((h) => okStatus(h.status!));
          // An assertion that passes on 4xx/5xx responses declares them expected (a negative test): every response of this
          // batch that satisfies it, so two negative submits followed by two assertions are both covered.
          for (const h of ok) if (h.status! >= 400 && h.rid) session.obs?.quality.markExpected(h.rid, `explicit expect_request ${spec} ${want}`);
          return ok.length > 0;
        }, timeout);
        if (!ok) throw new Error(seen.length ? `request seen but status not ${want}: ${seen.slice(-3).join(' ; ')}${batchScope ? '' : ' (judged: the latest matching request of the latest action)'}` : `no ${method ?? ''} request matching ${q(urlPart)} ${batchScope ? 'since this run started' : 'from the latest action'}`);
        recorded.code = `await fq.expectRequest(${q(spec)}, ${q(want)});`;
        break;
      }
      case 'expect_permission': {
        // target: an operation ("POST /api/projects", "/api/x") judged by the backend's answer, or a control ("Delete",
        // a ref) judged by the UI alone. value: allowed | denied. The operation is never sent by this step: the caller
        // performs it (as this role) earlier in the batch, and a denied operation is never retried.
        const op = need(s, 'target').trim();
        const expected = (s.value || '').trim().toLowerCase();
        if (expected !== 'allowed' && expected !== 'denied') throw new Error(`"expect_permission" needs value "allowed" or "denied", got ${q(s.value)}`);
        // an operation is a method (any case) and a path ("delete /api/users/7"), or a path; anything else is a control
        // ("Delete user" is a button, not a DELETE request)
        const operation = operationOf(op);
        let r: ReturnType<typeof judgeBackend>;
        if (operation) {
          const method = operation.method; const urlPart = operation.path;
          let hits: ReturnType<typeof session.since> = [];
          await poll(async () => {
            hits = session.since(session.mark).filter((e) => e.kind === 'http' && (!method || e.method === method) && matches(e.url!, urlPart));
            return hits.length > 0;
          }, timeout);
          const rec = (id?: string) => (id ? session.obs?.requests.get(id) : undefined);
          r = judgeBackend(expected, hits.map((h) => ({ status: h.status!, redirected: !!rec(h.rid)?.redirectedFrom })), session.cfg?.permissions?.deniedStatuses ?? [403]);
          // a denial that was the expectation is not a QA lead of its own (as an asserted negative test)
          if (r.verdict === 'pass' && expected === 'denied') for (const h of hits) if (h.status! >= 400 && h.rid) session.obs?.quality.markExpected(h.rid, `explicit expect_permission ${op} denied`);
        } else {
          let state: 'available' | 'disabled' | 'hidden' = 'hidden';
          try {
            const t = await session.resolve(op, 'any', Math.min(timeout, 1500), s.frame, opt);
            state = (await t.loc.isEnabled().catch(() => true)) ? 'available' : 'disabled';
          } catch (e) { if (e instanceof AmbiguousTargetError) throw e; }
          r = judgeUi(expected, state);
        }
        const check: PermissionCheck = { role: session.role ?? '', operation: op, expected, ...r };
        session.notePermission(check);
        if (check.verdict !== 'pass') throw new Error(permissionText(check));
        note = permissionText(check);
        recorded.code = `// fastqa:unsupported expect_permission ${q(op)} ${q(expected)} (role checks run in fastqa replay only)`;
        break;
      }
      case 'expect_no_errors': {
        // JS exceptions, console.error, network failures and HTTP 5xx since this run started. value "strict" also counts 4xx.
        const strict = /strict/i.test(s.value || '');
        const ignore = s.target ? s.target : undefined;
        const bad = session.since(session.mark).filter((e) =>
          (e.kind !== 'http' || e.status === 0 || e.status! >= (strict ? 400 : 500)) && !(ignore && (matches(e.text, ignore) || (!!e.url && matches(e.url, ignore)))));
        if (bad.length) throw new Error(`${bad.length} error(s): ` + bad.slice(0, 4).map((e) => `${e.kind}: ${e.text.slice(0, 120)}`).join(' ; '));
        recorded.code = `await fq.expectNoErrors(${q(strict ? 'strict' : '')}${ignore ? ', ' + q(ignore) : ''});`;
        break;
      }
      case 'expect_accessible': {
        // value: lowest impact that fails the step: critical | serious (default) | moderate | minor
        const levels = ['critical', 'serious', 'moderate', 'minor'];
        const lim = levels.indexOf((s.value || 'serious').toLowerCase());
        const issues = (await auditA11y(page, () => 'iframe')).filter((i) => levels.indexOf(i.impact) <= (lim < 0 ? 1 : lim));
        if (issues.length) throw new Error(`${issues.length} accessibility rule(s) violated: ` + issues.slice(0, 4).map((i) => `[${i.impact}] ${i.id} ×${i.count}`).join(', ') + ' — call audit for details');
        recorded.code = `await fq.expectAccessible(${q((s.value || 'serious').toLowerCase())});`;
        break;
      }
      default:
        throw new Error(`Unknown step "${s.do}". Valid: ${STEP_KINDS.join(', ')}`);
    }
    if (recorded && tmpl?.value !== undefined) recorded.value = tmpl.value;
    return { ok: true, ms: Date.now() - t0, line: `✓ ${label}${note ? ' — ' + note : ''} (${Date.now() - t0}ms)`, recorded, facts };
  } catch (e: any) {
    const full = String(e?.message || e);
    const msg = full.split('\n')[0].replace(/^locator\.\w+: /, '');
    return { ok: false, ms: Date.now() - t0, line: `✗ ${label} — ${msg}`, facts: [...facts, ...await explain(full, s, target)] };
  }
}

/**
 * Why an action on a found element did not happen, from Playwright's own log of its attempts: an element on top that
 * takes the click, or a control that stayed disabled (with the form fields that keep it so). Read only on failure.
 */
async function explain(full: string, s: Step, target?: Locator): Promise<string[]> {
  const who = q(s.target ?? '');
  const cover = /(<[a-z][^>]{0,200}>)[^\n]*?intercepts pointer events/i.exec(full);
  if (cover) return [`${who} is covered by ${cover[1].replace(/<\/[a-z]+>$/i, '')}`];
  if (target && /element is not enabled/.test(full)) {
    const why = await target.evaluate((el: any) => {
      const form = el.form || el.closest('form');
      const name = (f: any) => (f.labels?.[0]?.textContent || f.getAttribute('aria-label') || f.placeholder || f.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const bad = form ? Array.from(form.querySelectorAll(':invalid')).filter((f: any) => f !== form && f !== el) : [];
      return { empty: bad.filter((f: any) => f.validity?.valueMissing).map(name), invalid: bad.filter((f: any) => !f.validity?.valueMissing).map(name) };
    }, undefined, { timeout: 500 }).catch(() => undefined);
    const parts = [`${who} stayed disabled`];
    if (why?.empty.length) parts.push(`Empty required fields: ${why.empty.slice(0, 5).map((n: string) => q(n)).join(', ')}`);
    if (why?.invalid.length) parts.push(`Invalid fields: ${why.invalid.slice(0, 5).map((n: string) => q(n)).join(', ')}`);
    return [parts.join('. ')];
  }
  return [];
}

function maskish(s: Step) {
  return /pass|pwd|secret|token/i.test(s.target || '') ? '•••' : s.value!;
}
function envLiteral(t: string) {
  return '`' + t.replace(/`/g, '\\`').replace(/\{\{(\w+)\}\}/g, (_, k) => '${process.env.FASTQA_VAR_' + k + ' ?? ""}') + '`';
}
const isRe = (v: string) => { const m = /^\/(.+)\/([dgimsuy]*)$/.exec(v); if (!m) return false; try { new RegExp(m[1], m[2]); return true; } catch { return false; } };
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function regexOrString(v: string) { return isRe(v) ? v : q(v); }

/** placeholder name/value pairs that were substituted into a bound step (never serialized) */
export const boundVars = new WeakMap<Step, Array<[string, string]>>();

/** Replace {{var}} placeholders. Values of secret-looking variables are registered with the redactor. */
export function bind(step: Step, vars: Record<string, string>): Step {
  const used: Array<[string, string]> = [];
  const sub = (x?: string) => x?.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = k in vars ? vars[k] : process.env[`FASTQA_VAR_${k}`];
    if (v === undefined) return `{{${k}}}`;
    used.push([k, v]);
    if (redactor.isSecretVar(k)) redactor.addSecret(v, k);
    return v;
  });
  const bound = { ...step, target: sub(step.target), value: sub(step.value), ...(step.within !== undefined ? { within: sub(step.within) } : {}) };
  if (used.length) boundVars.set(bound, used);
  return bound;
}
