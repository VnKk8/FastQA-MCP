// Cookie / consent banners: find the accept or reject button of a banner and click it.
// Opt-in: open {cookies}, the `cookies` step, or FASTQA_COOKIES. Tolerant: a page without a banner is not an error.
import type { ElementHandle, Frame, Page } from 'playwright';
import { sleep, within } from './session.js';

export type CookieChoice = 'accept' | 'reject';
export const COOKIE_CHOICES: readonly CookieChoice[] = ['accept', 'reject'];
/** How long a page is given to show its banner (consent tools load after the page). */
export const COOKIE_WAIT_MS = 2500;
/** A page that has fetched nothing for this long is not going to show a banner: the wait ends early. */
export const COOKIE_QUIET_MS = 800;
/** The wait on later pages of a site that was already looked at in this browser context. */
export const COOKIE_RECHECK_MS = 800;

export interface ConsentFind { el: Element | null; label: string; seen: string[] }

/**
 * Runs inside the page, once per frame: returns the banner button for `choice`, or, when a banner has no such button,
 * the labels of the buttons it does have. Self-contained, because it is serialized into the page and into exported specs.
 *
 * Two ways to find a button: the ids / classes of well-known consent tools, and, for everything else, the words on the
 * button. A button found by its words only counts inside something that looks like a cookie banner (a small fixed,
 * dialog-like or cookie-named block whose text is about cookies), so an ordinary "Accept" or "OK" on the page is not touched.
 */
