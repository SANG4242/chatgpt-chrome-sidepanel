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
  const calls = { messages: [], posts: [], navigations: [] };
  const handlers = {};
  const timers = new Map();
  let timerId = 0;
  let src = '';
  const frame = {
    hidden: false,
    get src() { return src; },
    set src(value) { src = value; calls.navigations.push(value); },
    contentWindow: { postMessage(message, origin) { calls.posts.push({ message, origin }); } },
    addEventListener(event, listener) { handlers[`frame-${event}`] = listener; }
  };
  const elements = new Map([
    ['chatgpt', frame],
    ['error', { hidden: true, textContent: '' }],
    ['load-status', { textContent: '' }],
    ['refresh', { disabled: true, addEventListener(event, listener) { handlers[`refresh-${event}`] = listener; } }]
  ]);
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
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console
  });
  function advanceTimers() {
    const pending = [...timers.values()];
    timers.clear();
    for (const { callback } of pending) callback();
  }
  function emit(data, origin = 'https://chatgpt.com', source = frame.contentWindow) {
    handlers.message({ source, origin, data: { channel: 'chatgpt-sidepanel-context', ...data } });
  }
  return { elements, calls, handlers, frame, timers, advanceTimers, emit };
}

test('manifest registers shortcuts and scripts without cookie or history access', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  assert.equal(manifest.minimum_chrome_version, '145');
  assert.deepEqual(manifest.permissions, ['sidePanel', 'declarativeNetRequestWithHostAccess', 'activeTab', 'storage', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.commands._execute_action.suggested_key.default, 'Ctrl+G');
  assert.equal(manifest.commands['send-current-link'].suggested_key.default, 'Alt+G');
  assert.equal(manifest.content_scripts[1].all_frames, true);
  for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, 'src/panel/sidepanel.js', 'src/panel/sidepanel.css', ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons)]) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});

test('embedding rule covers ChatGPT subframe navigation only under this extension top-level origin', async () => {
  const { chrome, calls, response } = backgroundHarness();
  assert.equal((await response({ type: 'prepare-panel' })).ok, true);
  assert.equal(calls.rules.removeRuleIds[0], 1);
  assert.equal(calls.rules.addRules.length, 1);
  const rule = calls.rules.addRules[0];
  assert.equal(rule.id, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rule.condition)), {
    requestDomains: ['chatgpt.com'],
    topDomains: [chrome.runtime.id],
    resourceTypes: ['sub_frame']
  });
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.deepEqual(JSON.parse(JSON.stringify(rule.action.responseHeaders)), [
    { header: 'x-frame-options', operation: 'remove' },
    { header: 'content-security-policy', operation: 'remove' }
  ]);
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
  const { elements, timers } = panelHarness({ ok: false, error: 'not ready' });
  await settle();
  assert.equal(elements.get('chatgpt').src, '');
  assert.equal(elements.get('chatgpt').hidden, true);
  assert.match(elements.get('error').textContent, /not ready/);
  assert.equal(elements.get('error').hidden, false);
  assert.equal(elements.get('refresh').disabled, false);
  assert.equal(timers.size, 0);
});

test('refresh reloads the current conversation and restores the latest recorded draft', async () => {
  const { frame, handlers, calls, emit } = panelHarness();
  await settle();
  emit({ type: 'restored', revision: 'test-revision' });
  await settle();
  const saved = { url: 'https://chatgpt.com/c/current-conversation', draft: '未发送的草稿', revision: 'test-revision' };
  emit({ type: 'state', ...saved });
  const requestsBeforeRefresh = calls.messages.length;
  handlers['refresh-click']();
  assert.equal(frame.src, saved.url);
  assert.equal(calls.navigations.length, 2);
  handlers['refresh-click']();
  assert.deepEqual(calls.navigations, ['https://chatgpt.com/', saved.url, saved.url]);
  assert.equal(calls.messages.length, requestsBeforeRefresh);
  handlers.runtime({ type: 'context-pending', windowId: 7 });
  await settle();
  assert.equal(calls.messages.length, requestsBeforeRefresh);
  handlers['frame-load']();
  emit({ type: 'ready' });
  const restored = calls.posts.at(-1).message;
  assert.equal(restored.type, 'restore');
  assert.equal(restored.state.url, saved.url);
  assert.equal(restored.state.draft, saved.draft);
  assert.equal(restored.state.revision, saved.revision);
  assert.equal(restored.state.fresh, false);
  emit({ type: 'restored', revision: saved.revision });
  await settle();
  assert.equal(calls.messages.at(-1).type, 'get-context');
});

