// Unit tests for the observed route / endpoint graph (FQA-009). Pure module: fed with synthetic observations and
// request records shaped like src/observation/types.ts, the way the Observer feeds its sinks.
// Run: npm run build && node --test bench/unit-discovery.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryGraph, mergeDiscovery, renderDiscovery, DISCOVERY_CAPS } from '../dist/discovery/graph.js';

const ORIGIN = 'http://shop.test';
const assoc = (actionId, confidence) => (actionId && confidence !== 'ambiguous'
  ? { actionId, confidence: confidence ?? 'inferred', reason: 'test' }
  : { confidence: confidence ?? 'unattributed', reason: 'test', ...(confidence === 'ambiguous' ? { candidateActionIds: [actionId ?? 'A-0', 'A-99'] } : {}) });

/** A tiny stand-in for Observer + ActionTracker: it knows actions and batches and feeds the graph like the observer does. */
function world(opts = {}) {
  const actions = new Map(); const batches = new Map();
  let clock = Date.parse(opts.start ?? '2026-11-27T10:00:00.000Z');
  let nEvent = 0; let nReq = 0;
  const sessionId = opts.sessionId ?? 'S-aaaa1111';
  const g = new DiscoveryGraph({
    sessionId, pathTemplates: opts.pathTemplates,
    describeAction: (id) => actions.get(id), scopeOf: (b) => batches.get(b)?.scope, batchKind: (b) => batches.get(b)?.kind,
    now: () => new Date((clock += 1000)).toISOString(),
  });
  const event = (kind, data, action, o = {}) => ({
    schemaVersion: 1, eventId: `E-${++nEvent}`, sessionId, batchId: o.batchId, pageId: o.pageId ?? 'P-1', action,
    sequence: nEvent, at: new Date((clock += 1000)).toISOString(), elapsedMs: nEvent * 10, kind, data,
  });
  const w = {
    g,
    batch(id, kind, scope) { batches.set(id, { kind, scope }); return w; },
    action(id, label, kind, batchId) { actions.set(id, { label, kind, batchId }); return w; },
    nav(url, o = {}) {
      const a = assoc(o.actionId, o.confidence);
      g.onEvent(event('state_change', { type: 'navigation', url }, a, { pageId: o.pageId, batchId: actions.get(o.actionId)?.batchId }));
      return w;
    },
    closePage(pageId) { g.onEvent(event('state_change', { type: 'page_closed' }, assoc(), { pageId })); return w; },
    /** request start: the observer emits a `request` event at this moment */
    start(method, path, o = {}) {
      const a = assoc(o.actionId, o.confidence);
      const batchId = actions.get(o.actionId)?.batchId;
      const origin = o.origin ?? ORIGIN;
      const rec = {
        id: `R-${++nReq}`, method, url: `${origin}${path}`, origin, path, route: o.route ?? path,
        resourceType: o.resourceType ?? 'fetch', firstParty: o.firstParty ?? true, tracked: o.tracked ?? true, navigation: false,
        pageId: o.pageId ?? 'P-1', batchId, association: a, startedMs: 0, responseMs: 5, endedMs: 9,
        status: o.status === null ? undefined : o.status ?? 200, contentType: o.contentType ?? 'application/json',
        eventIds: [], done: true,
        ...(o.body ? { body: o.body } : {}), ...(o.requestShape ? { requestShape: o.requestShape } : {}),
        ...(o.failure ? { failure: o.failure, aborted: /ABORTED/.test(o.failure) } : {}),
      };
      if (rec.tracked) {
        const ev = event('request', { requestId: rec.id, method, url: rec.url }, a, { pageId: rec.pageId, batchId });
        g.onEvent(ev); rec.eventIds.push(ev.eventId, `E-${++nEvent}`, `E-${++nEvent}`);
      }
      return rec;
    },
    done(rec) { g.onRequestDone(rec); return w; },
    req(method, path, o = {}) { return w.done(w.start(method, path, o)); },
  };
  return w;
}