export function findConsentButton(choice: 'accept' | 'reject'): ConsentFind {
  const KNOWN: Record<string, string[]> = {
    accept: ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
      '#didomi-notice-agree-button', '[data-testid="uc-accept-all-button"]', '#truste-consent-button', '.osano-cm-accept-all', '.cky-btn-accept', '.cmplz-accept',
      '.iubenda-cs-accept-btn', '.fc-cta-consent', '.cc-allow', '#axeptio_btn_acceptAll', '[data-tid="banner-accept"]', '#shopify-pc__banner__btn-accept', '#sp-cc-accept',
      '.klaro .cm-btn-success', '[data-cookiefirst-action="accept"]', '#cookiescript_accept', '.qc-cmp2-summary-buttons button[mode="primary"]'],
    reject: ['#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll', '#CybotCookiebotDialogBodyButtonDecline',
      '#didomi-notice-disagree-button', '.didomi-continue-without-agreeing', '[data-testid="uc-deny-all-button"]', '#truste-consent-required', '.osano-cm-denyAll', '.osano-cm-deny',
      '.cky-btn-reject', '.cmplz-deny', '.iubenda-cs-reject-btn', '.fc-cta-do-not-consent', '.cc-deny', '#axeptio_btn_dismiss', '[data-tid="banner-decline"]',
      '#shopify-pc__banner__btn-decline', '#sp-cc-rejectall-link', '.klaro .cm-btn-decline', '[data-cookiefirst-action="reject"]', '#cookiescript_reject'],
  };
  // What makes a block a cookie banner. Its text says "cookie"; or the block belongs to a consent tool and its text is
  // about consent or personal data. "Privacy" or "consent" alone is not enough: sign-in pop-ups link to a privacy policy,
  // and the application under test can have consent dialogs of its own (terms, patient consent) that are not ours to answer.
  const COOKIE = /cookie|бисквит|ciastecz|galleta/i;
  const ABOUT = /consent|consens|gdpr|privacy|personal data|съгласие|личн\S* (ви )?данни|поверител|datenschutz|einwilligung|zustimmung|données|confidentialit|privacidad|privacidade|riservatezza|toestemming|prywatno|zgod[aęy]|rgpd|dsgvo/i;
  const TOOL = /onetrust|didomi|usercentrics|cookiebot|truste|osano|klaro|iubenda|borlabs|complianz|termly|cky-|cc-window|sp_message|sourcepoint|privacy-mgmt|qc-cmp|quantcast|fc-consent|fc-dialog|fundingchoices|(^|[^a-z])cmp([^a-z]|$)|gdpr|tcf/i;
  const NAMED = /cookie|consent|gdpr|cmp|privacy|onetrust|didomi|usercentrics|truste|osano|klaro|iubenda|borlabs|complianz|termly|cky-|cc-window|sp_message|notice/i;
  // words on the button, in English, Bulgarian, German, French, Spanish, Italian, Dutch, Portuguese and Polish
  const REJECT = /\b(reject|decline|deny|refuse|disagree|disallow|opt[ -]?out|no,? thanks?|not now)\b|\b(do not|don'?t|without) (accept|agree|allow|consent)|\b(necessary|essential|strictly|required)\b|отхвърл|отказ|откаж|не приемам|не съм съглас|необходим|задължител|без (приемане|съгласие)|ablehnen|verweiger|nicht (zustimmen|akzeptieren|einverstanden)|notwendig|erforderlich|essenziell|ohne (zustimmung|einwilligung|zuzustimmen)|refuse|rejeter|sans accepter|n[ée]cessaire|essentiel|rechazar|denegar|no acepto|necesari|esencial|sin aceptar|rifiut|\bnega\b|necessari|essenzial|senza accettare|weiger|afwijzen|noodzakelijk|niet akkoord|rejeitar|recusar|necess[áa]ri|essencia|sem aceitar|odrzu[cć]|odmawiam|niezb[ęe]dn|wymagan|konieczn|nie zgadzam/i;
  const SETTINGS = /setting|preference|\boptions?\b|customi[sz]e|manage|choose|choice|more info|learn more|read more|detail|policy|purpose|partner|vendor|configur|personali[sz]|\bselect|\bsave\b|настройк|предпочитан|управл|избор|избер|научи|повече|политика|детайл|персонализ|запази|einstellung|anpassen|verwalten|\bmehr\b|auswahl|optionen|speichern|param[èe]tr|personnalis|g[ée]rer|pr[ée]f[ée]rence|en savoir|\bchoix\b|enregistrer|gestionar|preferenc|m[áa]s info|opciones|guardar|impostaz|gestisci|preferenz|maggiori|opzioni|\bsalva|instelling|aanpassen|beheer|voorkeur|meer info|opties|opslaan|gerir|gerenciar|mais info|op[çc][õo]es|ustawie|dostosuj|zarz[ąa]dzaj|wi[ęe]cej|opcje|zapisz/i;
  // "continue" is deliberately not an accept word: "Continue with Google" in a sign-in pop-up starts a login
  const ACCEPT = /\b(accept|agree|allow|consent|approve|enable|got it|understood|understand|ok|okay|yes)\b|приема|приеми|съглас|разреш|разбрах|^(добре|да|ок)$|akzeptier|zustimm|einverstanden|zulassen|erlauben|verstanden|annehmen|autoris|d'accord|j'ai compris|acept|permitir|de acuerdo|entendido|accett|acconsent|ho capito|va bene|accepte|akkoord|toestaan|begrepen|aceit|concord|entendi|akcept|zgadzam|zezw[oa]l|rozumiem/i;
  const ALL = /\ball\b|всичк|\balle\b|\btout|\btous\b|\btod[oa]s?\b|\btutt[oi]\b|\balles\b|wszystk/i;

  // "pay or accept": saying no means subscribing, so that button is not a way to reject
  const PAY = /subscri|suscri|abonn|abbon|\babo\b|\bpay\b|premium|purchase|\bbuy\b|абонам|абонир|(?<![а-я])плат|werbefrei|ohne werbung|sans pub/i;

  // Opacity is not looked at: shops put a nearly transparent <input> over a styled label, and that input is the button.
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || (el as HTMLButtonElement).disabled) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  };
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  /** the label a person reads on the button */
  const shown = (el: Element): string => {
    const own = clean((el as HTMLElement).innerText) || clean((el as HTMLInputElement).value) || clean(el.getAttribute('aria-label'));
    if (own) return own;
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => clean((el.getRootNode() as Document | ShadowRoot).getElementById?.(id)?.textContent)).join(' ').trim();
    return by || clean(el.getAttribute('title')) || (el.tagName === 'INPUT' ? clean(el.parentElement?.innerText).slice(0, 60) : '');
  };
  const classOf = (label: string): 'accept' | 'reject' | 'settings' | '' => {
    const l = label.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!l || l.length > 60) return '';
    if (PAY.test(l)) return 'settings';
    if (REJECT.test(l.replace(/\bnon[- ]?(essential|necessary)\b/g, ''))) return 'reject';
    if (SETTINGS.test(l)) return 'settings';
    return ACCEPT.test(l) ? 'accept' : '';
  };

  // the document and every open shadow root in it
  const roots: Array<Document | ShadowRoot> = [document];
  for (let i = 0; i < roots.length && roots.length < 200; i++) {
    const all = roots[i].querySelectorAll('*');
    for (let j = 0; j < all.length; j++) { const sr = all[j].shadowRoot; if (sr) roots.push(sr); }
  }

  for (const sel of KNOWN[choice]) {
    for (const root of roots) {
      const el = root.querySelector(sel);
      if (el && visible(el)) return { el, label: shown(el).slice(0, 60), seen: [] };
    }
  }

  const bodyText = (document.body?.innerText || '').slice(0, 4000);
  const isBanner = (text: string, names: string) => COOKIE.test(text) || (TOOL.test(names) && ABOUT.test(text));
  // A whole document that is the banner: a short consent iframe, or a consent page shown before the site
  // (consent.example.com, /consent). The same rule applies to it as to a block.
  const here = `${location.hostname}${location.pathname} ${window.name}`;
  const consentPage = /(^|\.)consent\.|\/consent(\/|$)|cookie-?wall/i.test(location.hostname + location.pathname);
  const wholeDoc = (window !== window.top || consentPage) && bodyText.length < 4000 && isBanner(bodyText, here);
  const parentOf = (n: Element): Element | null => n.parentElement || ((n.getRootNode() as ShadowRoot).host ?? null);
  const textOf = (n: Element) => ((n as HTMLElement).innerText || n.textContent || '') + (n.shadowRoot ? n.shadowRoot.textContent || '' : '');
  const inBanner = (el: Element): boolean => {
    if (wholeDoc) return true;
    for (let n = parentOf(el); n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      const cs = getComputedStyle(n);
      const names = `${n.id} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('aria-label') || ''}`;
      const marked = NAMED.test(names) || /dialog/.test(n.getAttribute('role') || '') || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG' ||
        cs.position === 'fixed' || cs.position === 'sticky';
      if (!marked) continue;
      const t = textOf(n);
      // a banner is a block of limited size; a page wrapper that merely has "cookie" in a class name is not one
      if (t.length <= 5000 && isBanner(t, names)) return true;
    }
    return false;
  };

  const seen: string[] = [];
  let best: { el: Element; label: string; rank: number } | undefined;
  for (const root of roots) {
    const cands = root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"], [class*="btn" i], [class*="button" i]');
    for (let i = 0; i < cands.length && i < 3000; i++) {
      const el = cands[i];
      if (el.querySelector('button, a, input, [role="button"]')) continue; // a row of buttons, not a button
      const label = shown(el);
      const cls = classOf(label);
      if (!cls || !visible(el) || !inBanner(el)) continue;
      const buttonish = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'INPUT';
      // what is reported back: the banner's buttons, not every "privacy policy" link in its text
      if ((buttonish || cls !== 'settings') && seen.length < 6 && !seen.includes(label)) seen.push(label);
      if (cls !== choice) continue;
      const rank = (ALL.test(label) ? 0 : 1000) + (buttonish ? 0 : 100) + label.length;
      if (!best || rank < best.rank) best = { el, label, rank };
    }
  }
  return best ? { el: best.el, label: best.label, seen } : { el: null, label: '', seen };
}

