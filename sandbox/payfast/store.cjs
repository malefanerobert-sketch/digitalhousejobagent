'use strict';
const {DatabaseSync} = require('node:sqlite');
const {randomUUID} = require('node:crypto');
const {CATALOG, fail, cents, localDate, anniversary, maySpend, graceEnd} = require('./payfast.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A single synthetic identity. No auth IDs, production wallets or Supabase connection.
const DEMO_USER = 'sandbox-demo-only';
class Store {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sandbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL CHECK(marker='jobagent-payfast-sandbox-v1'));
      INSERT OR IGNORE INTO sandbox_meta VALUES(1,'jobagent-payfast-sandbox-v1');
      CREATE TABLE IF NOT EXISTS sandbox_wallet (
        id TEXT PRIMARY KEY CHECK(id='sandbox-demo-only'), monthly INTEGER NOT NULL DEFAULT 0 CHECK(monthly>=0),
        purchased INTEGER NOT NULL DEFAULT 0 CHECK(purchased>=0), anchor_date TEXT, due_date TEXT);
      INSERT OR IGNORE INTO sandbox_wallet(id) VALUES('sandbox-demo-only');
      CREATE TABLE IF NOT EXISTS sandbox_orders (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, package_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents>0), created_at TEXT NOT NULL,
        due_date TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','review')));
      CREATE TABLE IF NOT EXISTS sandbox_payments (
        pf_payment_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sandbox_orders(id),
        amount_cents INTEGER NOT NULL, subscription_token TEXT, received_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN('credited','review')), reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sandbox_ledger (
        id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        monthly_delta INTEGER NOT NULL, purchased_delta INTEGER NOT NULL,
        monthly_after INTEGER NOT NULL CHECK(monthly_after>=0), purchased_after INTEGER NOT NULL CHECK(purchased_after>=0), created_at TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  wallet() { return this.db.prepare('SELECT * FROM sandbox_wallet WHERE id=?').get(DEMO_USER); }
  order(id) { return this.db.prepare('SELECT * FROM sandbox_orders WHERE id=?').get(id); }
  createOrder(packageId, requestId, now = new Date()) {
    if (typeof packageId !== 'string' || typeof requestId !== 'string' || !Object.hasOwn(CATALOG, packageId) || !UUID.test(requestId)) throw fail('Select a valid package and request ID');
    const timestamp = new Date(now).toISOString();
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM sandbox_orders WHERE request_id=?').get(requestId);
      if (prior) {
        if (prior.package_id !== packageId) throw fail('Request ID belongs to a different package', 409);
        if (prior.status !== 'pending') throw fail('This checkout was already processed; refresh payment history', 409);
        if (Date.parse(timestamp) - Date.parse(prior.created_at) > 3600000) throw fail('Checkout expired; use a new request ID', 409);
        return prior;
      }
      const wallet = this.wallet();
      const product = CATALOG[packageId];
      if (product.kind === 'topup' && !maySpend(wallet, now)) throw fail('A paid, active test subscription is required for top-ups', 409);
      if (product.kind === 'subscription') {
        if (wallet.anchor_date) throw fail('A test subscription already exists. Renewal/restart needs review in this first milestone', 409);
        const pending = this.db.prepare("SELECT id FROM sandbox_orders WHERE package_id='monthly' AND (status='review' OR (status='pending' AND created_at>=?))").get(new Date(Date.parse(timestamp) - 3600000).toISOString());
        if (pending) throw fail('A subscription checkout is already pending; retry using its original request ID', 409);
      }
      const order = {id: randomUUID(), request_id: requestId, package_id: packageId, amount_cents: product.amountCents,
        created_at: timestamp, due_date: product.kind === 'subscription' ? anniversary(localDate(timestamp), 1) : null};
      this.db.prepare('INSERT INTO sandbox_orders(id,request_id,package_id,amount_cents,created_at,due_date) VALUES(?,?,?,?,?,?)')
        .run(order.id, requestId, packageId, order.amount_cents, timestamp, order.due_date);
      return this.order(order.id);
    });
  }
  appendLedger(reference, kind, monthlyDelta, purchasedDelta, now) {
    const w = this.wallet();
    this.db.prepare('INSERT INTO sandbox_ledger VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), reference, kind, monthlyDelta, purchasedDelta, w.monthly, w.purchased, new Date(now).toISOString());
  }
  // Only invoke AFTER verifyNotification (signature, merchant, source IP, PayFast server).
  // Private server module; never exposed as a client-callable credit endpoint.
  recordVerifiedPayment(data, now = new Date()) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(data.pf_payment_id || '') || !UUID.test(data.m_payment_id || '')) throw fail('Invalid payment reference');
    const amount = cents(data.amount_gross);
    if (!['COMPLETE', 'FAILED', 'CANCELLED', 'PENDING'].includes(data.payment_status)) throw fail('Unsupported payment status; manual review required');
    return this.transaction(() => {
      const order = this.order(data.m_payment_id);
      if (!order || amount !== order.amount_cents || (data.custom_str1 && data.custom_str1 !== 'jobagent-sandbox-only')) throw fail('Payment does not match the stored order');
      const prior = this.db.prepare('SELECT * FROM sandbox_payments WHERE pf_payment_id=?').get(data.pf_payment_id);
      if (prior && (prior.order_id !== order.id || prior.amount_cents !== amount || (prior.subscription_token || '') !== (data.token || ''))) throw fail('Payment ID reused with different details', 409);
      if (prior) return {outcome: prior.outcome, duplicate: true};
      if (data.payment_status !== 'COMPLETE') return {outcome: 'not_complete', duplicate: false};
      const product = CATALOG[order.package_id];
      if (product.kind === 'subscription' && !/^[A-Za-z0-9-]{36}$/.test(data.token || '')) throw fail('Missing subscription token');
      let outcome = 'credited', reason = 'verified_initial_payment';
      const w = this.wallet();
      // A second transaction against one-off checkout must NEVER mint tokens again.
      // A recurring transaction needs an authoritative cycle reconciliation adapter;
      // receipt time is not evidence of a paid billing period. Quarantine it, not a reset.
      if (order.status !== 'pending' || (product.kind === 'subscription' && w.anchor_date)) {
        outcome = 'review'; reason = product.kind === 'subscription' ? 'renewal_cycle_reconciliation_required' : 'additional_payment_on_closed_order';
      } else if (product.kind === 'subscription' && Date.parse(now) >= Date.parse(order.due_date + 'T00:00:00+02:00')) {
        outcome = 'review'; reason = 'late_initial_payment';
      }
      this.db.prepare('INSERT INTO sandbox_payments VALUES(?,?,?,?,?,?,?)')
        .run(data.pf_payment_id, order.id, amount, data.token || null, new Date(now).toISOString(), outcome, reason);
      if (outcome === 'review') {
        if (order.status === 'pending') this.db.prepare("UPDATE sandbox_orders SET status='review' WHERE id=?").run(order.id);
        return {outcome, duplicate: false};
      }
      let monthlyDelta = 0, purchasedDelta = 0;
      if (product.kind === 'subscription') {
        monthlyDelta = product.tokens - w.monthly;
        this.db.prepare('UPDATE sandbox_wallet SET monthly=?,anchor_date=?,due_date=? WHERE id=?')
          .run(product.tokens, localDate(order.created_at), order.due_date, DEMO_USER);
      } else {
        purchasedDelta = product.tokens;
        if (w.purchased + product.tokens > 2147483647) throw fail('Test wallet limit exceeded');
        // Even if the subscription expired after checkout, keep paid purchased tokens;
        // spending stays frozen. A top-up NEVER renews or changes the due date.
        this.db.prepare('UPDATE sandbox_wallet SET purchased=purchased+? WHERE id=?').run(product.tokens, DEMO_USER);
      }
      this.appendLedger('payfast:' + data.pf_payment_id, product.kind, monthlyDelta, purchasedDelta, now);
      this.db.prepare("UPDATE sandbox_orders SET status='paid' WHERE id=?").run(order.id);
      return {outcome, duplicate: false};
    });
  }
  // Pure test-wallet spending. Not wired to approval RPC or any production account.
  spend(requestId, now = new Date()) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw fail('Invalid spend request');
    return this.transaction(() => {
      const reference = 'test-spend:' + requestId;
      if (this.db.prepare('SELECT id FROM sandbox_ledger WHERE reference=?').get(reference)) return {duplicate: true};
      const w = this.wallet();
      if (!maySpend(w, now)) throw fail('Test subscription is frozen', 409);
      if (w.monthly + w.purchased < 1) throw fail('No test tokens available', 409);
      const monthlyDelta = w.monthly > 0 ? -1 : 0;
      const purchasedDelta = monthlyDelta ? 0 : -1;
      this.db.prepare('UPDATE sandbox_wallet SET monthly=monthly+?,purchased=purchased+? WHERE id=?').run(monthlyDelta, purchasedDelta, DEMO_USER);
      this.appendLedger(reference, 'test_spend', monthlyDelta, purchasedDelta, now);
      return {duplicate: false};
    });
  }
  snapshot(now = new Date()) {
    const w = this.wallet();
    const allowed = maySpend(w, now);
    const timestamp = Date.parse(now);
    return {
      mode: 'sandbox', identity: DEMO_USER, monthly: w.monthly, purchased: w.purchased,
      spendable: allowed ? w.monthly + w.purchased : 0,
      status: !w.due_date ? 'unpaid' : !allowed ? 'frozen' : timestamp >= Date.parse(w.due_date + 'T00:00:00+02:00') ? 'grace' : 'active',
      dueDate: w.due_date, graceEndsAt: w.due_date ? graceEnd(w.due_date) : null,
      history: this.db.prepare('SELECT p.pf_payment_id,p.order_id,p.amount_cents,p.received_at,p.outcome,p.reason,o.request_id,o.package_id FROM sandbox_payments p JOIN sandbox_orders o ON o.id=p.order_id ORDER BY p.received_at DESC LIMIT 30').all(),
      pendingOrders: this.db.prepare("SELECT id,request_id,package_id,created_at FROM sandbox_orders WHERE status='pending' ORDER BY created_at DESC LIMIT 10").all()
    };
  }
}
module.exports = {Store, DEMO_USER};