/** login -> account -> add to cart, with fresh action ids per run (as a real repeat would have). */
function journey(w, run = 1) {
  const a = (n) => `A-${run * 10 + n}`; const b = (n) => `B-${run * 10 + n}`;
  w.batch(b(1), 'open').batch(b(2), 'act', 'checkout');
  w.action(a(1), 'goto "http://shop.test/login"', 'goto', b(1))
    .action(a(2), 'fill "Email" "john@example.com"', 'fill', b(2))
    .action(a(3), 'click "Log in"', 'click', b(2))
    .action(a(4), 'click "Add Blue T-shirt to cart"', 'click', b(2));
  w.nav(`${ORIGIN}/login`, { actionId: a(1), confidence: 'direct' });
  const login = w.start('POST', '/api/login', { actionId: a(3) });      // starts on /login
  w.done(login);
  w.nav(`${ORIGIN}/account`, { actionId: a(3) });                       // the click then navigates
  w.req('POST', '/api/cart/tshirt', { actionId: a(4) });
  return w;
}
const byPath = (list, path) => list.find((x) => x.path === path);
const edgeOf = (d, relation, from, to) => d.edges.find((e) => e.relation === relation && e.from === from && e.to === to);

test('routes come from navigations, per page, without query values', () => {
  const w = world();
  w.action('A-1', 'goto "http://shop.test/orders?token=CANARYQ1"', 'goto', 'B-1').batch('B-1', 'open');
  w.nav('about:blank');
  w.nav(`${ORIGIN}/orders?notify=CANARYQ2&page=2#frag`, { actionId: 'A-1', confidence: 'direct' });
  w.nav(`${ORIGIN}/orders?notify=other`);                 // same route again (reload / other query)
  w.nav(`${ORIGIN}/receipt`, { pageId: 'P-2' });          // a popup has its own current route
  w.nav(`${ORIGIN}/account`);
  const d = w.g.export();
  assert.deepEqual(d.routes.map((r) => r.path), ['/orders', '/receipt', '/account']);
  assert.equal(byPath(d.routes, '/orders').count, 2);
  assert.equal(byPath(d.routes, '/orders').origin, ORIGIN);
  assert.equal(d.edges.filter((e) => e.relation === 'navigation').length, 1, 'no self edge, no cross-page edge');
  const nav = edgeOf(d, 'navigation', byPath(d.routes, '/orders').id, byPath(d.routes, '/account').id);
  assert.equal(nav.count, 1); assert.equal(nav.confidence, 'unattributed');
  assert.ok(!JSON.stringify(d).includes('CANARYQ'), 'query values never enter the graph (route or action label)');
  assert.equal(d.actions[0].label, 'goto "http://shop.test/orders"');
});

test('a navigation is linked to the action that preceded it, on the route where it was performed', () => {
  const d = journey(world()).g.export();
  const login = byPath(d.routes, '/login'); const account = byPath(d.routes, '/account');
  const click = d.actions.find((a) => a.label === 'click "Log in"');
  assert.equal(click.route, login.id, 'the click happened on /login even though its request finished before the page moved on');
  assert.equal(click.kind, 'click'); assert.deepEqual(click.scopes, ['checkout']);
  const nav = edgeOf(d, 'navigation', login.id, account.id);
  assert.deepEqual(nav.via, [click.id]); assert.equal(nav.confidence, 'inferred');
  assert.equal(d.actions.find((a) => a.kind === 'goto').route, undefined, 'the first goto has no route before it');
  assert.ok(!d.actions.some((a) => a.kind === 'fill'), 'an action without observed effect is not a node');
});

