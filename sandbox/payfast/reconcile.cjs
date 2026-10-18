'use strict';
const {createHash} = require('node:crypto');
const {encode, money, fail} = require('./payfast.cjs');
// Read-only Sandbox recovery, NOT a browser-return credit path.
// The caller is trusted server/operator code with private merchant credentials.
async function queryPaidTransaction(order, paymentId, cfg, deps = {}) {
  if (!/^\d{1,20}$/.test(String(paymentId))) throw fail('Invalid provider payment reference');
  const headers = {'merchant-id': cfg.merchantId, version: 'v1',
    timestamp: new Date(deps.now || Date.now()).toISOString().slice(0, 19) + '+00:00'};
  const fields = {...headers, passphrase: cfg.passphrase};
  const query = Object.keys(fields).sort().map(k => `${k}=${encode(fields[k])}`).join('&');
  const signature = createHash('md5').update(query).digest('hex');
  let response, json;
  try {
    response = await (deps.fetch || fetch)(`https://api.payfast.co.za/process/query/${paymentId}?testing=true`, {
      headers: {...headers, signature}, redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    json = await response.json();
  } catch { throw fail('Authoritative payment lookup temporarily unavailable', 503); }
  const p = json?.data?.response;
  if (!response.ok || json?.status !== 'success' || !p || p.status !== 'COMPLETE'
    || String(p.pf_payment_id) !== String(paymentId) || p.m_payment_id !== order.id
    || !Number.isSafeInteger(p.amount) || p.amount !== order.amount_cents
    || (p.currency && p.currency !== 'ZAR')) throw fail('Provider payment is not a confirmed matching order', 409);
  // A transaction_token is NOT assumed to be a recurring subscription token.
  // Keep the subscription link pending until a genuine verified ITN supplies it.
  return {m_payment_id: order.id, pf_payment_id: String(paymentId), payment_status: 'COMPLETE', amount_gross: money(p.amount)};
}
module.exports = {queryPaidTransaction};
