const frame = document.getElementById('chatgpt');
const channel = 'chatgpt-sidepanel-context';
let windowId;
let state;
let bridgeReady = false;
let fetching = false;
let fetchAgain = false;

function tellFrame(message) {
  frame.contentWindow.postMessage({ channel, ...message }, 'https://chatgpt.com');
}

function loadState(nextState) {
  state = nextState;
  bridgeReady = false;
  frame.src = state.url;
}

async function deliverContext() {
  if (!bridgeReady || !Number.isInteger(windowId)) return;
  if (fetching) { fetchAgain = true; return; }
  fetching = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get-context', windowId });
    if (!result?.ok) throw new Error(result?.error || '无法获取待填链接');
    for (const item of result.items) tellFrame({ type: 'insert', id: item.id, text: item.text });
  } catch (error) {
    console.error(error);
  } finally {
    fetching = false;
    if (fetchAgain) { fetchAgain = false; deliverContext(); }
  }
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== 'https://chatgpt.com' || event.data?.channel !== channel || !state) return;
  const message = event.data;
  if (message.type === 'available' || message.type === 'ready') {
    tellFrame({ type: 'restore', state });
  } else if (message.type === 'restored' && message.revision === state.revision) {
    bridgeReady = true;
    deliverContext();
  } else if (message.type === 'state' && message.revision === state.revision) {
    state = { ...state, url: message.url, draft: message.draft, fresh: false };
    chrome.runtime.sendMessage({ type: 'save-panel-state', windowId, state }).catch(console.error);
  } else if (message.type === 'inserted') {
    chrome.runtime.sendMessage({ type: 'context-inserted', id: message.id, windowId }).catch(console.error);
  }
});

frame.addEventListener('load', () => {
  bridgeReady = false;
  tellFrame({ type: 'hello' });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.windowId !== windowId) return;
  if (message.type === 'context-pending') deliverContext();
  if (message.type === 'new-chat') loadState(message.state);
});

async function openChatGPT() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'prepare-panel' });
    if (!result?.ok) throw new Error(result?.error || '扩展后台未就绪');
    windowId = (await chrome.windows.getCurrent()).id;
    const saved = await chrome.runtime.sendMessage({ type: 'get-panel-state', windowId });
    if (!saved?.ok) throw new Error(saved?.error || '无法恢复侧栏');
    loadState(saved.state);
  } catch (error) {
    frame.hidden = true;
    const message = document.getElementById('error');
    message.textContent = `无法打开侧栏：${error.message || String(error)}`;
    message.hidden = false;
  }
}

openChatGPT();
