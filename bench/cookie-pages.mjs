// Cookie banner fixtures for bench/cookies.mjs, served by the demo server under /cookies/<kind> and /consent.
// Every page shows "consent: none" until a banner button is clicked, then "consent: accepted" or "consent: rejected".
// The choice is remembered (localStorage), so the banner does not come back in the same browser context.
// Each page also has an ordinary "Accept" button outside the banner: clicking it is a mistake ("invitation: accepted").

const shell = (title, banner, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto}.bar{position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:12px}</style></head><body>
<h1>Daily News</h1>
<p id="consent" role="status">consent: none</p>
<p>You are invited to the reader panel. <button id="invite">Accept</button> <span id="invitation" role="status">invitation: open</span></p>
<p><button id="more">Load more</button> <span id="loaded" role="status"></span></p>
<footer><a href="/privacy">Cookie policy</a></footer>
<script>
const P = new URLSearchParams(location.search);
const KEY = 'consent:' + location.pathname;
const decide = (v) => { localStorage.setItem(KEY, v); document.getElementById('consent').textContent = 'consent: ' + v; document.querySelectorAll('[data-banner]').forEach((b) => b.remove()); };
document.getElementById('invite').onclick = () => { document.getElementById('invitation').textContent = 'invitation: accepted'; };
document.getElementById('more').onclick = () => { document.getElementById('loaded').textContent = 'more loaded'; };
// ?busy=1: the page keeps fetching, like a site that is still loading its scripts
if (P.get('busy')) setInterval(() => fetch('/api/poll', { cache: 'no-store' }).catch(() => {}), 150);
const show = () => {
  const t = document.createElement('template'); t.innerHTML = ${JSON.stringify(banner)};
  document.body.appendChild(t.content);
  document.querySelectorAll('[data-consent]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); decide(b.dataset.consent); }));
  ${script}
};
const saved = localStorage.getItem(KEY);
if (saved) document.getElementById('consent').textContent = 'consent: ' + saved;
// a consent tool loads after the page: the banner shows up a moment later
else setTimeout(show, Number(P.get('delay') ?? 300));
</script></body></html>`;

const pages = {
  // a known consent tool: found by its ids, whatever the labels say
  onetrust: shell('Cookies onetrust', `<div data-banner id="onetrust-banner-sdk" class="bar" role="dialog" aria-label="Privacy"><p>We use cookies to personalise content.</p>
<button id="onetrust-pc-btn-handler">Cookies Settings</button> <button id="onetrust-reject-all-handler" data-consent="rejected">Refuser</button> <button id="onetrust-accept-btn-handler" data-consent="accepted">Tout autoriser</button></div>`),
  // an unknown banner: found by its words
  generic: shell('Cookies generic', `<div data-banner class="cookie-notice bar"><p>This site uses cookies to improve your experience.</p>
<button>Manage options</button> <a href="#" role="button" data-consent="rejected">Only necessary</a> <button data-consent="accepted">Accept all</button></div>`),
  bg: shell('Cookies bg', `<div data-banner id="gdpr-bar" class="bar"><p>Този сайт използва бисквитки, за да подобри работата си.</p>
<button>Настройки</button> <button data-consent="rejected">Отхвърлям</button> <button data-consent="accepted">Приемам всички</button></div>`),
  // only one way out: there is nothing to reject with
  'accept-only': shell('Cookies accept-only', `<div data-banner class="cc-window bar" role="dialog" aria-label="cookieconsent"><span>We use cookies.</span> <a href="/privacy">Learn more</a> <button class="cc-btn" data-consent="accepted">Got it!</button></div>`),
  // the banner lives in an iframe (consent platforms such as Sourcepoint do this)
  frame: shell('Cookies frame', `<iframe data-banner id="sp_message_iframe_1" title="Privacy" src="/cookies/inner" style="position:fixed;bottom:0;left:0;width:100%;height:120px;border:0"></iframe>`,
    `addEventListener('message', (e) => { if (e.data && e.data.consent) decide(e.data.consent); });`),
  // the banner lives in a shadow root (Usercentrics does this)
  shadow: shell('Cookies shadow', `<div data-banner id="usercentrics-root"></div>`,
    `const root = document.getElementById('usercentrics-root').attachShadow({ mode: 'open' });
  root.innerHTML = '<div class="bar"><p>Privacy settings: this site uses cookies.</p><button data-testid="uc-more-button">More</button> <button data-testid="uc-deny-all-button">Deny</button> <button data-testid="uc-accept-all-button">Accept All</button></div>';
  root.querySelector('[data-testid=uc-deny-all-button]').onclick = () => decide('rejected');
  root.querySelector('[data-testid=uc-accept-all-button]').onclick = () => decide('accepted');`),
  // buttons built the way large shops build them: a nearly transparent <input> over a styled label, named by aria-labelledby
  overlay: shell('Cookies overlay', `<form data-banner id="cos-banner" class="bar" role="dialog" onsubmit="return false"><p>Cookies und Werbeoptionen: wenn du zustimmst, verwenden wir Cookies.</p><p style="max-height:40px;overflow:auto">${'Wir verwenden Cookies und ähnliche Technologien für Dienste und Werbung. '.repeat(40)}</p>
<span class="a-button" style="position:relative;display:inline-block;padding:6px"><input id="sp-cc-rejectall-link" type="submit" aria-labelledby="l-no" data-consent="rejected" style="position:absolute;inset:0;opacity:.01"><span id="l-no" class="a-button-text">Ablehnen</span></span>
<span class="a-button" style="position:relative;display:inline-block;padding:6px"><input id="sp-cc-accept" type="submit" aria-labelledby="l-yes" data-consent="accepted" style="position:absolute;inset:0;opacity:.01"><span id="l-yes" class="a-button-text">Akzeptieren</span></span></form>`),
  // "pay or accept": the only way to say no is to subscribe, which is not a reject button
  paywall: shell('Cookies paywall', `<div data-banner class="cookie-wall bar" role="dialog"><p>Read with advertising and cookies, or subscribe. We and our <a href="/partners">137 partners</a> follow the <a href="/privacy">privacy policy</a>.</p>
<div class="button-row"><button data-consent="rejected">Reject all and subscribe</button> <button data-consent="accepted">Accept all</button></div></div>`),
  // a consent request that never says "cookie": Bulgarian wording about consent and personal data
  'bg-consent': shell('Cookies bg-consent', `<div data-banner class="fc-consent-root bar"><p>Сайтът иска вашето съгласие да използва личните ви данни.</p>
<button>Опции за управление</button> <button data-consent="accepted">Съгласен съм</button></div>`),
  // the site loads a new document as soon as the banner is answered, and that document is slow to arrive
  reload: shell('Cookies reload', `<div data-banner class="cookie-notice bar"><p>This site uses cookies.</p><button data-consent="accepted">Accept all</button></div>`,
    `document.querySelector('[data-consent]').addEventListener('click', () => { location.href = '/cookies/slow-body'; });`),
  // a sign-in pop-up that mentions the cookie policy: "Continue" there starts a login, it does not answer a banner
  signin: shell('Cookies signin', `<div data-banner class="bar" role="dialog" aria-label="Sign in"><p>Sign in to read on. By continuing you agree to our Terms, Privacy Policy and Cookie Policy.</p>
<button data-consent="accepted">Continue with Google</button> <button data-consent="accepted">Continue</button> <button data-consent="rejected">Not now</button></div>`),
  // consent of another kind, in the application under test: not a cookie banner
  patient: shell('Cookies patient', `<div data-banner class="consent-dialog bar" role="dialog"><p>Patient consent: I agree to the treatment plan and to the processing of my personal data.</p>
<button data-consent="rejected">Decline</button> <button data-consent="accepted">Accept</button></div>`),
  // "безплатно" (free) contains the letters of "платен" (paid): accepting for free is still accepting
  'bg-free': shell('Cookies bg-free', `<div data-banner id="cookie-bar" class="bar"><p>Този сайт използва бисквитки.</p>
<button>Платен достъп без реклами</button> <button data-consent="accepted">Приемам и чета безплатно</button></div>`),
  // no banner at all: nothing may be clicked
  none: shell('Cookies none', ''),
  // a newsletter pop-up is not a cookie banner, even with an "Accept" style button in a dialog
  newsletter: shell('Cookies newsletter', `<div data-banner class="bar" role="dialog" aria-label="Newsletter"><p>Get our weekly newsletter.</p><button data-consent="accepted">Yes, sign me up</button> <button data-consent="rejected">No thanks</button></div>`),
};

const inner = `<!doctype html><html><head><meta charset="utf-8"><title>Privacy message</title></head><body>
<p>We and our partners use cookies to store information on your device.</p>
<button title="Options">Options</button> <button id="no">Reject all</button> <button id="yes">I agree</button>
<script>
document.getElementById('yes').onclick = () => parent.postMessage({ consent: 'accepted' }, '*');
document.getElementById('no').onclick = () => parent.postMessage({ consent: 'rejected' }, '*');
</script></body></html>`;

// a whole page that must be answered before the site opens (search engines and video sites do this)
const wall = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Before you continue</title></head><body>
<h1>Before you continue</h1><p>We use cookies and data to deliver and maintain our services.</p>
<button id="no">Reject all</button> <button id="yes">Accept all</button> <a href="/privacy">More options</a>
<script>
const go = (v) => { localStorage.setItem('consent:/cookies/none', v); location.href = '/cookies/none'; };
document.getElementById('yes').onclick = () => go('accepted');
document.getElementById('no').onclick = () => go('rejected');
</script></body></html>`;

/** html for a cookie fixture path, or undefined */
export function cookiePage(pathname) {
  if (pathname === '/consent') return wall;
  if (pathname === '/cookies/inner') return inner;
  const m = /^\/cookies\/([\w-]+)$/.exec(pathname);
  return m ? pages[m[1]] : undefined;
}