test('endpoints are normalized: ids collapse, explicit templates win, other segments are kept', () => {
  const w = world({ pathTemplates: ['/api/users/{name}', '/products/{slug}'] });
  w.nav(`${ORIGIN}/products/blue-shirt`).nav(`${ORIGIN}/products/mug`);
  w.req('GET', '/api/orders/123', { route: '/api/orders/{id}' });
  w.req('GET', '/api/orders/456', { route: '/api/orders/{id}', status: 404 });
  w.req('GET', '/api/orders/789');                                  // raw route: the graph normalizes it the same way
  w.req('GET', '/api/users/alice').req('GET', '/api/users/bob');   // only a template can merge names
  w.req('GET', '/api/items/a').req('GET', '/api/items/b');         // no template: never merged by guesswork
  w.req('POST', '/api/orders/123', { route: '/api/orders/{id}' }); // another method is another endpoint
  const d = w.g.export();
  assert.deepEqual(d.routes.map((r) => r.path), ['/products/{slug}']);
  assert.equal(d.routes[0].count, 2);
  const orders = d.endpoints.find((e) => e.method === 'GET' && e.path === '/api/orders/{id}');
  assert.equal(orders.count, 3); assert.deepEqual(orders.statuses, [200, 404]);
  assert.equal(d.endpoints.find((e) => e.path === '/api/users/{name}').count, 2);
  assert.equal(d.endpoints.filter((e) => e.path.startsWith('/api/items/')).length, 2);
  assert.equal(d.endpoints.filter((e) => e.path === '/api/orders/{id}').length, 2);
  assert.ok(orders.evidenceIds.length >= 1 && orders.evidenceIds.length <= 3 && orders.evidenceIds.every((id) => /^E-\d+$/.test(id)));
  assert.ok(orders.firstSeen <= orders.lastSeen);
});

test('repeating a journey raises counts and creates no duplicate node or edge', () => {
  const w = world();
  journey(w, 1);
  const once = w.g.export();
  w.closePage('P-1');   // the repeat starts on a new page, as a replay in a fresh context does
  journey(w, 2);
  const twice = w.g.export();
  for (const k of ['routes', 'endpoints', 'actions', 'edges']) assert.equal(twice[k].length, once[k].length, `${k} must not grow`);
  assert.equal(new Set(twice.edges.map((e) => `${e.relation}|${e.from}|${e.to}`)).size, twice.edges.length);
  for (const e of twice.edges) assert.equal(e.count, 2 * once.edges.find((o) => o.relation === e.relation && o.from === e.from && o.to === e.to).count);
  for (const n of twice.endpoints) assert.equal(n.count, 2);
  for (const n of twice.actions) assert.equal(n.count, 2);
  assert.ok(twice.edges.every((e) => e.evidenceIds.length <= 3));
  // Repeating without leaving the page adds the one transition that is really new (/account -> /login) and nothing else.
  journey(w, 3);
  const third = w.g.export();
  assert.equal(third.actions.length, once.actions.length, 'a goto is one node wherever it was issued');
  assert.equal(third.actions.find((a) => a.kind === 'goto').count, 3);
  assert.equal(third.edges.length, once.edges.length + 1);
  const back = edgeOf(third, 'navigation', byPath(third.routes, '/account').id, byPath(third.routes, '/login').id);
  assert.equal(back.count, 1); assert.equal(back.confidence, 'direct');
});

test('requests without action context are background: counted, never attributed', () => {
  const w = world();
  w.batch('B-1', 'act').action('A-1', 'click "Refresh"', 'click', 'B-1');
  w.nav(`${ORIGIN}/orders`);
  w.req('GET', '/api/poll');                                              // unattributed
  w.req('GET', '/api/poll', { actionId: 'A-1', confidence: 'ambiguous' }); // overlaps an action: still not attributed
  let d = w.g.export();
  const poll = byPath(d.endpoints, '/api/poll');
  assert.equal(poll.count, 2); assert.equal(poll.background, 2);
  assert.equal(d.edges.filter((e) => e.relation === 'triggers').length, 0);
  assert.equal(d.actions.length, 0, 'an ambiguous association does not create an action node');
  const seen = edgeOf(d, 'observed_request', d.routes[0].id, poll.id);
  assert.equal(seen.count, 2); assert.equal(seen.confidence, 'unattributed');
  assert.deepEqual(seen.byConfidence, { unattributed: 1, ambiguous: 1 });
  w.req('GET', '/api/poll', { actionId: 'A-1' });                         // one call an action did start
  d = w.g.export();
  const trig = d.edges.filter((e) => e.relation === 'triggers');
  assert.equal(trig.length, 1); assert.equal(trig[0].count, 1); assert.equal(trig[0].confidence, 'inferred');
  assert.equal(byPath(d.endpoints, '/api/poll').background, 2);
  assert.equal(edgeOf(d, 'observed_request', d.routes[0].id, poll.id).confidence, 'unattributed', 'the weakest confidence is kept');
});

