const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function harness() {
  const stored = {};
  const calls = {};
  const chrome = {
    runtime: {
      id: 'test', getURL: file => `chrome-extension://test/${file}`,
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { calls.message = listener; } },
      async sendMessage(message) { calls.sent = message; }
    },
    storage: { session: {
      async get(key) { return structuredClone({ [key]: stored[key] }); },
      async set(value) { Object.assign(stored, structuredClone(value)); }
    } },
    commands: { onCommand: { addListener(listener) { calls.command = listener; } } },
    sidePanel: { async open() {}, async setPanelBehavior() {} },
    declarativeNetRequest: { async updateDynamicRules() {} },
    scripting: { async executeScript() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8'), { chrome, URL, crypto: { randomUUID }, console });
  const request = message => new Promise(resolve => {
    const accepted = calls.message(message, { id: 'test', url: chrome.runtime.getURL('src/panel/sidepanel.html') }, resolve);
    if (!accepted) resolve(null);
  });
  return { request, calls };
}

test('saved conversation and draft persist by window and old revision cannot replace new chat', async () => {
  const { request, calls } = harness();
  const initial = (await request({ type: 'get-panel-state', windowId: 7 })).state;
  await request({ type: 'save-panel-state', windowId: 7, state: { ...initial, url: 'https://chatgpt.com/c/example', draft: 'saved draft' } });
  assert.equal((await request({ type: 'get-panel-state', windowId: 7 })).state.draft, 'saved draft');
  assert.equal((await request({ type: 'get-panel-state', windowId: 8 })).state.draft, '');
  assert.equal(await request({ type: 'save-panel-state', windowId: 7, state: { ...initial, url: 'https://evil.example/', draft: '' } }), null);
  calls.command('new-chat', { id: 1, windowId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  const fresh = (await request({ type: 'get-panel-state', windowId: 7 })).state;
  assert.equal(fresh.url, 'https://chatgpt.com/');
  assert.equal(fresh.draft, '');
  assert.equal(fresh.fresh, true);
  assert.notEqual(fresh.revision, initial.revision);
  await request({ type: 'save-panel-state', windowId: 7, state: { ...initial, url: 'https://chatgpt.com/c/old', draft: 'old draft' } });
  assert.equal((await request({ type: 'get-panel-state', windowId: 7 })).state.draft, '');
});
