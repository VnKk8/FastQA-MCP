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

// ---- Fault-scenario page for the observation / quality tests -------------------------------------------------------
// Behaviour is selected with query parameters on /orders, so every scenario is deterministic:
//   notify=<status>       status of the fire-and-forget POST /api/notifications (default 200; "off" disables it)
//   notifyDelay=<ms>      delay of that response (crosses action and batch boundaries)
//   order=business|contract|undoc|slow   variants of POST /api/orders (HTTP 200 + success:false, schema mismatch, 202, slow)
//   poll=<ms>&pollStatus=<status>        background polling of GET /api/poll
//   ghost=1               success message but the order row is not added (state invariant)
//   canary=1              sends synthetic secrets in a URL, a header, the console and a JSON body (privacy tests)
export const CANARY = { token: 'CANARY-TOKEN-9f3k2', bearer: 'CANARY-BEARER-77x1', pw: 'CANARY-PW-55z8', email: 'jane.canary@example.com' };
const orders = page('Orders – DemoShop', `
<nav><a href="/account">Account</a> <a href="/orders">Orders</a></nav>
<h1>New order</h1>
<label for="product">Product</label><select id="product"><option>Blue T-shirt</option><option>Coffee mug</option></select>
<label for="qty">Quantity</label><input id="qty" type="number" value="1">
<button id="place">Place order</button>
<p id="msg" role="status"></p>
<h2>Tools</h2>
<button id="stock">Check stock</button> <span id="stockMsg" role="status"></span>
<button id="prices">Refresh prices</button> <span id="priceMsg" role="status"></span>
<button id="sync">Sync</button> <button id="print">Print</button> <button id="history">Load history</button>
<a href="/receipt" target="_blank">Open receipt</a>
<h2>Your orders</h2>
<ul id="list">
  <li>Order #1001 <button class="det">Details</button></li>
  <li>Order #1002 <button class="det">Details</button></li>
</ul>
<p id="detail" role="status"></p>
<script>
const P = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
$('place').onclick = async () => {
  const mode = P.get('order');
  const r = await fetch('/api/orders' + (mode ? '?mode=' + mode : ''), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product: $('product').value, qty: Number($('qty').value) }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 422) { $('msg').textContent = j.error; return; }
  $('msg').textContent = 'Thank you for your order'; // planted bug: shown even when the body says success:false
  if (P.get('ghost') !== '1') { const li = document.createElement('li'); li.textContent = 'Order ' + (j.orderId || '#new'); $('list').appendChild(li); }
  // fire-and-forget: the UI never looks at this response
  if (P.get('notify') !== 'off') fetch('/api/notifications?status=' + (P.get('notify') || '200') + '&delay=' + (P.get('notifyDelay') || '0'), { method: 'POST' }).catch(() => {});
  if (P.get('hang') === '1') fetch('/api/hang').catch(() => {});
  if (P.get('canary') === '1') {
    fetch('/api/track?token=${CANARY.token}&email=${CANARY.email}&page=2', { headers: { Authorization: 'Bearer ${CANARY.bearer}' } }).catch(() => {});
    fetch('/api/profile').then((x) => x.json()).catch(() => {});
    console.error('auth rejected for token ${CANARY.token}');
  }
};
$('stock').onclick = async () => { const r = await fetch('/api/stock' + (P.get('stock') === 'fail' ? '?fail=1' : '')); $('stockMsg').textContent = r.ok ? 'In stock' : 'Stock unknown'; };
$('prices').onclick = async () => { await Promise.all([fetch('/api/prices'), fetch('/api/prices')]); $('priceMsg').textContent = 'Prices updated'; };
$('sync').onclick = () => { fetch('/api/drop').catch(() => {}); };
$('print').onclick = () => { setTimeout(() => { throw new TypeError('printer is not defined'); }, 0); };
$('history').onclick = async () => { await fetch('/api/slow?ms=' + (P.get('slow') || '900')); $('detail').textContent = 'History loaded'; };
document.querySelectorAll('.det').forEach((b) => b.onclick = () => { $('detail').textContent = 'Details of ' + b.parentElement.firstChild.textContent.trim(); });
if (P.get('poll')) setInterval(() => fetch('/api/poll' + (P.get('pollStatus') ? '?status=' + P.get('pollStatus') : '')).catch(() => {}), Number(P.get('poll')));
</script>`);
const receipt = page('Receipt – DemoShop', `<h1>Receipt</h1><p id="r" role="status"></p>
<script>fetch('/api/receipt').then((x) => x.json()).then((j) => { document.getElementById('r').textContent = 'Total ' + j.total; });</script>`);

let priceCalls = 0;
function faultApi(req, res, body) {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj, delay = 0, extra = {}) => setTimeout(() => {
    const data = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extra }); res.end(data);
  }, delay);
  switch (u.pathname) {
    case '/orders': res.writeHead(200, { 'content-type': 'text/html' }); res.end(orders); return true;
    case '/receipt': res.writeHead(200, { 'content-type': 'text/html' }); res.end(receipt); return true;
    case '/api/orders': {
      const j = JSON.parse(body || '{}'); const mode = u.searchParams.get('mode');
      if (!(j.qty >= 1)) return json(422, { error: 'Quantity must be at least 1' }, 60), true;
      if (mode === 'business') return json(200, { success: false, error: 'OUT_OF_STOCK' }, 60), true;
      if (mode === 'contract') return json(201, { success: true, orderId: 1001, total: '19.99' }, 60), true; // orderId should be a string, total a number
      if (mode === 'undoc') return json(202, { success: true, orderId: 'ORD-1001', total: 19.99 }, 60), true;
      return json(201, { success: true, orderId: 'ORD-1001', total: 19.99 }, mode === 'slow' ? 700 : 60, { 'x-request-id': 'req-demo-123' }), true;
    }
    case '/api/notifications': return json(Number(u.searchParams.get('status') || 200), { queued: u.searchParams.get('status') === '200' }, Number(u.searchParams.get('delay') || 0)), true;
    case '/api/poll': return json(Number(u.searchParams.get('status') || 200), { tick: Date.now() % 1000 }, 20), true;
    case '/api/stock': res.writeHead(302, { location: '/api/stock/v2' + (u.searchParams.get('fail') ? '?fail=1' : '') }); res.end(); return true;
    case '/api/stock/v2': return json(u.searchParams.get('fail') ? 500 : 200, { stock: 5 }, 40), true;
    case '/api/prices': { const n = ++priceCalls; return json(n % 2 ? 200 : 500, { n }, n % 2 ? 30 : 250), true; }
    case '/api/drop': req.socket.destroy(); return true;
    case '/api/slow': return json(200, { rows: 3 }, Number(u.searchParams.get('ms') || 900)), true;
    case '/api/receipt': return json(200, { total: '19.99 EUR' }, 30), true;
    case '/api/track': return json(200, { ok: true }, 10), true;
    case '/api/profile': return json(200, { name: 'Jane', password: CANARY.pw, session: { token: CANARY.token }, plan: 'pro' }, 10), true;
    case '/api/hang': return true; // never answers (bounded finalization tests)
  }
  return false;
}

export function start(port = 0) {
  const srv = http.createServer(async (req, res) => {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
    const send = (code, type, data, delay = 0) => setTimeout(() => { res.writeHead(code, { 'content-type': type }); res.end(data); }, delay);
    if (faultApi(req, res, body)) return;
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

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const srv = await start(Number(process.env.PORT || 4321));
  console.log(`demo app on http://127.0.0.1:${srv.address().port}`);
}