test('only tracked first-party API calls are endpoints; third-party traffic is one number', () => {
  const w = world();
  w.nav(`${ORIGIN}/orders`);
  w.req('GET', '/collect', { origin: 'https://analytics.example', firstParty: false });
  w.req('GET', '/pixel.gif', { origin: 'https://cdn.example', firstParty: false, tracked: false, resourceType: 'image' });
  w.req('GET', '/orders', { resourceType: 'document' });
  w.req('GET', '/app.js', { tracked: false, resourceType: 'script' });
  w.req('GET', '/api/stock', { failure: 'net::ERR_EMPTY_RESPONSE', status: null });
  w.req('GET', '/api/stock', { failure: 'net::ERR_ABORTED', status: null });
  const d = w.g.export();
  assert.equal(d.thirdPartyRequests, 2);
  assert.deepEqual(d.endpoints.map((e) => `${e.method} ${e.path}`), ['GET /api/stock']);
  assert.equal(d.endpoints[0].failed, 1, 'aborts are not failures');
  assert.deepEqual(d.endpoints[0].statuses, []);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('analytics.example') && !text.includes('cdn.example'));
});

test('shapes appear only when the record carries them and never contain values', () => {
  const w = world();
  w.nav(`${ORIGIN}/orders`);
  w.req('POST', '/api/orders', { status: 201 });                                              // capture off: nothing
  w.req('POST', '/api/orders', { status: 201, body: { state: 'skipped', reason: 'capture-off' } });
  let ep = w.g.export().endpoints[0];
  assert.ok(!('requestShape' in ep) && !('responseShapes' in ep));
  w.req('POST', '/api/orders', {
    status: 201, requestShape: { product: 'string', qty: 'number' },
    body: { state: 'captured', bytes: 80, json: { success: true, orderId: 'CANARY-VALUE-123', total: 19.99, items: [{ sku: 'CANARY-SKU' }], nested: { token: 'CANARY-TOKEN-9' }, note: null } },
  });
  w.req('POST', '/api/orders', { status: 422, body: { state: 'captured', bytes: 30, json: { error: 'CANARY-ERROR' } } });
  const d = w.g.export();
  ep = d.endpoints[0];
  assert.deepEqual(ep.requestShape, { product: 'string', qty: 'number' });
  assert.deepEqual(ep.responseShapes, {
    201: { success: 'boolean', orderId: 'string', total: 'number', items: [{ sku: 'string' }], nested: { token: 'string' }, note: 'null' },
    422: { error: 'string' },
  });
  assert.ok(!JSON.stringify(d).includes('CANARY'), 'no body value in the export');
  assert.ok(!JSON.stringify(w.g.journeys()).includes('CANARY'));
  assert.ok(!renderDiscovery(d).includes('CANARY'));
});

