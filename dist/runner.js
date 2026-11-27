import { auditA11y } from './a11y.js';
import { Session, DEFAULT_TIMEOUT, sleep, AmbiguousTargetError, warnLegacyTls } from './session.js';
import { redactor } from './privacy/redact.js';
import { dismissCookies, describeOutcome, COOKIE_CHOICES, COOKIE_WAIT_MS, COOKIE_RECHECK_MS } from './cookies.js';
export const STEP_KINDS = [
    'goto', 'click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'wait', 'cookies',
    'expect_text', 'expect_no_text', 'expect_url', 'expect_title', 'expect_value',
    'expect_visible', 'expect_hidden', 'expect_enabled', 'expect_disabled', 'expect_count',
    'expect_request', 'expect_no_errors', 'expect_accessible',
];
const q = JSON.stringify;
async function poll(check, timeout, interval = 50) {
    const end = Date.now() + timeout;
    do {
        try {
            if (await check())
                return true;
        }
        catch (e) {
            if (e instanceof AmbiguousTargetError)
                throw e; /* otherwise retry */
        }
        await sleep(interval);
    } while (Date.now() < end);
    return false;
}
function matches(actual, expected) {
    const m = /^\/(.+)\/([dgimsuy]*)$/.exec(expected); // "/api/login" is a path, "/api.*login/i" is a regex
    if (m) {
        try {
            return new RegExp(m[1], m[2]).test(actual);
        }
        catch { /* not a valid regex: substring */ }
    }
    return actual.includes(expected);
}
function need(s, field) {
    if (s[field] === undefined || s[field] === '')
        throw new Error(`"${s.do}" needs "${field}"`);
    return s[field];
}
/** How a step is shown to the model and in reports. Built from the template, so values bound from env never echo back. */
export function labelOf(L) {
    return `${L.do}${L.target ? ' ' + q(L.target) : ''}${L.value !== undefined && L.do !== 'fill' && L.do !== 'type' ? ' ' + q(L.value) : L.value !== undefined ? ' ' + q(maskish(L)) : ''}`;
}
export async function runStep(session, s, tmpl) {
    // V(): how a value appears in exported code. Templated values ({{x}}) become env lookups, never literals.
    const V = (bound) => (tmpl?.value && /\{\{\w+\}\}/.test(tmpl.value) ? envLiteral(tmpl.value) : q(bound));
    const page = session.page;
    const t0 = Date.now();
    const timeout = s.timeout ?? DEFAULT_TIMEOUT;
    const label = labelOf(tmpl ?? s);
    let recorded = { ...s };
    let note = '';
    try {
        switch (s.do) {
            case 'goto': {
                const url = need(s, 'value');
                const allowed = session.cfg?.browser.allowedOrigins ?? [];
                if (allowed.length) {
                    let o = '';
                    try {
                        o = new URL(url).origin;
                    }
                    catch { /* reported by goto */ }
                    if (o && !allowed.includes(o))
                        throw new Error(`origin ${o} is not in browser.allowedOrigins (${allowed.join(', ')})`);
                }
                if (session.cfg?.browser.legacyTls && /^https:/i.test(url))
                    warnLegacyTls();
                session.obs?.noteFirstParty(url); // what the agent explicitly opens is first party
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 15000) });
                }
                catch (e) {
                    if (/ERR_CERT|SSL/i.test(String(e?.message)))
                        throw new Error(`${String(e.message).split('\n')[0]} — to accept invalid certificates set browser.ignoreHTTPSErrors: true in .fastqa/config.json`);
                    throw e;
                }
                session.obs?.noteFirstParty(page.url()); // and where that navigation ended up (e.g. http -> https)
                recorded.code = `await page.goto(${q(url)});`;
                break;
            }
            case 'click':
            case 'dblclick':
            case 'hover':
            case 'check':
            case 'uncheck': {
                const r = await session.resolve(need(s, 'target'), 'click', timeout, s.frame);
                if (s.do === 'click')
                    await r.loc.click({ timeout });
                if (s.do === 'dblclick')
                    await r.loc.dblclick({ timeout });
                if (s.do === 'hover')
                    await r.loc.hover({ timeout });
                if (s.do === 'check')
                    await r.loc.check({ timeout });
                if (s.do === 'uncheck')
                    await r.loc.uncheck({ timeout });
                recorded = { ...s, target: r.record, frame: r.frame, code: `await ${r.code}.${s.do}();` };
                break;
            }
            case 'fill':
            case 'type':
            case 'select': {
                const value = s.value ?? '';
                const r = await session.resolve(need(s, 'target'), 'fill', timeout, s.frame);
                // A placeholder value typed into a password-like field is a secret: hide it wherever it shows up later.
                const used = boundVars.get(s);
                if (used?.length && s.do !== 'select' && (/pass|pwd|secret|token/i.test(s.target || '') || await r.loc.evaluate((el) => el.type === 'password').catch(() => false))) {
                    for (const [k, v] of used)
                        redactor.addSecret(v, k);
                }
                if (s.do === 'fill')
                    await r.loc.fill(value, { timeout });
                if (s.do === 'type') {
                    await r.loc.click({ timeout });
                    await r.loc.pressSequentially(value, { delay: 10 });
                }
                if (s.do === 'select') {
                    try {
                        await r.loc.selectOption({ label: value }, { timeout: Math.min(timeout, 1500) });
                    }
                    catch {
                        await r.loc.selectOption(value, { timeout });
                    }
                }
                const method = s.do === 'select' ? 'selectOption' : s.do === 'type' ? 'pressSequentially' : 'fill';
                recorded = { ...s, target: r.record, frame: r.frame, code: `await ${r.code}.${method}(${V(value)});` };
                break;
            }
            case 'press': {
                const key = need(s, 'value');
                if (s.target) {
                    const r = await session.resolve(s.target, 'fill', timeout, s.frame);
                    await r.loc.press(key, { timeout });
                    recorded = { ...s, target: r.record, frame: r.frame, code: `await ${r.code}.press(${q(key)});` };
                }
                else {
                    await page.keyboard.press(key);
                    recorded.code = `await page.keyboard.press(${q(key)});`;
                }
                break;
            }
            case 'wait': {
                if (s.target) {
                    const r = await session.resolve(s.target, 'any', timeout, s.frame);
                    await r.loc.waitFor({ state: 'visible', timeout });
                    recorded = { ...s, target: r.record, frame: r.frame, code: `await ${r.code}.waitFor();` };
                }
                else {
                    const ms = Math.min(Number(s.value || 500), 10000);
                    await sleep(ms);
                    recorded.code = `await page.waitForTimeout(${ms});`;
                }
                break;
            }
            case 'cookies': {
                // Cookie banner: click its accept / reject button. A page without a banner passes: the line says what happened.
                const choice = need(s, 'value').toLowerCase();
                if (!COOKIE_CHOICES.includes(choice))
                    throw new Error(`"cookies" needs value "accept" or "reject", got ${q(s.value)}`);
                let origin = '';
                try {
                    origin = new URL(page.url()).origin;
                }
                catch { /* about:blank */ }
                // A site gets the full wait for its banner once per browser context. Later pages of it get a short one: the answer is
                // usually remembered, but a page can still show its banner a moment after loading.
                const out = await dismissCookies(page, choice, s.timeout ?? (session.consentAsked.has(origin) ? COOKIE_RECHECK_MS : COOKIE_WAIT_MS), () => session.quietFor());
                session.consentAsked.add(origin);
                note = describeOutcome(out, choice);
                recorded = { do: 'cookies', value: choice, code: `await fq.cookies(${q(choice)});` };
                break;
            }
            case 'expect_text':
            case 'expect_no_text': {
                const text = need(s, 'value');
                const want = s.do === 'expect_text';
                let hitChain;
                let sample = '';
                const ok = await poll(async () => {
                    if (s.target) {
                        const r = await session.resolve(s.target, 'any', 500, s.frame);
                        sample = await r.loc.innerText({ timeout: 500 });
                        hitChain = r.frame;
                        return matches(sample, text) === want;
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
                if (!ok)
                    throw new Error(want ? `text ${q(text)} not found. Visible text starts: ${q(sample.slice(0, 300))}` : `text ${q(text)} is still present`);
                const sc = Session.codePrefix(hitChain);
                const tx = regexOrString(text);
                recorded = { ...s, frame: hitChain ?? (Array.isArray(s.frame) ? s.frame : undefined) };
                recorded.code = want
                    ? `await expect(${sc}.getByText(${tx}).first()).toBeVisible();`
                    : `await expect(${sc}.getByText(${tx})).toHaveCount(0);`;
                break;
            }
            case 'expect_url': {
                const v = need(s, 'value');
                if (!(await poll(async () => matches(page.url(), v), timeout)))
                    throw new Error(`url is ${q(page.url())}, expected ${q(v)}`);
                recorded.code = `await expect(page).toHaveURL(${isRe(v) ? v : 'new RegExp(' + q(escapeRe(v)) + ')'});`;
                break;
            }
            case 'expect_title': {
                const v = need(s, 'value');
                if (!(await poll(async () => matches(await page.title(), v), timeout)))
                    throw new Error(`title is ${q(await page.title())}`);
                recorded.code = `await expect(page).toHaveTitle(${isRe(v) ? v : 'new RegExp(' + q(escapeRe(v)) + ')'});`;
                break;
            }
            case 'expect_value': {
                const v = s.value ?? '';
                const r = await session.resolve(need(s, 'target'), 'fill', timeout, s.frame);
                let actual = '';
                const ok = await poll(async () => { actual = await r.loc.inputValue({ timeout: 300 }); return matches(actual, v) || (v === '' && actual === ''); }, timeout);
                if (!ok)
                    throw new Error(`value is ${q(actual)}, expected ${q(v)}`);
                recorded = { ...s, target: r.record, frame: r.frame, code: `await expect(${r.code}).toHaveValue(${regexOrString(v)});` };
                break;
            }
            case 'expect_visible':
            case 'expect_enabled':
            case 'expect_disabled': {
                const r = await session.resolve(need(s, 'target'), 'any', timeout, s.frame);
                if (s.do === 'expect_enabled' && !(await poll(() => r.loc.isEnabled(), timeout)))
                    throw new Error('element is disabled');
                if (s.do === 'expect_disabled' && !(await poll(() => r.loc.isDisabled(), timeout)))
                    throw new Error('element is enabled');
                const m = s.do === 'expect_visible' ? 'toBeVisible' : s.do === 'expect_enabled' ? 'toBeEnabled' : 'toBeDisabled';
                recorded = { ...s, target: r.record, frame: r.frame, code: `await expect(${r.code}).${m}();` };
                break;
            }
            case 'expect_hidden': {
                const target = need(s, 'target');
                const ok = await poll(async () => {
                    try {
                        const r = await session.resolve(target, 'any', 1, s.frame);
                        return !(await r.loc.isVisible());
                    }
                    catch {
                        return true;
                    }
                }, timeout);
                if (!ok)
                    throw new Error('element is still visible');
                // Only a raw selector can be exported faithfully: a semantic target is resolved by several strategies at run time.
                recorded.code = /^(css=|#|\[|\.|testid=)/.test(target) && !s.frame
                    ? (/^testid=/.test(target) ? `await expect(page.getByTestId(${q(target.slice(7))})).toBeHidden();` : `await expect(page.locator(${q(target.replace(/^css=/, ''))})).toBeHidden();`)
                    : `// fastqa:unsupported expect_hidden ${q(target)} (semantic target; enforced by fastqa replay only)`;
                break;
            }
            case 'expect_count': {
                const sel = need(s, 'target');
                const n = Number(need(s, 'value'));
                const loc = page.locator(sel.replace(/^css=/, ''));
                let c = -1;
                if (!(await poll(async () => (c = await loc.count()) === n, timeout)))
                    throw new Error(`count is ${c}, expected ${n}`);
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
                const okStatus = (st) => /^\dxx$/i.test(want) ? Math.floor(st / 100) === Number(want[0]) :
                    /^<\d+$/.test(want) ? st > 0 && st < Number(want.slice(1)) :
                        st === Number(want);
                let seen = [];
                const ok = await poll(async () => {
                    const hits = session.since(session.mark).filter((e) => e.kind === 'http' && (!method || e.method === method) && matches(e.url, urlPart));
                    seen = hits.map((h) => h.text);
                    const ok = hits.filter((h) => okStatus(h.status));
                    // An assertion that passes on 4xx/5xx responses declares them expected (a negative test): every response of this
                    // batch that satisfies it, so two negative submits followed by two assertions are both covered.
                    for (const h of ok)
                        if (h.status >= 400 && h.rid)
                            session.obs?.quality.markExpected(h.rid, `explicit expect_request ${spec} ${want}`);
                    return ok.length > 0;
                }, timeout);
                if (!ok)
                    throw new Error(seen.length ? `request seen but status not ${want}: ${seen.slice(-3).join(' ; ')}` : `no ${method ?? ''} request matching ${q(urlPart)} since this run started`);
                recorded.code = `await fq.expectRequest(${q(spec)}, ${q(want)});`;
                break;
            }
            case 'expect_no_errors': {
                // JS exceptions, console.error, network failures and HTTP 5xx since this run started. value "strict" also counts 4xx.
                const strict = /strict/i.test(s.value || '');
                const ignore = s.target ? s.target : undefined;
                const bad = session.since(session.mark).filter((e) => (e.kind !== 'http' || e.status === 0 || e.status >= (strict ? 400 : 500)) && !(ignore && (matches(e.text, ignore) || (!!e.url && matches(e.url, ignore)))));
                if (bad.length)
                    throw new Error(`${bad.length} error(s): ` + bad.slice(0, 4).map((e) => `${e.kind}: ${e.text.slice(0, 120)}`).join(' ; '));
                recorded.code = `await fq.expectNoErrors(${q(strict ? 'strict' : '')}${ignore ? ', ' + q(ignore) : ''});`;
                break;
            }
            case 'expect_accessible': {
                // value: lowest impact that fails the step: critical | serious (default) | moderate | minor
                const levels = ['critical', 'serious', 'moderate', 'minor'];
                const lim = levels.indexOf((s.value || 'serious').toLowerCase());
                const issues = (await auditA11y(page, () => 'iframe')).filter((i) => levels.indexOf(i.impact) <= (lim < 0 ? 1 : lim));
                if (issues.length)
                    throw new Error(`${issues.length} accessibility rule(s) violated: ` + issues.slice(0, 4).map((i) => `[${i.impact}] ${i.id} ×${i.count}`).join(', ') + ' — call audit for details');
                recorded.code = `await fq.expectAccessible(${q((s.value || 'serious').toLowerCase())});`;
                break;
            }
            default:
                throw new Error(`Unknown step "${s.do}". Valid: ${STEP_KINDS.join(', ')}`);
        }
        if (recorded && tmpl?.value !== undefined)
            recorded.value = tmpl.value;
        return { ok: true, ms: Date.now() - t0, line: `✓ ${label}${note ? ' — ' + note : ''} (${Date.now() - t0}ms)`, recorded };
    }
    catch (e) {
        const msg = String(e?.message || e).split('\n')[0].replace(/^locator\.\w+: /, '');
        return { ok: false, ms: Date.now() - t0, line: `✗ ${label} — ${msg}` };
    }
}
function maskish(s) {
    return /pass|pwd|secret|token/i.test(s.target || '') ? '•••' : s.value;
}
function envLiteral(t) {
    return '`' + t.replace(/`/g, '\\`').replace(/\{\{(\w+)\}\}/g, (_, k) => '${process.env.FASTQA_VAR_' + k + ' ?? ""}') + '`';
}
const isRe = (v) => { const m = /^\/(.+)\/([dgimsuy]*)$/.exec(v); if (!m)
    return false; try {
    new RegExp(m[1], m[2]);
    return true;
}
catch {
    return false;
} };
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function regexOrString(v) { return isRe(v) ? v : q(v); }
/** placeholder name/value pairs that were substituted into a bound step (never serialized) */
export const boundVars = new WeakMap();
/** Replace {{var}} placeholders. Values of secret-looking variables are registered with the redactor. */
export function bind(step, vars) {
    const used = [];
    const sub = (x) => x?.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        const v = k in vars ? vars[k] : process.env[`FASTQA_VAR_${k}`];
        if (v === undefined)
            return `{{${k}}}`;
        used.push([k, v]);
        if (redactor.isSecretVar(k))
            redactor.addSecret(v, k);
        return v;
    });
    const bound = { ...step, target: sub(step.target), value: sub(step.value) };
    if (used.length)
        boundVars.set(bound, used);
    return bound;
}
