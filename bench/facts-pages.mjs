// Fixtures for bench/facts.mjs: the facts fastqa gives the agent (field rules, effects of actions, failure reasons)
// and the QA rules that find bugs nobody asked about. Served by the demo server under /facts/<kind> and /api/facts/*.

const shell = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto}.toast{position:fixed;top:10px;right:10px;background:#222;color:#fff;padding:8px}
.cookie-banner{position:fixed;inset:0;background:rgba(0,0,0,.4)}</style></head><body>
${body}
<script>${script}</script></body></html>`;

const pages = {
  // a form with the rules the browser enforces; the agent should see them without trying
  form: () => shell('Facts form', `<h1>Register</h1>
<form id="reg">
  <label for="email">Email</label> <input id="email" type="email" required>
  <label for="mobile">Mobile</label> <input id="mobile" type="tel" maxlength="10" pattern="\\d{10}" required>
  <label for="age">Age</label> <input id="age" type="number" min="18" max="120">
  <label for="nick">Nickname</label> <input id="nick" minlength="2">
  <label for="pw">Password</label> <input id="pw" type="password">
  <button type="submit">Register</button>
</form>
<p role="status" id="done"></p>`, `
document.getElementById('reg').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/facts/ok', { method: 'POST', body: '{}' });
  document.getElementById('done').textContent = 'Registered';
});`),
  // a required radio group: the browser reports every option of it; the agent should hear about the group once
  radios: () => shell('Facts radios', `<h1>Plan</h1>
<form id="pf"><fieldset><legend>Plan</legend>
  <label><input type="radio" name="plan" value="free" required> Free</label>
  <label><input type="radio" name="plan" value="pro"> Pro</label>
  <label><input type="radio" name="plan" value="team"> Team</label>
</fieldset><button type="submit">Continue</button></form>`),
  // a failed save that tells the user nothing, and one that does
  silent: () => shell('Facts silent', `<h1>Settings</h1>
<button type="button" id="quiet">Save quietly</button>
<button type="button" id="loud">Save loudly</button>
<div id="msg"></div>`, `
document.getElementById('quiet').onclick = () => { fetch('/api/facts/fail', { method: 'POST', body: '{"a":1}' }); };
document.getElementById('loud').onclick = async () => {
  const r = await fetch('/api/facts/fail', { method: 'POST', body: '{"a":2}' });
  if (!r.ok) document.getElementById('msg').innerHTML = '<p role="alert">Could not save, try again</p>';
};`),
  // one click that sends the same order twice, and one that sends it once
  double: () => shell('Facts double', `<h1>Checkout</h1>
<button type="button" id="twice">Place order</button>
<button type="button" id="once">Place order once</button>
<p role="status" id="st"></p>`, `
const send = () => fetch('/api/facts/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"item":"mug","qty":1}' });
document.getElementById('twice').onclick = () => { send(); send(); document.getElementById('st').textContent = 'Ordered'; };
document.getElementById('once').onclick = async () => { await send(); document.getElementById('st').textContent = 'Ordered once'; };`),
  // a button with no handler, one that works, and a same-page link
  dead: () => shell('Facts dead', `<h1>Buttons</h1>
<button type="button">Does nothing</button>
<button type="button" id="works">Show details</button>
<a href="#top">Back to top</a>
<div id="out"></div>`, `document.getElementById('works').onclick = () => { document.getElementById('out').textContent = 'Details shown'; };`),
  // a confirmation that shows for 400 ms and is gone before any snapshot
  toast: () => shell('Facts toast', `<h1>Profile</h1><button type="button" id="save">Save profile</button>`, `
document.getElementById('save').onclick = async () => {
  await fetch('/api/facts/ok', { method: 'POST', body: '{}' });
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = 'Profile saved';
  document.body.appendChild(t); setTimeout(() => t.remove(), 400);
};`),
  // a button under an overlay, and a submit button that stays disabled until the required fields are filled
  blocked: () => shell('Facts blocked', `<h1>Pay</h1>
<button type="button" id="pay">Pay now</button>
<div class="cookie-banner" id="overlay"></div>
<form id="f"><label for="n">Card holder</label> <input id="n" required> <label for="c">Card number</label> <input id="c" required>
<button type="submit" id="sub" disabled>Submit payment</button></form>`, `
const f = document.getElementById('f');
f.addEventListener('input', () => { document.getElementById('sub').disabled = !f.checkValidity(); });`),
  // a native confirm() dialog
  confirm: () => shell('Facts confirm', `<h1>Items</h1><button type="button" id="del">Delete item</button><p role="status" id="st">item: kept</p>`, `
