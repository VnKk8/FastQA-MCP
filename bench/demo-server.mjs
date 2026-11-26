// Tiny demo app for testing fastqa: login -> bonus lobby -> claim a bonus (async API).
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto}label{display:block;margin:8px 0}
.card{border:1px solid #ccc;padding:12px;margin:10px 0;border-radius:8px}.hidden{display:none}</style></head><body>${body}</body></html>`;

const login = page('Login – DemoCasino', `
<nav><a href="/">Home</a> <a href="/promotions">Promotions</a> <a href="/help">Help</a></nav>
<h1>Sign in</h1>
<form id="f">
  <label for="email">Email</label><input id="email" type="email" required>
  <label for="pw">Password</label><input id="pw" type="password" required>
  <label><input type="checkbox" id="remember"> Remember me</label>
  <button type="submit" data-testid="login-btn">Log in</button>
</form>
<div id="err" role="alert"></div>
<footer><p>Responsible gaming. 18+ only.</p><a href="/terms">Terms</a> <a href="/privacy">Privacy</a></footer>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', {method:'POST', body: JSON.stringify({email: email.value, pw: pw.value})});
  if (r.ok) location.href = '/lobby'; else document.getElementById('err').textContent = 'Invalid email or password';
};
</script>`);

const bonuses = [
  ['welcome', 'Welcome bonus', '100% up to 200 EUR'],
  ['reload', 'Weekend reload', '50% up to 100 EUR'],
  ['spins', 'Free spins', '50 free spins on Book of Demo'],
];
const lobby = page('Lobby – DemoCasino', `
<nav><a href="/lobby">Lobby</a> <a href="/promotions">Promotions</a> <a href="/wallet">Wallet</a> <button aria-label="Account menu">👤</button></nav>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><h1>Welcome back, ivan</h1>
<p>Balance: <strong id="bal">0.00 EUR</strong></p>
<label for="cur">Currency</label>
<select id="cur"><option>EUR</option><option>BGN</option><option>USD</option></select>
<h2>Available bonuses</h2>
${bonuses.map(([id, name, desc]) => `<div class="card" id="card-${id}"><h3>${name}</h3><p>${desc}</p>
<label><input type="checkbox" class="tc" data-b="${id}"> I accept the bonus terms</label>
<button data-b="${id}" class="claim" disabled>Claim ${name}</button><span class="st" role="status"></span></div>`).join('')}
<script>
document.querySelectorAll('.tc').forEach(cb => cb.onchange = () => {
  document.querySelector('button.claim[data-b="'+cb.dataset.b+'"]').disabled = !cb.checked;
});
document.querySelectorAll('.claim').forEach(b => b.onclick = async () => {
  b.disabled = true; b.textContent = 'Claiming…';
  const r = await fetch('/api/claim/' + b.dataset.b, {method:'POST'});
  const st = b.parentElement.querySelector('.st');
  if (r.ok) { const j = await r.json(); st.textContent = 'Bonus activated: ' + j.amount; b.remove(); document.getElementById('bal').textContent = j.balance; }
  else { st.textContent = 'Could not claim bonus'; b.disabled = false; b.textContent = 'Retry'; console.error('claim failed', r.status); }
});
</script>`);

// Cashier: open shadow DOM web component + cross-origin iframe (served from "localhost" while the page is on 127.0.0.1)
// that itself contains a shadow DOM field and a nested 3DS iframe.
const cashier = (port) => page('Cashier – DemoCasino', `
<h1>Cashier</h1>
<promo-box></promo-box>
<iframe title="Payment" src="http://localhost:${port}/pay-frame" style="width:600px;height:360px;border:1px solid #999"></iframe>
<p id="result" role="status"></p>
<script>
customElements.define('promo-box', class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<h3>Promo</h3><label for="pc">Promo code</label><input id="pc"><button>Apply code</button><span role="status"></span>';
    r.querySelector('button').onclick = () => {
      r.querySelector('[role=status]').textContent = r.querySelector('#pc').value === 'WELCOME50' ? 'Promo applied: +50 free spins' : 'Unknown promo code';
    };
  }
});
addEventListener('message', (e) => { if (e.data?.paid) document.getElementById('result').textContent = 'Deposit successful: ' + e.data.paid; });
</script>`);

const payFrame = page('Payment frame', `
<h2>Deposit</h2>
<label for="holder">Card holder</label><input id="holder">
<card-field></card-field>
<label for="amt">Amount</label><select id="amt"><option>20 EUR</option><option>50 EUR</option><option>100 EUR</option></select>
<button id="dep">Deposit</button>
<div id="tds"></div>
<script>
customElements.define('card-field', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label>Card number <input name="cc" inputmode="numeric"></label>'; }
});
dep.onclick = () => {
  const cc = document.querySelector('card-field').shadowRoot.querySelector('input').value;
  if (!holder.value || cc.length < 12) { tds.textContent = 'Please fill in card details'; tds.setAttribute('role','alert'); return; }
  tds.innerHTML = '<iframe title="3-D Secure" src="/3ds?amt=' + encodeURIComponent(amt.value) + '" style="width:400px;height:120px"></iframe>';
};
</script>`);

const tds = page('3DS', `<p>Bank verification</p><button id="ok">Confirm payment</button>
<script>ok.onclick = () => window.top.postMessage({ paid: new URLSearchParams(location.search).get('amt') }, '*');</script>`);

export function start(port = 0) {
  const srv = http.createServer(async (req, res) => {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
    const send = (code, type, data, delay = 0) => setTimeout(() => { res.writeHead(code, { 'content-type': type }); res.end(data); }, delay);
    if (req.url === '/' || req.url === '/login') return send(200, 'text/html', login);
    if (req.url === '/lobby') return send(200, 'text/html', lobby);
    if (req.url === '/cashier') return send(200, 'text/html', cashier(srv.address().port));
    if (req.url === '/pay-frame') return send(200, 'text/html', payFrame);
    if (req.url?.startsWith('/3ds')) return send(200, 'text/html', tds);
    if (req.url === '/api/login') {
      const j = JSON.parse(body || '{}');
      return j.pw === 'secret123' ? send(200, 'application/json', '{}', 250) : send(401, 'application/json', '{}', 250);
    }
    if (req.url?.startsWith('/api/claim/')) {
      const id = req.url.split('/').pop();
      if (id === 'spins') return send(500, 'application/json', '{"error":"wallet timeout"}', 300); // planted bug
      return send(200, 'application/json', JSON.stringify({ amount: id === 'welcome' ? '200.00 EUR' : '100.00 EUR', balance: '200.00 EUR' }), 400);
    }
    send(404, 'text/html', page('Not found', '<h1>Not found</h1>'));
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = await start(Number(process.env.PORT || 4321));
  console.log(`demo app on http://127.0.0.1:${srv.address().port}`);
}
