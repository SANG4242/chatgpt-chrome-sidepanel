const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name === 'background.js' ? 'src/background.js' : name.startsWith('sidepanel.') ? `src/panel/${name}` : name), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function backgroundHarness({ fail = false, openFail = false } = {}) {
  const calls = { opens: [], messages: [] };
  const stored = {};
  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: file => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${file}`,
      onMessage: { addListener(listener) { calls.listener = listener; } },
      onInstalled: { addListener(listener) { calls.installed = listener; } },
      async sendMessage(message) { calls.messages.push(message); }
    },
    declarativeNetRequest: {
      async updateDynamicRules(rules) {
        calls.rules = rules;
        if (fail) throw new Error('rule failure');
      }
    },
    sidePanel: {
      async setPanelBehavior(value) { calls.behavior = value; },
      async open(value) { calls.opens.push(value); if (openFail) throw new Error('open failure'); }
    },
    commands: { onCommand: { addListener(listener) { calls.command = listener; } } },
    tabs: { async query() { return [{ id: 1, windowId: 7, url: 'https://example.com/article' }]; } },
    scripting: { async executeScript() {} },
    storage: { session: {
      async get(key) { return structuredClone({ [key]: stored[key] }); },
      async set(value) { Object.assign(stored, structuredClone(value)); }
    } }
  };
  vm.runInNewContext(read('background.js'), { chrome, URL, crypto: { randomUUID }, console });
  const panelSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('src/panel/sidepanel.html') };
  function response(message, sender = panelSender) {
    return new Promise(resolve => {
      const accepted = calls.listener(message, sender, resolve);
      if (!accepted) resolve(null);
    });
  }
  return { chrome, calls, response, stored, panelSender };
}

function panelHarness(result = { ok: true }) {
  const calls = { messages: [], posts: [] };
  const handlers = {};
  const frame = {
    hidden: false, src: '',
    contentWindow: { postMessage(message, origin) { calls.posts.push({ message, origin }); } },
    addEventListener(event, listener) { handlers[`frame-${event}`] = listener; }
  };
  const elements = new Map([['chatgpt', frame], ['error', { hidden: true, textContent: '' }]]);
  vm.runInNewContext(read('sidepanel.js'), {
    chrome: {
      runtime: {
        async sendMessage(message) {
          calls.messages.push(message);
          if (message.type === 'prepare-panel') return result;
          if (message.type === 'get-panel-state') return { ok: true, state: { url: 'https://chatgpt.com/', draft: '', revision: 'test-revision' } };
          return { ok: true, items: [{ id: 'item1', text: 'https://example.com' }] };
        },
        onMessage: { addListener(listener) { handlers.runtime = listener; } }
      },
      windows: { async getCurrent() { return { id: 7 }; } }
    },
    window: { addEventListener(event, listener) { handlers[event] = listener; } },
    document: { getElementById: id => elements.get(id) },
    console
  });
  return { elements, calls, handlers, frame };
}

test('manifest registers shortcuts and scripts without cookie or history access', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel', 'declarativeNetRequestWithHostAccess', 'activeTab', 'storage', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Ctrl+G');
  assert.equal(manifest.commands['send-current-link'].suggested_key.default, 'Alt+G');
  assert.equal(manifest.content_scripts[1].all_frames, true);
  for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, 'src/panel/sidepanel.js', 'src/panel/sidepanel.css', ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons)]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});

test('embedding rule remains restricted to ChatGPT subframes initiated by this extension', async () => {
  const { chrome, calls, response } = backgroundHarness();
  assert.equal((await response({ type: 'prepare-panel' })).ok, true);
  const rule = calls.rules.addRules[0];
  assert.equal(rule.condition.initiatorDomains[0], chrome.runtime.id);
  assert.equal(rule.condition.requestDomains[0], 'chatgpt.com');
  assert.equal(rule.condition.resourceTypes[0], 'sub_frame');
  assert.equal(calls.behavior.openPanelOnActionClick, true);
  assert.equal(await response({ type: 'prepare-panel' }, { id: 'other' }), null);
});

test('background initialization failure is returned', async () => {
  const { response } = backgroundHarness({ fail: true });
  const result = await response({ type: 'prepare-panel' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rule failure');
});

test('Alt+G opens panel immediately, queues only URL and removes it after acknowledgement', async () => {
  const { calls, response } = backgroundHarness();
  const tab = { id: 1, windowId: 7, url: 'https://example.com/article' };
  calls.command('send-current-link', tab);
  assert.equal(calls.opens.length, 1);
  await settle();
  const result = await response({ type: 'get-context', windowId: 7 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, tab.url);
  assert.equal((await response({ type: 'get-context', windowId: 8 })).items.length, 0);
  await response({ type: 'context-inserted', windowId: 8, id: result.items[0].id });
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items.length, 1);
  await response({ type: 'context-inserted', windowId: 7, id: result.items[0].id });
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items.length, 0);
});

test('repeated links are deduplicated and restricted URLs are ignored', async () => {
  const { calls, response } = backgroundHarness();
  const tab = { id: 1, windowId: 7, url: 'https://example.com' };
  calls.command('send-current-link', tab);
  calls.command('send-current-link', tab);
  calls.command('send-current-link', { ...tab, url: 'chrome://settings' });
  await settle();
  assert.equal(calls.opens.length, 2);
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items.length, 1);
});

test('trusted extension content sender queues URL plus selected text', async () => {
  const { response, chrome, calls } = backgroundHarness();
  const sender = { id: chrome.runtime.id, frameId: 0, url: 'https://example.com/page', tab: { id: 1, windowId: 7 } };
  assert.equal((await response({ type: 'ask-selection', text: ' selected passage ' }, sender)).ok, true);
  assert.equal(calls.opens.length, 1);
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items[0].text, 'https://example.com/page\n\nselected passage');
  assert.equal(await response({ type: 'ask-selection', text: 'secret' }, { ...sender, id: 'other' }), null);
  assert.equal((await response({ type: 'ask-selection', text: 'nested passage' }, { ...sender, frameId: 2 })).ok, true);
});

test('failed panel opening does not leave pending text', async () => {
  const { response, chrome } = backgroundHarness({ openFail: true });
  const sender = { id: chrome.runtime.id, frameId: 0, url: 'https://example.com', tab: { id: 1, windowId: 7 } };
  const result = await response({ type: 'ask-selection', text: 'passage' }, sender);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'open failure');
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items.length, 0);
});

test('expired queued text is not delivered', async () => {
  const { response, stored } = backgroundHarness();
  stored['pending-context'] = [{ id: 'expired', windowId: 7, text: 'old', createdAt: Date.now() - 600000 }];
  assert.equal((await response({ type: 'get-context', windowId: 7 })).items.length, 0);
});

test('sidepanel loads website and delivers only through the matching iframe', async () => {
  const { frame, handlers, calls } = panelHarness();
  await settle();
  assert.equal(frame.src, 'https://chatgpt.com/');
  handlers['frame-load']();
  assert.equal(calls.posts[0].message.type, 'hello');
  handlers.message({ source: {}, origin: 'https://chatgpt.com', data: { channel: 'chatgpt-sidepanel-context', type: 'ready' } });
  assert.equal(calls.messages.length, 2);
  handlers.message({ source: frame.contentWindow, origin: 'https://chatgpt.com', data: { channel: 'chatgpt-sidepanel-context', type: 'ready' } });
  assert.equal(calls.posts[1].message.type, 'restore');
  handlers.message({ source: frame.contentWindow, origin: 'https://chatgpt.com', data: { channel: 'chatgpt-sidepanel-context', type: 'restored', revision: 'test-revision' } });
  await settle();
  assert.equal(calls.posts[2].message.text, 'https://example.com');
  assert.equal(calls.posts[2].origin, 'https://chatgpt.com');
});

test('panel initialization failure displays an error', async () => {
  const { elements } = panelHarness({ ok: false, error: 'not ready' });
  await settle();
  assert.equal(elements.get('chatgpt').src, '');
  assert.equal(elements.get('chatgpt').hidden, true);
  assert.match(elements.get('error').textContent, /not ready/);
  assert.equal(elements.get('error').hidden, false);
});