test('caps are enforced and reported as truncated with counts', () => {
  let w = world();
  for (let i = 0; i < DISCOVERY_CAPS.routes + 10; i++) w.nav(`${ORIGIN}/page-${i}`, { pageId: `P-${i % 3}` });
  let d = w.g.export();
  assert.equal(d.routes.length, DISCOVERY_CAPS.routes); assert.equal(d.dropped.routes, 10); assert.equal(d.truncated, true);

  w = world();
  w.batch('B-1', 'act');
  for (let i = 0; i < DISCOVERY_CAPS.actions + 5; i++) { w.action(`A-${i}`, `click "Item ${i}"`, 'click', 'B-1'); w.req('POST', '/api/click', { actionId: `A-${i}` }); }
  d = w.g.export();
  assert.equal(d.actions.length, DISCOVERY_CAPS.actions); assert.equal(d.dropped.actions, 5); assert.equal(d.truncated, true);
  assert.equal(d.endpoints[0].count, DISCOVERY_CAPS.actions + 5, 'the endpoint still counts every call');

  w = world();
  for (let p = 0; p < 3; p++) {
    w.nav(`${ORIGIN}/list-${p}`);
    for (let i = 0; i < DISCOVERY_CAPS.endpoints + 4; i++) w.req('GET', `/api/thing-${i}/x`);
  }
  d = w.g.export();
  assert.equal(d.endpoints.length, DISCOVERY_CAPS.endpoints); assert.equal(d.dropped.endpoints, 3 * 4);
  assert.equal(d.edges.length, DISCOVERY_CAPS.edges);
  assert.equal(d.dropped.edges, 3 * DISCOVERY_CAPS.endpoints + 2 - DISCOVERY_CAPS.edges, 'route->endpoint edges plus two navigation edges, over the cap');
  assert.equal(d.truncated, true);
  assert.equal(world().g.export().truncated, false);
});

test('merge unites sessions by stable keys, sums counts and keeps evidence traceable', () => {
  const a = journey(world({ sessionId: 'S-aaaa1111', start: '2026-11-27T10:00:00.000Z' }));
  const b = journey(world({ sessionId: 'S-bbbb2222', start: '2026-11-27T12:00:00.000Z' }));
  b.req('GET', '/api/extra', { status: 500 }).req('POST', '/api/cart/tshirt', { status: 409, actionId: 'A-14' });
  b.req('GET', '/t', { origin: 'https://other.example', firstParty: false });
  const ea = a.g.export(); const eb = b.g.export();
  const m = mergeDiscovery([ea, eb]);
  assert.equal(m.schemaVersion, 1); assert.deepEqual(m.sessions, ['S-aaaa1111', 'S-bbbb2222']);
  assert.equal(m.routes.length, 2); assert.equal(m.endpoints.length, 3); assert.equal(m.actions.length, ea.actions.length);
  assert.equal(new Set(m.edges.map((e) => `${e.relation}|${e.from}|${e.to}`)).size, m.edges.length, 'no duplicate edges');
  const cart = byPath(m.endpoints, '/api/cart/tshirt');
  assert.equal(cart.count, 3); assert.deepEqual(cart.statuses, [200, 409]);
  assert.equal(cart.firstSeen, byPath(ea.endpoints, '/api/cart/tshirt').firstSeen, 'firstSeen = earliest');
  assert.equal(cart.lastSeen, byPath(eb.endpoints, '/api/cart/tshirt').lastSeen, 'lastSeen = latest');
  assert.ok(cart.firstSeen < cart.lastSeen);
  assert.equal(byPath(m.routes, '/login').count, 2);
  assert.equal(m.thirdPartyRequests, 1);
  const ids = new Set([...m.routes, ...m.endpoints, ...m.actions].map((n) => n.id));
  for (const e of m.edges) { assert.ok(ids.has(e.from) && ids.has(e.to), 'edges point at merged ids'); for (const v of e.via ?? []) assert.ok(ids.has(v)); }
  for (const act of m.actions) if (act.route) assert.ok(ids.has(act.route));
  const evidence = [...m.routes, ...m.endpoints, ...m.edges].flatMap((n) => n.evidenceIds);
  assert.ok(evidence.length > 0 && evidence.every((id) => /^S-(aaaa1111|bbbb2222):E-\d+$/.test(id)), 'evidence ids carry their session');
  assert.ok(evidence.some((id) => id.startsWith('S-aaaa1111:')) && evidence.some((id) => id.startsWith('S-bbbb2222:')));
  const trig = m.edges.find((e) => e.relation === 'triggers' && e.to === cart.id);
  assert.equal(trig.count, 3); assert.deepEqual(trig.byConfidence, { inferred: 3 });
  // merging a merged export again neither double-prefixes nor duplicates
  const again = mergeDiscovery([m, mergeDiscovery([])]);
  assert.deepEqual(again.sessions, m.sessions);
  assert.equal(again.endpoints.length, m.endpoints.length);
  assert.ok([...again.endpoints, ...again.edges].flatMap((n) => n.evidenceIds).every((id) => (id.match(/:/g) ?? []).length === 1));
  assert.equal(mergeDiscovery([]).routes.length, 0);
});

