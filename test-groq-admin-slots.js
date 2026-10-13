const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(__dirname + '/admin.html', 'utf8');
assert(html.includes('All twenty slots use the selected model.'));
assert(!html.includes('All ten slots'));
const start = html.indexOf('const GROQ_SLOT_COUNT =');
const end = html.indexOf('function showProviderKeyFields', start);
assert(start >= 0 && end > start);
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '', innerHTML: '' });
  return elements.get(id);
};
const context = vm.createContext({
  $: selector => element(selector.slice(1)),
  esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
  Date, console,
});
vm.runInContext(html.slice(start, end), context);
context.renderGroqSlots(Array.from({ length: 10 }, (_, i) => 'old-fake-' + i));
const rendered = element('groqKeyRows').innerHTML;
assert.equal((rendered.match(/data-groq-slot=/g) || []).length, 20);
assert(rendered.includes('K20 — Groq API key'));
assert(rendered.includes('value="old-fake-9"'));
assert.equal((rendered.match(/type="password"/g) || []).length, 20);
for (let i = 0; i < 20; i++) element('groqKey' + i).value = 'fake-slot-' + (i + 1);
assert.equal(context.readGroqSlots().length, 20);
assert.equal(context.readGroqSlots()[19], 'fake-slot-20');
element('groqKey19').value = '';
assert.equal(context.readGroqSlots()[19], null);
console.log('PASS twenty masked inputs, legacy ten-key rendering, K20 read and clear');

// Exercise the actual settings save function with a mocked database.
const saveStart = html.indexOf('async function saveSettings(');
const saveEnd = html.indexOf('\nasync function ', saveStart + 1);
assert(saveStart >= 0 && saveEnd > saveStart);
let payload;
context.sb = { from: table => {
  assert.equal(table, 'dispatch_settings');
  return { update: p => {
    payload = p;
    return { eq: async (column, value) => {
      assert.equal(column, 'id'); assert.equal(value, true);
      return { error: null };
    }};
  }};
}};
context.toast = () => {};
context.document = { querySelectorAll: () => [] };
context.appSettings = {};
element('setProvider').value = 'groq';
element('setModel').value = 'shared-fake-model';
element('setGroqCooldown').value = '60';
element('setAgentPrompt').value = '';
element('groqKey19').value = 'fake-slot-20';
vm.runInContext(html.slice(saveStart, saveEnd), context);
context.saveSettings().then(() => {
  assert.equal(payload.ai_api_keys.length, 20);
  assert.equal(payload.ai_api_keys[0], 'fake-slot-1');
  assert.equal(payload.ai_api_keys[19], 'fake-slot-20');
  assert.equal(payload.ai_model, 'shared-fake-model');
  console.log('PASS saveSettings sends all twenty slots and the shared model');
}).catch(error => { console.error(error); process.exitCode = 1; });