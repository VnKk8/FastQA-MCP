// Tiny demo shop for testing fastqa: login -> account page -> add products to the cart (async API) -> checkout.
import http from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto}label{display:block;margin:8px 0}
.card{border:1px solid #ccc;padding:12px;margin:10px 0;border-radius:8px}.hidden{display:none}</style></head><body>${body}</body></html>`;

const login = page('Login – DemoShop', `
<nav><a href="/">Home</a> <a href="/products">Products</a> <a href="/help">Help</a></nav>
<h1>Sign in</h1>
<form id="f">
  <label for="email">Email</label><input id="email" type="email" required>
  <label for="pw">Password</label><input id="pw" type="password" required>
  <label><input type="checkbox" id="remember"> Remember me</label>
  <button type="submit" data-testid="login-btn">Log in</button>
</form>
<div id="err" role="alert"></div>
<footer><p>Free returns within 30 days.</p><a href="/terms">Terms</a> <a href="/privacy">Privacy</a></footer>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', {method:'POST', body: JSON.stringify({email: email.value, pw: pw.value})});
  if (r.ok) location.href = '/account'; else document.getElementById('err').textContent = 'Invalid email or password';
};
</script>`);

const products = [
  ['tshirt', 'Blue T-shirt', '19.99 EUR'],
  ['mug', 'Coffee mug', '9.99 EUR'],
  ['hoodie', 'Grey hoodie', '39.99 EUR'],
];
const account = page('Account – DemoShop', `
<nav><a href="/account">Account</a> <a href="/products">Products</a> <a href="/orders">Orders</a> <button aria-label="Account menu">👤</button></nav>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><h1>Welcome back, John</h1>
<p>Cart total: <strong id="total">0.00 EUR</strong></p>
<label for="cur">Currency</label>
<select id="cur"><option>EUR</option><option>GBP</option><option>USD</option></select>
<h2>Recommended for you</h2>
${products.map(([id, name, price]) => `<div class="card" id="card-${id}"><h3>${name}</h3><p>${price}</p>
<label><input type="checkbox" class="tc" data-p="${id}"> I have checked the size and colour</label>
<button data-p="${id}" class="add" disabled>Add ${name} to cart</button><span class="st" role="status"></span></div>`).join('')}
<script>
document.querySelectorAll('.tc').forEach(cb => cb.onchange = () => {
  document.querySelector('button.add[data-p="'+cb.dataset.p+'"]').disabled = !cb.checked;
});
document.querySelectorAll('.add').forEach(b => b.onclick = async () => {
  b.disabled = true; b.textContent = 'Adding…';
  const r = await fetch('/api/cart/' + b.dataset.p, {method:'POST'});
  const st = b.parentElement.querySelector('.st');
  if (r.ok) { const j = await r.json(); st.textContent = 'Added to cart: ' + j.name; b.remove(); document.getElementById('total').textContent = j.total; }
  else { st.textContent = 'Could not add to cart'; b.disabled = false; b.textContent = 'Retry'; console.error('add to cart failed', r.status); }
});
</script>`);

// Checkout: open shadow DOM web component + cross-origin iframe (served from "localhost" while the page is on 127.0.0.1)
// that itself contains a shadow DOM field and a nested 3DS iframe.
const checkout = (port) => page('Checkout – DemoShop', `
<h1>Checkout</h1>
<coupon-box></coupon-box>
<iframe title="Payment" src="http://localhost:${port}/pay-frame" style="width:600px;height:360px;border:1px solid #999"></iframe>
<p id="result" role="status"></p>
<script>
customElements.define('coupon-box', class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<h3>Coupon</h3><label for="cc">Coupon code</label><input id="cc"><button>Apply coupon</button><span role="status"></span>';
    r.querySelector('button').onclick = () => {
      r.querySelector('[role=status]').textContent = r.querySelector('#cc').value === 'SAVE10' ? 'Coupon applied: 10% off' : 'Unknown coupon code';
    };
  }
});
addEventListener('message', (e) => { if (e.data?.paid) document.getElementById('result').textContent = 'Thank you for your order: ' + e.data.paid; });
</script>`);

const payFrame = page('Payment frame', `
<h2>Payment</h2>
<label for="holder">Card holder</label><input id="holder">
<card-field></card-field>
<label for="ship">Shipping</label><select id="ship"><option>Standard</option><option>Express</option><option>Next day</option></select>
<button id="pay">Pay now</button>
<div id="tds"></div>
<script>
customElements.define('card-field', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label>Card number <input name="cc" inputmode="numeric"></label>'; }
});
pay.onclick = () => {
  const cc = document.querySelector('card-field').shadowRoot.querySelector('input').value;
  if (!holder.value || cc.length < 12) { tds.textContent = 'Please fill in card details'; tds.setAttribute('role','alert'); return; }
  tds.innerHTML = '<iframe title="3-D Secure" src="/3ds?ship=' + encodeURIComponent(ship.value) + '" style="width:400px;height:120px"></iframe>';
};
</script>`);

const tds = page('3DS', `<p>Bank verification</p><button id="ok">Confirm payment</button>
<script>ok.onclick = () => window.top.postMessage({ paid: new URLSearchParams(location.search).get('ship') + ' shipping' }, '*');</script>`);

export function start(port = 0) {
  const srv = http.createServer(async (req, res) => {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
    const send = (code, type, data, delay = 0) => setTimeout(() => { res.writeHead(code, { 'content-type': type }); res.end(data); }, delay);
    if (req.url === '/' || req.url === '/login') return send(200, 'text/html', login);
    if (req.url === '/account') return send(200, 'text/html', account);
    if (req.url === '/checkout') return send(200, 'text/html', checkout(srv.address().port));
    if (req.url === '/pay-frame') return send(200, 'text/html', payFrame);
    if (req.url?.startsWith('/3ds')) return send(200, 'text/html', tds);
    if (req.url === '/api/login') {
      const j = JSON.parse(body || '{}');
      return j.pw === 'secret123' ? send(200, 'application/json', '{}', 250) : send(401, 'application/json', '{}', 250);
    }
    if (req.url?.startsWith('/api/cart/')) {
      const id = req.url.split('/').pop();
      if (id === 'hoodie') return send(500, 'application/json', '{"error":"inventory timeout"}', 300); // planted bug
      const p = products.find(([pid]) => pid === id);
      if (!p) return send(404, 'application/json', '{"error":"unknown product"}');
      return send(200, 'application/json', JSON.stringify({ name: p[1], total: p[2] }), 400);
    }
    send(404, 'text/html', page('Not found', '<h1>Not found</h1>'));
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = await start(Number(process.env.PORT || 4321));
  console.log(`demo app on http://127.0.0.1:${srv.address().port}`);
}