test('journeys list each batch in order with routes before and after and the endpoints triggered', () => {
  const j = journey(world()).g.journeys();
  assert.equal(j.schemaVersion, 1); assert.equal(j.sessionId, 'S-aaaa1111');
  assert.deepEqual(j.journeys.map((x) => [x.batchId, x.kind, x.scope]), [['B-11', 'open', undefined], ['B-12', 'act', 'checkout']]);
  assert.deepEqual(j.journeys[0].steps.map((s) => [s.action, s.routeBefore, s.routeAfter]), [['goto "http://shop.test/login"', undefined, '/login']]);
  assert.deepEqual(j.journeys[1].steps.map((s) => ({ action: s.action, before: s.routeBefore, after: s.routeAfter, endpoints: s.endpoints })), [
    { action: 'click "Log in"', before: '/login', after: '/account', endpoints: ['POST /api/login'] },
    { action: 'click "Add Blue T-shirt to cart"', before: '/account', after: '/account', endpoints: ['POST /api/cart/tshirt'] },
  ]);
  assert.match(j.note, /observed/);
  JSON.stringify(j);
});

test('exports are plain JSON snapshots with the limits note', () => {
  const w = journey(world());
  const d = w.g.export();
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  assert.equal(d.kind, 'fastqa-discovery'); assert.match(d.limits, /Not a coverage measure/);
  d.routes.length = 0; d.endpoints[0].count = 999;
  assert.equal(w.g.export().routes.length, 2, 'an export is a copy');
  assert.equal(w.g.export().endpoints[0].count, 1);
  w.closePage('P-1').req('GET', '/api/after-close');
  assert.ok(!w.g.export().edges.some((e) => e.relation === 'observed_request' && e.to === byPath(w.g.export().endpoints, '/api/after-close').id), 'no route edge once the page is gone');
});

test('renderDiscovery is compact, filterable and bounded by limit', () => {
  const w = world();
  w.batch('B-1', 'act').action('A-1', 'click "Load"', 'click', 'B-1');
  w.nav(`${ORIGIN}/orders`);
  for (let i = 0; i < 50; i++) w.req('GET', `/api/list-${i}/items`, { actionId: 'A-1' });
  w.req('GET', '/api/poll').req('GET', '/x', { origin: 'https://other.example', firstParty: false });
  const d = w.g.export();
  const out = renderDiscovery(d, { limit: 5 });
  const lines = out.split('\n');
  assert.ok(lines.length <= 3 + 3 * (1 + 5), `bounded output, got ${lines.length} lines`);
  assert.match(out, /^discovery: observed activity of 1 session\(s\) S-aaaa1111/);
  assert.match(out, /1 routes · 51 endpoints · 1 actions · 101 edges · 1 third-party requests \(not listed\)/);
  assert.match(out, /endpoints \(5 of 51, 46 omitted/);
  assert.match(out, /edges \(5 of 101, 96 omitted/);
  assert.match(out, /origin: http:\/\/shop\.test/);
  const poll = renderDiscovery(d, { path: '/api/poll' });
  assert.match(poll, /EP51 GET \/api\/poll → 200 ×1 \(1 without an action: background or unknown\)/);
  assert.ok(!poll.includes('/api/list-3/'));
  assert.match(poll, /R1 \/orders → EP51 GET \/api\/poll · observed_request ×1 \(unattributed\)/);
  assert.ok(renderDiscovery(d).split('\n').length <= 3 + 3 * 31, 'default limit is 30 per section');
  assert.match(renderDiscovery(d, { path: '/nothing' }), /endpoints: none matching "\/nothing"/);
  assert.match(renderDiscovery(d, { limit: 100 }), /AC1 click "Load" → EP1 GET \/api\/list-0\/items · triggers ×1 \(inferred\)/);
});