document.getElementById('del').onclick = () => { document.getElementById('st').textContent = confirm('Delete this item?') ? 'item: deleted' : 'item: kept'; };`),
  // an image that 404s (a network finding already) and one that arrives but cannot be shown
  images: () => shell('Facts images', `<h1>Gallery</h1><img src="/img/missing.png" alt="missing" width="20"><img src="/img/corrupt.png" alt="corrupt" width="20">`),
  // a bot check page in place of the site
  botcheck: () => `<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Verify you are human</h1><p>Checking your browser before accessing the site.</p></body></html>`,
  // ---- review cases: pages where a careless rule would cry wolf, or a fact would lie
  // an unsaved-changes guard: leaving must still work (Playwright accepts beforeunload when nobody listens)
  guard: () => shell('Facts guard', `<h1>Editor</h1><label for="nm">Name</label> <input id="nm"> <a href="/facts/form">Leave</a>`, `
document.getElementById('nm').addEventListener('input', () => addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; }));`),
  // errors that are shown, but not by inserting visible text at once
  animtoast: () => shell('Facts animtoast', `<style>@keyframes fi{from{opacity:0}to{opacity:1}}.t{animation:fi .3s}</style><h1>A</h1><button type="button" id="b">Save animated</button>`, `
document.getElementById('b').onclick = async () => { const r = await fetch('/api/facts/fail', { method: 'POST', body: '{"k":1}' }); if (!r.ok) { const d = document.createElement('div'); d.className = 't'; d.setAttribute('role', 'alert'); d.textContent = 'Could not save'; document.body.appendChild(d); } };`),
  hiddenerr: () => shell('Facts hiddenerr', `<h1>H</h1><button type="button" id="b">Save shown</button><p id="err" style="display:none">Saving failed, try again</p>`, `
document.getElementById('b').onclick = async () => { const r = await fetch('/api/facts/fail', { method: 'POST', body: '{"k":2}' }); if (!r.ok) document.getElementById('err').style.display = 'block'; };`),
  customval: () => shell('Facts customval', `<h1>C</h1><form id="cf"><label for="un">Username</label> <input id="un" value="taken"></form><button type="button" id="b">Check name</button>`, `
document.getElementById('b').onclick = async () => { const r = await fetch('/api/facts/conflict', { method: 'POST', body: '{"k":3}' }); if (!r.ok) { const u = document.getElementById('un'); u.setCustomValidity('That username is taken'); u.reportValidity(); } };`),
  retry: () => shell('Facts retry', `<h1>R</h1><button type="button" id="b">Load more</button><div id="out"></div>`, `
document.getElementById('b').onclick = async () => { for (let i = 0; i < 2; i++) { const r = await fetch('/api/facts/flaky?try=' + i); if (r.ok) return; await new Promise((s) => setTimeout(s, 2500)); } document.getElementById('out').textContent = 'Could not load'; };`),
  // clicks with an effect the DOM tree does not record
  props: () => shell('Facts props', `<h1>P</h1><input id="qty" value="1" aria-label="Quantity"> <button type="button" id="plus">Increase</button>
<input type="checkbox" class="row" aria-label="Row 1"> <input type="checkbox" class="row" aria-label="Row 2"> <button type="button" id="all">Select all</button>`, `
document.getElementById('plus').onclick = () => { const q = document.getElementById('qty'); q.value = String(Number(q.value) + 1); };
document.getElementById('all').onclick = () => document.querySelectorAll('.row').forEach((c) => { c.checked = true; });`),
  debounce: () => shell('Facts debounce', `<h1>D</h1><button type="button" id="b">Save later</button>`, `
document.getElementById('b').onclick = () => setTimeout(() => fetch('/api/facts/ok', { method: 'POST', body: '{"k":4}' }), 300);`),
  popover: () => shell('Facts popover', `<h1>Po</h1><button type="button" popovertarget="menu">Open menu</button><div id="menu" popover><a href="/facts/form">Settings</a></div>`),
  links: () => shell('Facts links', `<h1>L</h1><a href="/api/facts/ok" download="report.json">Export report</a> <a href="mailto:qa@example.com">Email us</a>
<input type="file" id="fi" style="display:none"> <button type="button" id="pick">Choose photo</button>`, `document.getElementById('pick').onclick = () => document.getElementById('fi').click();`),
  // distinct resources, and file bodies, are not duplicates
  bulk: () => shell('Facts bulk', `<h1>B</h1><button type="button" id="b">Delete selected</button><button type="button" id="u">Upload both</button><p role="status" id="st"></p>`, `
document.getElementById('b').onclick = async () => { await Promise.all([1, 2].map((i) => fetch('/api/facts/items/' + i, { method: 'DELETE' }))); document.getElementById('st').textContent = 'Deleted'; };
document.getElementById('u').onclick = async () => { await Promise.all(['a', 'b'].map((n) => { const f = new FormData(); f.append('file', new File([n + n], n + '.txt')); return fetch('/api/facts/upload', { method: 'POST', body: f }); })); document.getElementById('st').textContent = 'Uploaded'; };`),
  // more than 300 message elements over a page's life, then a toast
  many: () => shell('Facts many', `<h1>M</h1><div id="list"></div><button type="button" id="b">Save after many</button>`, `
