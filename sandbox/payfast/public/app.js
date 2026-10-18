'use strict';
const $ = id => document.getElementById(id);
let pendingOrders = [];
let refreshRevision = 0;
function notice(message) { $('notice').textContent = message; }
async function api(url, body) {
  const result = await fetch(url, body === undefined ? {credentials: 'same-origin'} : {
    method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const data = await result.json();
  if (!result.ok) { const e = new Error(data.error || 'Test request failed'); e.status = result.status; throw e; }
  return data;
}
function pendingKey(packageId) { return 'jobagent-payfast-test-request:' + packageId; }
async function refresh() {
  const revision = ++refreshRevision;
  try {
    const state = await api('/state');
    if (revision !== refreshRevision) return;
    $('login').hidden = true; $('dashboard').hidden = false;
    pendingOrders = state.pendingOrders;
    $('wallet').textContent = `Monthly: ${state.monthly} · Purchased: ${state.purchased} · Spendable test tokens: ${state.spendable}`;
    $('subscription').textContent = `Status: ${state.status}. Next due date: ${state.dueDate || 'none'}.`;
    $('packages').replaceChildren();
    for (const [id, product] of Object.entries(state.catalog)) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${id === 'monthly' ? 'Subscribe' : 'Top up'}: R${(product.amountCents / 100).toFixed(2)} — ${product.tokens} test tokens${id === 'monthly' ? '/month' : ''}`;
      button.disabled = id === 'monthly' ? state.status !== 'unpaid' : !['active', 'grace'].includes(state.status);
      button.addEventListener('click', () => checkout(id, button)); $('packages').append(button);
    }
    $('pending').textContent = state.pendingOrders.length ? 'A checkout may be pending. Use the same package button to retry; cancelled redirects do not prove payment failed.' : '';
    $('history').textContent = state.history.length ? state.history.map(p => `${p.received_at} | R${(p.amount_cents / 100).toFixed(2)} | ${p.outcome} | ${p.reason}`).join('\n') : 'No verified payments yet.';
    // Clear retry keys only after a server-verified receipt for that exact request.
    for (const payment of state.history) {
      const key = pendingKey(payment.package_id);
      if (payment.outcome === 'credited' && sessionStorage.getItem(key) === payment.request_id) sessionStorage.removeItem(key);
    }
  } catch (e) {
    if (revision !== refreshRevision) return;
    if (e.status === 401) { $('login').hidden = false; $('dashboard').hidden = true; }
    else notice(e.message);
  }
}
async function checkout(packageId, button) {
  button.disabled = true; notice('Preparing Sandbox checkout…');
  const key = pendingKey(packageId);
  let requestId = sessionStorage.getItem(key) || pendingOrders.find(o => o.package_id === packageId)?.request_id;
  if (!requestId) requestId = crypto.randomUUID();
  sessionStorage.setItem(key, requestId);
  try {
    const data = await api('/checkout', {packageId, requestId});
    if (data.mode !== 'sandbox' || data.action !== 'https://sandbox.payfast.co.za/eng/process') throw new Error('Non-Sandbox checkout blocked');
    const form = document.createElement('form'); form.method = 'POST'; form.action = data.action;
    for (const [name, value] of Object.entries(data.fields)) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
    }
    document.body.append(form); form.submit();
  } catch (e) { notice(e.message + ' Keep the same request for uncertain retries.'); button.disabled = false; }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('access-key');
  try { await api('/session', {accessKey: input.value}); input.value = ''; notice('Signed in to the isolated test harness.'); await refresh(); }
  catch (e) { input.value = ''; notice(e.message); }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { try { await api('/logout', {}); await refresh(); } catch (e) { notice(e.message); } });
if (new URLSearchParams(location.search).has('result')) notice('Returned from checkout. This is NOT proof of payment. Refresh to check the verified server notification.');
refresh();