test('refresh preserves an explicitly emptied draft', async () => {
  const { handlers, calls, emit } = panelHarness();
  await settle();
  emit({ type: 'state', url: 'https://chatgpt.com/c/current-conversation', draft: 'old draft', revision: 'test-revision' });
  emit({ type: 'state', url: 'https://chatgpt.com/c/current-conversation', draft: '', revision: 'test-revision' });
  handlers['refresh-click']();
  emit({ type: 'ready' });
  assert.equal(calls.posts.at(-1).message.state.draft, '');
});

test('loading times out after 30 seconds without hiding the website or disabling refresh', async () => {
  const { elements, frame, timers, advanceTimers } = panelHarness();
  await settle();
  assert.equal(elements.get('load-status').textContent, '正在加载 ChatGPT…');
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [30000]);
  advanceTimers();
  assert.equal(elements.get('load-status').textContent, '加载未完成');
  assert.equal(elements.get('error').hidden, false);
  assert.match(elements.get('error').textContent, /30 秒/);
  assert.equal(frame.hidden, false);
  assert.equal(elements.get('refresh').disabled, false);
});

test('only a matching restoration completes loading and clears a timeout warning', async () => {
  const { elements, timers, advanceTimers, emit } = panelHarness();
  await settle();
  emit({ type: 'ready' });
  emit({ type: 'restored', revision: 'old-revision' });
  emit({ type: 'restored', revision: 'test-revision' }, 'https://example.com');
  emit({ type: 'restored', revision: 'test-revision' }, 'https://chatgpt.com', {});
  assert.equal(timers.size, 1);
  advanceTimers();
  assert.equal(elements.get('error').hidden, false);
  emit({ type: 'restored', revision: 'test-revision' });
  assert.equal(elements.get('load-status').textContent, 'ChatGPT 已就绪');
  assert.equal(elements.get('error').hidden, true);
  assert.equal(timers.size, 0);
});

test('successful loading cancels the deadline and a later frame navigation starts a new one', async () => {
  const { elements, handlers, timers, advanceTimers, emit } = panelHarness();
  await settle();
  const initialTimer = [...timers.keys()][0];
  handlers['frame-load']();
  assert.deepEqual([...timers.keys()], [initialTimer]);
  emit({ type: 'restored', revision: 'test-revision' });
  advanceTimers();
  assert.equal(elements.get('error').hidden, true);
  assert.equal(elements.get('load-status').textContent, 'ChatGPT 已就绪');
  handlers['frame-load']();
  assert.equal(timers.size, 1);
  assert.equal(elements.get('load-status').textContent, '正在加载 ChatGPT…');
});

test('refresh clears a timeout warning and replaces the previous deadline', async () => {
  const { elements, handlers, timers, advanceTimers } = panelHarness();
  await settle();
  const firstTimer = [...timers.keys()][0];
  handlers['refresh-click']();
  assert.equal(timers.size, 1);
  assert.equal(timers.has(firstTimer), false);
  advanceTimers();
  assert.equal(elements.get('error').hidden, false);
  handlers['refresh-click']();
  assert.equal(elements.get('error').hidden, true);
  assert.equal(elements.get('load-status').textContent, '正在加载 ChatGPT…');
  assert.equal(timers.size, 1);
});

test('refresh retries initialization after failure and prevents overlapping startup requests', async () => {
  const result = { ok: false, error: 'not ready' };
  const { elements, handlers, frame, calls } = panelHarness(result);
  assert.equal(elements.get('refresh').disabled, true);
  handlers['refresh-click']();
  assert.equal(calls.messages.length, 1);
  await settle();
  result.ok = true;
  handlers['refresh-click']();
  assert.equal(elements.get('refresh').disabled, true);
  handlers['refresh-click']();
  await settle();
  assert.equal(calls.messages.filter(message => message.type === 'prepare-panel').length, 2);
  assert.equal(frame.src, 'https://chatgpt.com/');
  assert.equal(frame.hidden, false);
  assert.equal(elements.get('error').hidden, true);
  assert.equal(elements.get('refresh').disabled, false);
});
