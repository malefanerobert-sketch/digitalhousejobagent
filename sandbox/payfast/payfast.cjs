'use strict';
const {createHash, timingSafeEqual} = require('node:crypto');
const {lookup} = require('node:dns/promises');
const {isIP} = require('node:net');
const CHECKOUT_URL = 'https://sandbox.payfast.co.za/eng/process';
const VALIDATE_URL = 'https://sandbox.payfast.co.za/eng/query/validate';
const PAYFAST_DOMAINS = ['sandbox.payfast.co.za', 'www.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];
const CATALOG = Object.freeze({
  monthly: Object.freeze({amountCents: 20000, tokens: 600, kind: 'subscription', name: 'JobAgent monthly - TEST ONLY'}),
  topup100: Object.freeze({amountCents: 5000, tokens: 100, kind: 'topup', name: 'JobAgent 100 tokens - TEST ONLY'}),
  topup200: Object.freeze({amountCents: 10000, tokens: 200, kind: 'topup', name: 'JobAgent 200 tokens - TEST ONLY'}),
  topup300: Object.freeze({amountCents: 15000, tokens: 300, kind: 'topup', name: 'JobAgent 300 tokens - TEST ONLY'})
});
function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}
// PHP urlencode semantics: uppercase hex, space -> +, including encoding ~!*'().
function encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
}
function paramString(entries, skipEmpty = false) {
  return entries.filter(([key, value]) => key !== 'signature' && (!skipEmpty || String(value).trim() !== ''))
    .map(([key, value]) => `${key}=${encode(String(value).trim())}`).join('&');
}
function signature(entries, passphrase, skipEmpty = false) {
  const base = paramString(entries, skipEmpty);
  return createHash('md5').update(base + '&passphrase=' + encode(passphrase)).digest('hex');
}
function parseNotification(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) throw fail('Invalid notification size');
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) throw fail('Malformed notification encoding');
  const entries = [...new URLSearchParams(raw)];
  const seen = new Set();
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_]+$/.test(key) || seen.has(key) || value.includes('\uFFFD')) throw fail('Invalid or duplicate notification field');
    seen.add(key);
  }
  const data = Object.fromEntries(entries);
  for (const key of ['m_payment_id', 'pf_payment_id', 'payment_status', 'merchant_id', 'amount_gross', 'signature']) {
    if (!data[key]) throw fail('Missing notification field');
  }
  if (!/^[a-f0-9]{32}$/.test(data.signature)) throw fail('Invalid signature');
  return {entries, data};
}
function money(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw fail('Invalid amount');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function cents(value) {
  if (!/^\d{1,9}\.\d{2}$/.test(value)) throw fail('Invalid payment amount');
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}
function localDate(instant) {
  const d = new Date(new Date(instant).getTime() + 2 * 60 * 60 * 1000);
  if (!Number.isFinite(d.getTime())) throw fail('Invalid date');
  return d.toISOString().slice(0, 10);
}
// Always calculate from the original anniversary, so Jan 31 -> Feb 28 -> Mar 31.
function anniversary(date, months) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(months) || months < 0) throw fail('Invalid anniversary');
  const [y, m, day] = date.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10) !== date) throw fail('Invalid anniversary');
  const month = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
