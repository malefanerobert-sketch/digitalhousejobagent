'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {createApp} = require('../server.cjs');
const {Store} = require('../store.cjs');
const {signature, verifyNotification} = require('../payfast.cjs');
const NOW = new Date('2026-10-18T10:00:00Z');
const cfg = {origin: 'https://jobagent-staging.example.test', merchantId: '10000001', merchantKey: 'fixturekey',
  passphrase: 'test-only-passphrase', accessKey: 'unit-test-access-key-not-a-real-secret-1234', trustedProxies: []};
async function setup(t) {
  const store = new Store();
  // Offline fixture for DNS and PayFast VALID response; all real validation code runs.
  const verify = (raw, ip, config) => verifyNotification(raw, ip, config, {
    resolve: async () => [{address: '127.0.0.1'}], fetch: async () => ({ok: true, text: async () => 'VALID'})
  });
  const server = http.createServer(createApp({cfg, store, verify, clock: () => NOW}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); store.close();});
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (url, options = {}) => fetch(origin + url, options);
  const post = (url, body, cookie, originHeader = cfg.origin) => request(url, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: originHeader, ...(cookie ? {Cookie: cookie} : {})}, body: JSON.stringify(body)
  });
  const login = async () => {
    const response = await post('/session', {accessKey: cfg.accessKey});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const itn = async (order, extra = {}) => {
    const data = {m_payment_id: order.id, pf_payment_id: randomUUID(), payment_status: 'COMPLETE', amount_gross: (order.amount_cents / 100).toFixed(2),
      merchant_id: cfg.merchantId, ...(order.package_id === 'monthly' ? {token: '11111111-1111-4111-8111-111111111111'} : {}), ...extra};
    const entries = Object.entries(data); entries.push(['signature', signature(entries, cfg.passphrase)]);
    return request('/itn', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(entries).toString()});
  };
  return {store, request, post, login, itn};
}
test('anonymous users cannot read state or create checkout', async t => {
  const h = await setup(t);
  assert.equal((await h.request('/state')).status, 401);
  assert.equal((await h.post('/checkout', {packageId: 'monthly', requestId: randomUUID()})).status, 401);
});
test('public assets are allowlisted; no source/env/database downloads', async t => {
  const h = await setup(t);
  assert.equal((await h.request('/')).status, 200);
  for (const name of ['/server.cjs','/.env','/var/sandbox.sqlite','/store.cjs','/package.json','/../.env']) assert.equal((await h.request(name)).status, 404);
});
test('login requires correct key and matching origin; session is HttpOnly Secure Strict', async t => {
  const h = await setup(t);
  assert.equal((await h.post('/session', {accessKey: cfg.accessKey}, null, 'https://evil.example')).status, 403);
  assert.equal((await h.post('/session', {accessKey: 'wrong'})).status, 401);
  const r = await h.post('/session', {accessKey: cfg.accessKey});
  const cookie = r.headers.get('set-cookie');
  for (const flag of ['HttpOnly','Secure','SameSite=Strict']) assert(cookie.includes(flag));
  assert(!cookie.includes(cfg.accessKey));
  assert.equal((await h.request('/state', {headers: {Cookie: cookie.split(';')[0]}})).status, 200);
});
test('login is rate limited', async t => {
  const h = await setup(t);
  for (let i=0; i<6; i++) assert.equal((await h.post('/session', {accessKey: 'wrong'})).status, 401);
  assert.equal((await h.post('/session', {accessKey: 'wrong'})).status, 429);
});
test('client amount, user identity or currency cannot override catalog', async t => {
  const h = await setup(t), cookie = await h.login();
  for (const extra of [{amount: 1}, {userId: 'real-user'}, {currency: 'USD'}, {tokens: 1000000}]) {
    assert.equal((await h.post('/checkout', {packageId: 'monthly', requestId: randomUUID(), ...extra}, cookie)).status, 400);
  }
  assert.equal(h.store.wallet().monthly, 0);
});
test('signed checkout is sandbox-only and does not expose passphrase or operator key', async t => {
  const h = await setup(t), cookie = await h.login();
  const response = await h.post('/checkout', {packageId: 'monthly', requestId: randomUUID()}, cookie);
  assert.equal(response.status, 200); const text = await response.text(), data = JSON.parse(text);
  assert.equal(data.action, 'https://sandbox.payfast.co.za/eng/process'); assert.equal(data.fields.amount, '200.00');
  assert(!text.includes(cfg.passphrase)); assert(!text.includes(cfg.accessKey)); assert.equal(h.store.wallet().monthly, 0);
});
test('browser return/cancel query strings never grant test tokens', async t => {
  const h = await setup(t);
  for (const url of ['/?result=returned','/?result=cancelled','/?payment_status=COMPLETE&tokens=600']) {
    assert.equal((await h.request(url)).status, 200); assert.equal(h.store.wallet().monthly, 0);
  }
});
test('verified HTTP notification credits once; next top-up credits only purchased balance', async t => {
  const h = await setup(t), cookie = await h.login();
  const first = await (await h.post('/checkout', {packageId: 'monthly', requestId: randomUUID()}, cookie)).json();
  const order = h.store.order(first.orderId), id = randomUUID();
  assert.equal((await h.itn(order, {pf_payment_id: id})).status, 200);
  assert.equal((await h.itn(order, {pf_payment_id: id})).status, 200);
  const top = await (await h.post('/checkout', {packageId: 'topup100', requestId: randomUUID()}, cookie)).json();
  assert.equal((await h.itn(h.store.order(top.orderId))).status, 200);
  assert.equal(h.store.wallet().monthly, 600); assert.equal(h.store.wallet().purchased, 100);
});
test('forged notification and wrong amount cannot grant tokens', async t => {
  const h = await setup(t); const order = h.store.createOrder('monthly', randomUUID(), NOW);
  const forged = await h.request('/itn', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: `m_payment_id=${order.id}&pf_payment_id=1234&payment_status=COMPLETE&amount_gross=200.00&merchant_id=10000001&signature=${'0'.repeat(32)}`});
  assert.equal(forged.status, 403);
  assert.equal((await h.itn(order, {amount_gross: '1.00'})).status, 400);
  assert.equal(h.store.wallet().monthly, 0);
});
test('only notification route grants credits; there is no browser mint/spend endpoint', async t => {
  const h = await setup(t), cookie = await h.login();
  for (const endpoint of ['/credit', '/spend', '/balance', '/refund']) assert.equal((await h.post(endpoint, {amount: 1000000}, cookie)).status, 404);
  assert.equal(h.store.wallet().monthly, 0);
});
test('logout invalidates the server session', async t => {
  const h = await setup(t), cookie = await h.login();
  assert.equal((await h.post('/logout', {}, cookie)).status, 200);
  assert.equal((await h.request('/state', {headers: {Cookie: cookie}})).status, 401);
});
test('malformed, cross-origin and oversized requests are rejected', async t => {
  const h = await setup(t), cookie = await h.login();
  assert.equal((await h.post('/checkout', {packageId: 'monthly', requestId: randomUUID()}, cookie, 'https://evil.example')).status, 403);
  assert.equal((await h.request('/session', {method: 'POST', headers: {Origin: cfg.origin, 'Content-Type': 'application/json'}, body: '{broken'})).status, 400);
  assert.equal((await h.post('/session', null)).status, 401);
  assert.equal((await h.post('/session', {accessKey: 'x'.repeat(17000)})).status, 413);
});