const l = document.getElementById('list'); for (let i = 0; i < 400; i++) { const s = document.createElement('span'); s.setAttribute('role', 'status'); s.textContent = 'badge ' + i; l.appendChild(s); }
document.getElementById('b').onclick = async () => { await fetch('/api/facts/ok', { method: 'POST', body: '{}' }); const t = document.createElement('div'); t.setAttribute('role', 'status'); t.textContent = 'Saved after many'; document.body.appendChild(t); setTimeout(() => t.remove(), 300); };`),
  // a status re-rendered with the same text, and a modal the agent closes itself
  rerender: () => shell('Facts rerender', `<h1>Re</h1><button type="button" id="b">Save cart</button><div id="box"></div>`, `
document.getElementById('b').onclick = () => { const box = document.getElementById('box'); box.innerHTML = '<p role="status">Cart saved</p>'; setTimeout(() => { box.innerHTML = '<p role="status">Cart saved</p>'; }, 100); };`),
  modal: () => shell('Facts modal', `<h1>Mo</h1><button type="button" id="b">Delete thing</button><div id="slot"></div>`, `
document.getElementById('b').onclick = () => { document.getElementById('slot').innerHTML = '<div role="dialog" id="dlg">Delete this thing? <button type="button" onclick="document.getElementById(\\'dlg\\').remove()">Keep it</button></div>'; };`),
  // dialogs at odd moments
  latealert: () => shell('Facts latealert', `<h1>La</h1><button type="button" id="s">Save now</button><button type="button">Does nothing</button>`, `
document.getElementById('s').onclick = () => setTimeout(() => alert('Saved late'), 400);`),
  alertload: () => shell('Facts alertload', `<h1>Al</h1>`, `alert('Welcome back');`),
  // a redirected image that ends in a 404: one network finding, no BROKEN-IMAGE
  redirimg: () => shell('Facts redirimg', `<h1>Ri</h1><img src="/img/redir" alt="r" width="20">`),
  // the site's own pages that are not bot checks, and an invisible captcha badge
  denied: () => `<!doctype html><html><head><title>Access denied</title></head><body><h1>Access denied</h1><p>You do not have permission.</p><a href="/facts/form">Back</a></body></html>`,
  seccheck: () => shell('Security Checkup', `<h1>Security Checkup</h1><form><label for="pw2">Current password</label> <input id="pw2" type="password" required></form>`),
  invisiblecaptcha: () => shell('Facts captcha', `<h1>Sign in</h1><form><label for="e2">Email</label> <input id="e2" type="email" required></form><iframe src="/recaptcha/api2/anchor?size=invisible" title="reCAPTCHA" width="256" height="60"></iframe>`),
  // a batch of calls where the failure comes last
  manycalls: () => shell('Facts manycalls', `<h1>Mc</h1><button type="button" id="b">Refresh all</button><p role="status" id="st"></p>`, `
document.getElementById('b').onclick = async () => { for (const p of ['/api/facts/ok', '/api/facts/upload', '/api/facts/order']) await fetch(p); await fetch('/api/facts/fail', { method: 'POST', body: '{"k":5}' }); document.getElementById('st').textContent = 'Refreshed'; };`),
  // a field the page marks aria-invalid that also fails native validation, untouched
  ariainv: () => shell('Facts ariainv', `<h1>Ai</h1><form><label for="ai">Code</label> <input id="ai" required aria-invalid="true"></form>`),
  // a login button that is named "Login", not "Log in"
  near: () => shell('Facts near', `<h1>Welcome</h1><button type="button">Login</button> <a href="/facts/form">Sign in with email</a> <button type="button">Help</button>`),
};

export function factsPage(pathname) {
  const m = /^\/facts\/(\w+)$/.exec(pathname);
  return m && pages[m[1]] ? pages[m[1]]() : undefined;
}

/** API and image routes of the facts fixtures. Returns [status, type, body] or undefined. */
export function factsApi(pathname) {
  if (pathname === '/api/facts/ok') return [200, 'application/json', '{"ok":true}'];
  if (pathname === '/api/facts/fail') return [500, 'application/json', '{"error":"inventory timeout","detail":"CANARY-FACT-DETAIL jane.facts@example.com"}'];
  if (pathname === '/api/facts/order') return [200, 'application/json', '{"order":"o-1"}'];
  if (pathname === '/img/corrupt.png') return [200, 'image/png', 'this is not a png'];
  if (pathname === '/api/facts/conflict') return [409, 'application/json', '{"error":"taken"}'];
  if (pathname === '/api/facts/flaky') return [503, 'application/json', '{"error":"busy"}'];
  if (/^\/api\/facts\/items\/\d+$/.test(pathname)) return [200, 'application/json', '{}'];
  if (pathname === '/api/facts/upload') return [200, 'application/json', '{}'];
  if (pathname.startsWith('/recaptcha/')) return [200, 'text/html', '<!doctype html><title>captcha</title><p>badge</p>'];
  return undefined;
}