function graceEnd(dueDate) { return new Date(Date.parse(dueDate + 'T00:00:00+02:00') + 3 * 86400000).toISOString(); }
function maySpend(wallet, now = new Date()) {
  return Boolean(wallet.due_date && Date.parse(now) < Date.parse(graceEnd(wallet.due_date)));
}
function config(env) {
  if (env.PAYFAST_MODE !== 'sandbox') throw fail('PAYFAST_MODE must be sandbox');
  const merchantId = env.SANDBOX_MERCHANT_ID || '';
  const merchantKey = env.SANDBOX_MERCHANT_KEY || '';
  const passphrase = env.SANDBOX_PASSPHRASE || '';
  const accessKey = env.SANDBOX_ACCESS_KEY || '';
  if (!/^\d{8}$/.test(merchantId) || !/^[A-Za-z0-9]{5,80}$/.test(merchantKey)) throw fail('Set your Sandbox merchant credentials');
  if (!/^[A-Za-z0-9_/.\-]{8,128}$/.test(passphrase)) throw fail('Set a Sandbox passphrase: 8-128 letters, numbers or -_/.');
  if (accessKey.length < 32 || accessKey.trim() !== accessKey) throw fail('Set a separate random Sandbox access key, at least 32 characters');
  let url;
  try { url = new URL(env.SANDBOX_PUBLIC_ORIGIN); } catch { throw fail('Set a dedicated HTTPS staging origin'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || isIP(hostname)
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname === 'jobagent.digitalhousegroup.co.za' || hostname.endsWith('.supabase.co')
    || hostname === 'malefanerobert-sketch.github.io') throw fail('Use a dedicated HTTPS staging origin, never the live application');
  const trustedProxies = (env.SANDBOX_TRUSTED_PROXY_IPS || '').split(',').filter(Boolean).map(normalizeIP);
  if (trustedProxies.some(ip => !isIP(ip) || ip === '0.0.0.0' || ip === '::')) throw fail('Trusted proxies must be exact IP addresses');
  return {merchantId, merchantKey, passphrase, accessKey, origin: url.origin, trustedProxies};
}
function checkoutFields(order, cfg) {
  const product = CATALOG[order.package_id];
  if (!product || order.amount_cents !== product.amountCents) throw fail('Invalid stored package');
  const entries = [
    ['merchant_id', cfg.merchantId], ['merchant_key', cfg.merchantKey],
    ['return_url', cfg.origin + '/?result=returned'], ['cancel_url', cfg.origin + '/?result=cancelled'],
    ['notify_url', cfg.origin + '/itn'], ['m_payment_id', order.id],
    ['amount', money(product.amountCents)], ['item_name', product.name],
    ['custom_str1', 'jobagent-sandbox-only']
  ];
  if (product.kind === 'subscription') entries.push(
    ['subscription_type', '1'], ['billing_date', order.due_date],
    ['recurring_amount', money(product.amountCents)], ['frequency', '3'], ['cycles', '0']
  );
  entries.push(['signature', signature(entries, cfg.passphrase, true)]);
  return {action: CHECKOUT_URL, fields: Object.fromEntries(entries)};
}
function normalizeIP(value = '') { return value.startsWith('::ffff:') ? value.slice(7) : value; }
function clientIP(remoteAddress, forwardedFor, trustedProxies = []) {
  const remote = normalizeIP(remoteAddress);
  if (!trustedProxies.includes(remote)) return remote;
  const chain = String(forwardedFor || '').split(',').map(v => normalizeIP(v.trim())).filter(Boolean);
  if (chain.some(v => !isIP(v))) throw fail('Invalid proxy chain');
  for (let i = chain.length - 1; i >= 0; i--) if (!trustedProxies.includes(chain[i])) return chain[i];
  throw fail('Missing original client address');
}
async function verifySource(ip, resolve = lookup) {
  // An obsolete/unavailable documented hostname must not discard positive
  // source-IP evidence from another official hostname. Never accept arbitrary IPs.
  const results = await Promise.allSettled(PAYFAST_DOMAINS.map(host => resolve(host, {all: true})));
  const addresses = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  if (addresses.some(a => normalizeIP(a.address) === normalizeIP(ip))) return;
  if (!addresses.length || results.some(r => r.status === 'rejected')) {
    throw fail('Payment source check temporarily unavailable', 503);
  }
  throw fail('Invalid payment source', 403);
}
async function verifyNotification(raw, ip, cfg, dependencies = {}) {
  const parsed = parseNotification(raw);
  if (!safeEqual(parsed.data.signature, signature(parsed.entries, cfg.passphrase))) throw fail('Invalid signature', 403);
  if (!safeEqual(parsed.data.merchant_id, cfg.merchantId)) throw fail('Wrong merchant', 403);
  if (parsed.data.currency && parsed.data.currency !== 'ZAR') throw fail('Wrong currency');
  await verifySource(ip, dependencies.resolve || lookup);
  let response;
  try {
    response = await (dependencies.fetch || fetch)(VALIDATE_URL, {
      method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: paramString(parsed.entries), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok || (await response.text()).trim() !== 'VALID') throw new Error('Not validated');
  } catch { throw fail('Payment confirmation unavailable; notification must retry', 503); }
  return parsed.data;
}
module.exports = {CATALOG, CHECKOUT_URL, VALIDATE_URL, fail, safeEqual, encode, paramString, signature,
  parseNotification, money, cents, localDate, anniversary, graceEnd, maySpend, config,
  checkoutFields, normalizeIP, clientIP, verifySource, verifyNotification};
