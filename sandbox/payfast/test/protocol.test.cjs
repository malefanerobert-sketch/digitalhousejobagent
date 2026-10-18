'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const p = require('../payfast.cjs');
const env = {PAYFAST_MODE: 'sandbox', SANDBOX_MERCHANT_ID: '10000001', SANDBOX_MERCHANT_KEY: 'fixturekey',
  SANDBOX_PASSPHRASE: 'test-only-passphrase', SANDBOX_ACCESS_KEY: 'unit-test-access-key-not-a-real-secret-1234',
  SANDBOX_PUBLIC_ORIGIN: 'https://jobagent-staging.example.test'};
const cfg = p.config(env);
function notification(extra = {}) {
  const data = {m_payment_id: '11111111-1111-4111-8111-111111111111', pf_payment_id: '1234', payment_status: 'COMPLETE',
    item_name: 'Job Agent', item_description: '', amount_gross: '200.00', amount_fee: '-4.00', merchant_id: cfg.merchantId, ...extra};
  const entries = Object.entries(data); entries.push(['signature', p.signature(entries, cfg.passphrase)]);
  return new URLSearchParams(entries).toString();
}
const resolve = async () => [{address: '192.0.2.8'}];
const validate = async (url, options) => {
  assert.equal(url, p.VALIDATE_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert(!options.body.includes('passphrase')); assert(!options.body.includes('signature='));
  return {ok: true, text: async () => 'VALID'};
};
test('PHP-compatible encoding including space, apostrophe, tilde and UTF-8', () => {
  assert.equal(p.encode("A B+~!*'()/é"), 'A+B%2B%7E%21%2A%27%28%29%2F%C3%A9');
});
test('signature preserves protocol field order and includes empty ITN fields', () => {
  const entries = [['b', ' two '], ['empty', ''], ['a', 'A+B']];
  assert.equal(p.paramString(entries), 'b=two&empty=&a=A%2BB');
  assert.equal(p.signature(entries, 'salt'), createHash('md5').update('b=two&empty=&a=A%2BB&passphrase=salt').digest('hex'));
  assert.equal(p.paramString(entries, true), 'b=two&a=A%2BB');
});
test('notification parses duplicate, malformed and missing fields fail closed', () => {
  assert.throws(() => p.parseNotification(notification() + '&amount_gross=1.00'), /duplicate/);
  assert.throws(() => p.parseNotification('merchant_id=%bad%'), /Malformed/);
  assert.throws(() => p.parseNotification('merchant_id=10000001'), /Missing/);
  assert.throws(() => p.parseNotification('x'.repeat(16385)), /size/);
  assert.throws(() => p.parseNotification(notification().replace('signature=', 'signature=ABC')), /signature/);
});
test('money parsing uses exact integer cents and rejects loose or negative numbers', () => {
  assert.equal(p.cents('50.00'), 5000); assert.equal(p.money(20000), '200.00');
  for (const value of ['50', '50.0', '50.001', '-50.00', '50.00x', '5e1', ' 50.00']) assert.throws(() => p.cents(value));
});
test('catalog contains only agreed ZAR amounts and token counts', () => {
  assert.deepEqual(Object.values(p.CATALOG).map(v => [v.amountCents, v.tokens]), [[20000,600],[5000,100],[10000,200],[15000,300]]);
});
test('only sandbox configuration accepted; no live mode switch', () => {
  assert.throws(() => p.config({...env, PAYFAST_MODE: 'live'}), /sandbox/);
  for (const origin of ['https://jobagent.digitalhousegroup.co.za', 'https://jobagent.digitalhousegroup.co.za.',
    'https://malefanerobert-sketch.github.io', 'https://celylskveytdwvuvsuvx.supabase.co', 'http://test.example',
    'https://localhost', 'https://127.0.0.1', 'https://x.example/path', 'https://a:b@x.example']) {
    assert.throws(() => p.config({...env, SANDBOX_PUBLIC_ORIGIN: origin}), origin);
  }
  assert.throws(() => p.config({...env, SANDBOX_ACCESS_KEY: 'short'}), /access key/);
  assert.throws(() => p.config({...env, SANDBOX_PASSPHRASE: ''}), /passphrase/);
  assert.throws(() => p.config({...env, SANDBOX_TRUSTED_PROXY_IPS: '0.0.0.0'}), /proxies/);
});
test('checkout contains fixed server-side prices, sandbox URL and monthly recurring fields', () => {
  const order = {id: '11111111-1111-4111-8111-111111111111', package_id: 'monthly', amount_cents: 20000, due_date: '2026-11-18'};
  const checkout = p.checkoutFields(order, cfg);
  assert.equal(checkout.action, p.CHECKOUT_URL);
  assert.equal(checkout.fields.amount, '200.00'); assert.equal(checkout.fields.frequency, '3');
  assert.equal(checkout.fields.subscription_type, '1'); assert.equal(checkout.fields.cycles, '0');
  assert.equal(checkout.fields.billing_date, '2026-11-18'); assert.equal(checkout.fields.recurring_amount, '200.00');
  assert(!JSON.stringify(checkout).includes(cfg.passphrase));
  assert.throws(() => p.checkoutFields({...order, amount_cents: 1}, cfg));
  const topup = p.checkoutFields({...order, package_id: 'topup100', amount_cents: 5000}, cfg);
  assert.equal(topup.fields.amount, '50.00'); assert(!Object.hasOwn(topup.fields, 'subscription_type'));
});
test('billing anniversaries retain original month-end day and leap-year behavior', () => {
  assert.equal(p.anniversary('2026-01-31', 1), '2026-02-28');
  assert.equal(p.anniversary('2026-01-31', 2), '2026-03-31');
  assert.equal(p.anniversary('2028-01-31', 1), '2028-02-29');
  assert.equal(p.anniversary('2026-12-31', 1), '2027-01-31');
  assert.throws(() => p.anniversary('2026-02-31', 1));
});
test('Johannesburg calendar date and exact three-day grace boundary', () => {
  assert.equal(p.localDate('2026-10-17T22:30:00Z'), '2026-10-18');
  const w = {due_date: '2026-11-18'};
  assert.equal(p.graceEnd(w.due_date), '2026-11-20T22:00:00.000Z');
  assert(p.maySpend(w, '2026-11-20T21:59:59Z'));
  assert(!p.maySpend(w, '2026-11-20T22:00:00Z'));
});
test('untrusted clients cannot spoof source IP through forwarding headers', () => {
  assert.equal(p.clientIP('198.51.100.1', '192.0.2.8', []), '198.51.100.1');
  assert.equal(p.clientIP('::ffff:127.0.0.1', '192.0.2.8, 127.0.0.2', ['127.0.0.1','127.0.0.2']), '192.0.2.8');
  assert.equal(p.clientIP('127.0.0.1', '192.0.2.8, 198.51.100.1', ['127.0.0.1']), '198.51.100.1');
  assert.throws(() => p.clientIP('127.0.0.1', '', ['127.0.0.1']), /Missing/);
});
test('valid notification requires all source, signature, merchant and server checks', async () => {
  const data = await p.verifyNotification(notification(), '192.0.2.8', cfg, {resolve, fetch: validate});
  assert.equal(data.amount_gross, '200.00');
});
test('tampered signature is rejected before contacting provider', async () => {
  let calls = 0;
  await assert.rejects(p.verifyNotification(notification().replace('200.00', '0.01'), '192.0.2.8', cfg,
    {resolve, fetch: async () => {calls++;}}), /signature/);
  assert.equal(calls, 0);
});
test('wrong merchant and currency fail closed', async () => {
  await assert.rejects(p.verifyNotification(notification({merchant_id: '10000002'}), '192.0.2.8', cfg, {resolve, fetch: validate}), /merchant/);
  await assert.rejects(p.verifyNotification(notification({currency: 'USD'}), '192.0.2.8', cfg, {resolve, fetch: validate}), /currency/);
});
test('invalid source and DNS failures do not validate or credit', async () => {
  await assert.rejects(p.verifyNotification(notification(), '198.51.100.1', cfg, {resolve, fetch: validate}), /source/);
  await assert.rejects(p.verifyNotification(notification(), '192.0.2.8', cfg, {resolve: async () => {throw Error('DNS');}, fetch: validate}), e => e.status === 503);
});
test('provider INVALID, HTTP error and network failure request a retry without credit', async () => {
  for (const fetcher of [async () => ({ok: true, text: async () => 'INVALID'}), async () => ({ok: false}), async () => {throw Error('offline');}]) {
    await assert.rejects(p.verifyNotification(notification(), '192.0.2.8', cfg, {resolve, fetch: fetcher}), e => e.status === 503);
  }
});