export type CookieOutcome =
  | { status: 'clicked'; label: string; stillVisible: boolean }
  | { status: 'no-banner' }
  | { status: 'no-button'; seen: string[] };

interface Probe { el?: ElementHandle<Element>; label: string; seen: string[] }

async function probe(frame: Frame, choice: CookieChoice): Promise<Probe | undefined> {
  if (frame.isDetached()) return undefined;
  try {
    const h = await frame.evaluateHandle(findConsentButton, choice);
    try {
      const info = await h.evaluate((x) => ({ has: !!x.el, label: x.label, seen: x.seen }));
      const el = info.has ? (await h.getProperty('el')).asElement() ?? undefined : undefined;
      return { el: el as ElementHandle<Element> | undefined, label: info.label, seen: info.seen };
    } finally { void h.dispose().catch(() => {}); }
  } catch { return undefined; } // the frame navigated away, or it does not allow scripts
}

/**
 * Looks for a cookie banner in the page and its iframes for up to `waitMs` and clicks the button for `choice`.
 * Never throws for a page without a banner or a banner without that button: the outcome says what happened.
 *
 * `quietFor` says for how many ms the page has fetched nothing. A consent tool loads after the page, so a page that is
 * still busy is worth waiting for; a page that has been quiet for COOKIE_QUIET_MS is not going to show a banner, and
 * waiting out the whole `waitMs` there would only make every open slower.
 */
