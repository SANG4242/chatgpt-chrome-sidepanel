const EMBED_RULE_ID = 1;
const QUEUE_KEY = 'pending-context';
const MAX_AGE = 5 * 60 * 1000;
let queueOperation = Promise.resolve();

async function configureExtension() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [EMBED_RULE_ID],
    addRules: [{
      id: EMBED_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ]
      },
      condition: {
        requestDomains: ['chatgpt.com'],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['sub_frame']
      }
    }]
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  return { ok: true };
}

const initialization = configureExtension().catch(error => ({
  ok: false,
  error: error.message || String(error)
}));

function updateQueue(change) {
  const operation = queueOperation.then(async () => {
    const stored = await chrome.storage.session.get(QUEUE_KEY);
    const queue = (stored[QUEUE_KEY] || []).filter(item => Date.now() - item.createdAt < MAX_AGE);
    const result = change(queue);
    await chrome.storage.session.set({ [QUEUE_KEY]: queue });
    return result;
  });
  queueOperation = operation.catch(() => {});
  return operation;
}

function makeContext(url, selection = '') {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const text = selection.trim();
    return text ? `${url}\n\n${text}` : url;
  } catch {
    return null;
  }
}

async function sendContext(tab, selection = '', pageUrl = tab?.url) {
  const text = makeContext(pageUrl, selection);
  if (!text || !Number.isInteger(tab?.windowId)) return;
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const opened = opening.then(() => ({ ok: true }), error => ({ ok: false, error }));
  const id = crypto.randomUUID();
  await updateQueue(queue => {
    if (!queue.some(item => item.windowId === tab.windowId && item.text === text)) {
      queue.push({ id, windowId: tab.windowId, text, createdAt: Date.now() });
    }
  });
  const result = await opened;
  if (!result.ok) {
    await updateQueue(queue => {
      const index = queue.findIndex(item => item.id === id);
      if (index !== -1) queue.splice(index, 1);
    });
    throw result.error;
  }
  await chrome.runtime.sendMessage({ type: 'context-pending', windowId: tab.windowId }).catch(() => {});
}

let stateOperation = Promise.resolve();

function stateKey(windowId) {
  return `panel-state-${windowId}`;
}

function changeState(windowId, change) {
  const operation = stateOperation.then(async () => {
    const key = stateKey(windowId);
    const stored = await chrome.storage.session.get(key);
    const state = stored[key] || { url: 'https://chatgpt.com/', draft: '', revision: crypto.randomUUID() };
    const result = change(state);
    await chrome.storage.session.set({ [key]: state });
    return result;
  });
  stateOperation = operation.catch(() => {});
  return operation;
}

function validChatURL(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://chatgpt.com' && (parsed.pathname === '/' || /^\/(?:c\/|g\/)/.test(parsed.pathname));
  } catch {
    return false;
  }
}

async function newChat(tab) {
  if (!Number.isInteger(tab?.windowId)) return;
  const opening = chrome.sidePanel.open({ windowId: tab.windowId });
  const opened = opening.then(() => ({ ok: true }), error => ({ ok: false, error }));
  const state = await changeState(tab.windowId, state => {
    Object.assign(state, { url: 'https://chatgpt.com/', draft: '', revision: crypto.randomUUID(), fresh: true });
    return { ...state };
  });
  await updateQueue(queue => {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].windowId === tab.windowId) queue.splice(index, 1);
    }
  });
  const result = await opened;
  if (!result.ok) throw result.error;
  await chrome.runtime.sendMessage({ type: 'new-chat', windowId: tab.windowId, state }).catch(() => {});
}

async function injectSelection(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content/selection-button.js'] });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then(tabs => {
    for (const tab of tabs) injectSelection(tab.id).catch(() => {});
  }).catch(console.error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!['send-current-link', 'new-chat'].includes(command)) return;
  const run = activeTab => {
    if (activeTab?.id) injectSelection(activeTab.id).catch(() => {});
    return command === 'new-chat' ? newChat(activeTab) : sendContext(activeTab);
  };
  if (tab) run(tab).catch(console.error);
  else chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([activeTab]) => run(activeTab)).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'ask-selection' && sender.tab && Number.isInteger(sender.frameId) && typeof message.text === 'string' && message.text.trim() && makeContext(sender.url)) {
    sendContext(sender.tab, message.text, sender.url)
      .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (sender.url !== chrome.runtime.getURL('src/panel/sidepanel.html')) return false;
  if (message?.type === 'get-panel-state' && Number.isInteger(message.windowId)) {
    changeState(message.windowId, state => ({ ...state }))
      .then(state => sendResponse({ ok: true, state }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'save-panel-state' && Number.isInteger(message.windowId) && validChatURL(message.state?.url) && typeof message.state?.draft === 'string') {
    changeState(message.windowId, state => {
      if (state.revision === message.state.revision) Object.assign(state, { url: message.state.url, draft: message.state.draft, fresh: false });
    }).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'prepare-panel') {
    initialization.then(sendResponse);
    return true;
  }
  if (message?.type === 'get-context' && Number.isInteger(message.windowId)) {
    updateQueue(queue => queue.filter(item => item.windowId === message.windowId))
      .then(items => sendResponse({ ok: true, items }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'context-inserted' && Number.isInteger(message.windowId)) {
    updateQueue(queue => {
      const index = queue.findIndex(item => item.id === message.id && item.windowId === message.windowId);
      if (index !== -1) queue.splice(index, 1);
    }).then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
