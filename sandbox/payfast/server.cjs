'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {Store} = require('./store.cjs');
const {CATALOG, config, fail, safeEqual, checkoutFields, clientIP, verifyNotification} = require('./payfast.cjs');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
async function readBody(req, limit = 16384) {
  if (Number(req.headers['content-length'] || 0) > limit) throw fail('Request too large', 413);
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw fail('Request too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function respond(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}
function createApp({cfg, store, verify = verifyNotification, clock = () => new Date()}) {
  const sessions = new Map(), attempts = new Map();
  function authenticated(req) {
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sandbox_session='));
    const token = cookie?.slice('sandbox_session='.length);
    const expires = token && sessions.get(token);
    return Boolean(expires && expires > Date.parse(clock()));
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action https://sandbox.payfast.co.za; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, cfg.origin);
      const ip = clientIP(req.socket.remoteAddress, req.headers['x-forwarded-for'], cfg.trustedProxies);
      if (req.method === 'POST' && url.pathname === '/itn') {
        if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/x-www-form-urlencoded') throw fail('Expected form notification', 415);
        const data = await verify(await readBody(req), ip, cfg);
        // The only route which can grant tokens. Redirects cannot invoke this path.
        const result = store.recordVerifiedPayment(data, clock());
        return respond(res, 200, {accepted: true, outcome: result.outcome});
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== cfg.origin) throw fail('Invalid request origin', 403);
        if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw fail('Expected JSON', 415);
        if (url.pathname === '/session') {
          const timestamp = Date.parse(clock());
          for (const [key, entry] of attempts) if (timestamp - entry.start >= 60000) attempts.delete(key);
          if (!attempts.has(ip) && attempts.size >= 10000) throw fail('Login temporarily unavailable', 503);
          const attempt = attempts.get(ip) || {start: timestamp, count: 0};
          attempt.count++; attempts.set(ip, attempt);
          if (attempt.count > 6) throw fail('Too many login attempts. Try again in one minute', 429);
          let body;
          try { body = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw fail('Invalid JSON'); }
          if (!body || typeof body.accessKey !== 'string' || !safeEqual(body.accessKey, cfg.accessKey)) throw fail('Incorrect test access key', 401);
          for (const [token, expires] of sessions) if (expires <= timestamp) sessions.delete(token);
          if (sessions.size >= 100) throw fail('Too many test sessions', 429);
          const token = randomBytes(32).toString('base64url');
          sessions.set(token, timestamp + 30 * 60000);
          res.setHeader('Set-Cookie', `sandbox_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1800`);
          return respond(res, 200, {signedIn: true, mode: 'sandbox'});
        }
        if (!authenticated(req)) throw fail('Sign in to the isolated test harness', 401);
        if (url.pathname === '/logout') {
          const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sandbox_session='))?.slice('sandbox_session='.length);
          if (token) sessions.delete(token);
          res.setHeader('Set-Cookie', 'sandbox_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
          return respond(res, 200, {signedIn: false});
        }
        if (url.pathname === '/checkout') {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw fail('Invalid JSON'); }
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['packageId', 'requestId'].includes(k))) throw fail('Only packageId and requestId are accepted');
          const order = store.createOrder(body.packageId, body.requestId, clock());
          return respond(res, 200, {orderId: order.id, mode: 'sandbox', ...checkoutFields(order, cfg)});
        }
        throw fail('Route not found', 404);
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        if (!authenticated(req)) throw fail('Sign in to the isolated test harness', 401);
        return respond(res, 200, {catalog: CATALOG, ...store.snapshot(clock()),
          limitation: 'Initial subscription and top-ups only. Renewals are held for review; no automatic renewal credit, cancellation, refund or dispute handling yet.'});
      }
      const asset = req.method === 'GET' && ASSETS.get(url.pathname);
      if (asset) {
        res.writeHead(200, {'Content-Type': asset[1]});
        return res.end(fs.readFileSync(path.join(__dirname, 'public', asset[0])));
      }
      throw fail('Route not found', 404);
    } catch (e) {
      if (!res.headersSent) respond(res, e.status || 500, {error: e.status ? e.message : 'Test operation failed; check configuration and retry the same request'});
      else res.end();
      // Deliberately do not log raw requests, signed fields, cookies or credential values.
    }
  };
}
function start() {
  const cfg = config(process.env);
  const dir = path.join(__dirname, 'var');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const filename = path.join(dir, 'sandbox.sqlite');
  const store = new Store(filename);
  fs.chmodSync(filename, 0o600);
  const server = http.createServer(createApp({cfg, store}));
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Invalid port');
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log('JobAgent PayFast Sandbox only. No production connection. Listening on port ' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => {store.close(); process.exit(0);}));
  return server;
}
if (require.main === module) {
  try { start(); } catch (e) { console.error(e.status ? e.message : 'Sandbox failed to start'); process.exitCode = 1; }
}
module.exports = {createApp, start};