export async function dismissCookies(page: Page, choice: CookieChoice, waitMs = COOKIE_WAIT_MS, quietFor?: () => number): Promise<CookieOutcome> {
  const end = Date.now() + waitMs;
  let bannerSeen = 0; let seen: string[] = [];
  for (;;) {
    // measured before looking, so a banner that showed up within the quiet time is always seen by this last look
    const quiet = quietFor?.() ?? 0;
    // every frame at once, each bounded: a frame that does not answer must not hold up the others
    const probes = await Promise.all(page.frames().map((f) => { let r: Probe | undefined; return within(probe(f, choice).then((x) => { r = x; }), 1500).then(() => r); }));
    const hit = probes.find((p) => p?.el);
    if (hit?.el) {
      const el = hit.el;
      try { await el.click({ timeout: 2000 }); }
      catch { await el.evaluate((e) => (e as HTMLElement).click()).catch(() => {}); } // covered or moving: click it directly
      const gone = Date.now() + 1500; let visible = true;
      while (visible && Date.now() < gone) { visible = await el.isVisible().catch(() => false); if (visible) await sleep(50); }
      return { status: 'clicked', label: hit.label, stillVisible: visible };
    }
    const labels = probes.find((p) => p?.seen.length)?.seen;
    if (labels) { seen = labels; if (++bannerSeen >= 2) break; } // the banner is there and complete: it has no such button
    if (Date.now() >= end || quiet >= COOKIE_QUIET_MS) break;
    // look again soon, and exactly when the quiet time is up if that comes first
    await sleep(Math.max(20, Math.min(200, COOKIE_QUIET_MS - (quietFor?.() ?? 0))));
  }
  return seen.length ? { status: 'no-button', seen } : { status: 'no-banner' };
}

/** One line for results and reports. */
export function describeOutcome(o: CookieOutcome, choice: CookieChoice): string {
  if (o.status === 'clicked') return `clicked ${JSON.stringify(o.label)}${o.stillVisible ? ' (the banner is still visible)' : ''}`;
  if (o.status === 'no-button') return `banner found, but it has no ${choice} button (saw ${o.seen.map((s) => JSON.stringify(s)).join(', ')})`;
  return 'no cookie banner found';
}
