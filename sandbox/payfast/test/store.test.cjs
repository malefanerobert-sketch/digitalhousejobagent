'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store} = require('../store.cjs');
const NOW = new Date('2026-10-18T10:00:00Z');
const TOKEN = '11111111-1111-4111-8111-111111111111';
function store(t) {const s = new Store(); t.after(() => s.close()); return s;}
function payment(order, extra = {}) {
  return {m_payment_id: order.id, pf_payment_id: randomUUID(), payment_status: 'COMPLETE', amount_gross: (order.amount_cents / 100).toFixed(2),
    ...(order.package_id === 'monthly' ? {token: TOKEN} : {}), ...extra};
}
function subscribe(s) {const o = s.createOrder('monthly', randomUUID(), NOW); s.recordVerifiedPayment(payment(o), NOW); return o;}
test('synthetic wallet starts with zero and does not grant welcome tokens', t => {
  const s = store(t); const w = s.snapshot(NOW);
  assert.equal(w.monthly, 0); assert.equal(w.purchased, 0); assert.equal(w.spendable, 0); assert.equal(w.status, 'unpaid');
});
test('order uses server price and reuses idempotency key; mismatched package rejected', t => {
  const s = store(t), request = randomUUID(); const a = s.createOrder('monthly', request, NOW);
  assert.equal(s.createOrder('monthly', request, NOW).id, a.id);
  assert.throws(() => s.createOrder('topup100', request, NOW), /different package/);
  assert.equal(a.amount_cents, 20000); assert.equal(a.due_date, '2026-11-18');
  assert.throws(() => s.createOrder('monthly', randomUUID(), NOW), /pending/);
  assert.throws(() => s.createOrder('arbitrary', randomUUID(), NOW));
  assert.throws(() => s.createOrder('monthly', 'bad-id', NOW));
});
test('expired order cannot be silently retried under the same key', t => {
  const s = store(t), request = randomUUID(); s.createOrder('monthly', request, NOW);
  assert.throws(() => s.createOrder('monthly', request, new Date(+NOW + 3600001)), /expired/);
});
test('confirmed initial subscription grants exactly 600 monthly test tokens', t => {
  const s = store(t); const order = subscribe(s); const state = s.snapshot(NOW);
  assert.equal(state.monthly, 600); assert.equal(state.purchased, 0); assert.equal(state.status, 'active');
  assert.equal(s.order(order.id).status, 'paid'); assert.equal(state.history.length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sandbox_ledger').get().n, 1);
});
test('same payment delivered repeatedly credits once', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW), p = payment(o);
  s.recordVerifiedPayment(p, NOW);
  for (let i = 0; i < 20; i++) assert(s.recordVerifiedPayment(p, NOW).duplicate);
  assert.equal(s.wallet().monthly, 600); assert.equal(s.snapshot(NOW).history.length, 1);
});
test('wrong amount, unknown order and missing subscription token grant nothing', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW);
  for (const extra of [{amount_gross: '1.00'}, {m_payment_id: randomUUID()}, {token: ''}, {custom_str1: 'live-order'}]) {
    assert.throws(() => s.recordVerifiedPayment(payment(o, extra), NOW));
  }
  assert.equal(s.wallet().monthly, 0); assert.equal(s.snapshot(NOW).history.length, 0);
});
test('non-complete payment adds nothing, but later COMPLETE can credit', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW), p = payment(o);
  assert.equal(s.recordVerifiedPayment({...p, payment_status: 'FAILED'}, NOW).outcome, 'not_complete');
  assert.equal(s.wallet().monthly, 0);
  s.recordVerifiedPayment(p, NOW); assert.equal(s.wallet().monthly, 600);
  // Out-of-order old failure does not reverse a confirmed charge.
  assert(s.recordVerifiedPayment({...p, payment_status: 'FAILED'}, NOW).duplicate);
  assert.equal(s.wallet().monthly, 600);
});
test('unknown or refund-like statuses do not silently mutate the wallet', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW);
  assert.throws(() => s.recordVerifiedPayment(payment(o, {payment_status: 'REFUNDED'}), NOW), /manual review/);
  assert.equal(s.wallet().monthly, 0);
});
test('top-ups require an active test subscription and remain separate', t => {
  const s = store(t);
  assert.throws(() => s.createOrder('topup100', randomUUID(), NOW), /active/);
  subscribe(s);
  for (const [id, expected] of [['topup100',100],['topup200',300],['topup300',600]]) {
    const o = s.createOrder(id, randomUUID(), NOW); s.recordVerifiedPayment(payment(o), NOW);
    assert.equal(s.wallet().purchased, expected); assert.equal(s.wallet().monthly, 600);
  }
  assert.equal(s.wallet().due_date, '2026-11-18');
});
test('spending uses monthly first and same request never spends twice', t => {
  const s = store(t); subscribe(s);
  const o = s.createOrder('topup100', randomUUID(), NOW); s.recordVerifiedPayment(payment(o), NOW);
  const id = randomUUID(); s.spend(id, NOW); assert(s.spend(id, NOW).duplicate);
  assert.equal(s.wallet().monthly, 599); assert.equal(s.wallet().purchased, 100);
  for (let i=0; i<599; i++) s.spend(randomUUID(), NOW);
  s.spend(randomUUID(), NOW); assert.equal(s.wallet().monthly, 0); assert.equal(s.wallet().purchased, 99);
});
test('grace permits spending, exact expiry freezes without erasing purchased tokens', t => {
  const s = store(t); subscribe(s);
  const o = s.createOrder('topup100', randomUUID(), NOW); s.recordVerifiedPayment(payment(o), NOW);
  const grace = new Date('2026-11-20T21:59:59Z'), expired = new Date('2026-11-20T22:00:00Z');
  assert.equal(s.snapshot(grace).status, 'grace'); s.spend(randomUUID(), grace);
  assert.equal(s.snapshot(expired).status, 'frozen'); assert.equal(s.snapshot(expired).spendable, 0);
  assert.equal(s.snapshot(expired).purchased, 100);
  assert.throws(() => s.spend(randomUUID(), expired), /frozen/);
  assert.throws(() => s.createOrder('topup100', randomUUID(), expired), /active/);
});
test('late completed top-up is preserved, but cannot reactivate subscription', t => {
  const s = store(t); subscribe(s); const o = s.createOrder('topup100', randomUUID(), NOW);
  const late = new Date('2026-12-01T10:00:00Z'); s.recordVerifiedPayment(payment(o), late);
  assert.equal(s.wallet().purchased, 100); assert.equal(s.wallet().due_date, '2026-11-18');
  assert.equal(s.snapshot(late).spendable, 0);
});
test('additional transaction on same top-up order is quarantined, not credited', t => {
  const s = store(t); subscribe(s); const o = s.createOrder('topup100', randomUUID(), NOW);
  s.recordVerifiedPayment(payment(o), NOW);
  assert.equal(s.recordVerifiedPayment(payment(o), NOW).outcome, 'review'); assert.equal(s.wallet().purchased, 100);
});
test('renewal notifications held for cycle reconciliation, not assigned by arrival time', t => {
  const s = store(t); const o = subscribe(s); s.spend(randomUUID(), NOW);
  const renewal = payment(o); const later = new Date('2026-11-18T10:00:00Z');
  assert.equal(s.recordVerifiedPayment(renewal, later).outcome, 'review');
  assert.equal(s.wallet().monthly, 599); assert.equal(s.wallet().due_date, '2026-11-18');
  assert(s.recordVerifiedPayment(renewal, later).duplicate);
});
test('late initial subscription is quarantined rather than inventing anniversary', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW);
  assert.equal(s.recordVerifiedPayment(payment(o), new Date('2026-12-01T10:00:00Z')).outcome, 'review');
  assert.equal(s.wallet().monthly, 0); assert.equal(s.order(o.id).status, 'review');
});
test('same provider payment ID cannot be reassigned to a different order', t => {
  const s = store(t); subscribe(s);
  const a = s.createOrder('topup100', randomUUID(), NOW), b = s.createOrder('topup100', randomUUID(), NOW), p = payment(a);
  s.recordVerifiedPayment(p, NOW);
  assert.throws(() => s.recordVerifiedPayment({...p, m_payment_id: b.id}, NOW), /reused/);
  assert.equal(s.wallet().purchased, 100);
});
test('failed ledger write rolls back receipt, wallet and order status atomically', t => {
  const s = store(t), o = s.createOrder('monthly', randomUUID(), NOW);
  s.db.exec("CREATE TEMP TRIGGER test_fail BEFORE INSERT ON sandbox_ledger BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  const p = payment(o); assert.throws(() => s.recordVerifiedPayment(p, NOW), /fixture failure/);
  assert.equal(s.wallet().monthly, 0); assert.equal(s.snapshot(NOW).history.length, 0); assert.equal(s.order(o.id).status, 'pending');
  s.db.exec('DROP TRIGGER test_fail'); s.recordVerifiedPayment(p, NOW); assert.equal(s.wallet().monthly, 600);
});
test('SQLite uniqueness survives reopening and duplicate delivery from another connection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobagent-test-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'fixture.sqlite'), a = new Store(file), b = new Store(file);
  t.after(() => {a.close(); b.close();});
  const o = a.createOrder('monthly', randomUUID(), NOW), p = payment(o);
  a.recordVerifiedPayment(p, NOW); assert(b.recordVerifiedPayment(p, NOW).duplicate); assert.equal(b.wallet().monthly, 600);
});
test('history exposes no provider subscription token', t => {
  const s = store(t); subscribe(s);
  assert(!JSON.stringify(s.snapshot(NOW)).includes(TOKEN));
});
test('existing subscription cannot create a second automatic subscription', t => {
  const s = store(t); subscribe(s);
  assert.throws(() => s.createOrder('monthly', randomUUID(), NOW), /already exists/);
  assert.throws(() => s.createOrder('monthly', randomUUID(), new Date('2027-01-01T00:00:00Z')), /already exists/);
});
