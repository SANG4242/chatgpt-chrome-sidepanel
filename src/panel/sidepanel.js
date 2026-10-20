const frame = document.getElementById('chatgpt');
const refreshButton = document.getElementById('refresh');
const loadStatus = document.getElementById('load-status');
const errorMessage = document.getElementById('error');
const channel = 'chatgpt-sidepanel-context';
let windowId;
let state;
let bridgeReady = false;
let fetching = false;
let fetchAgain = false;
let opening = false;
let loadTimer;

function showError(message, hideFrame = false) {
  clearTimeout(loadTimer);
  loadTimer = undefined;
  loadStatus.textContent = '加载未完成';
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  if (hideFrame) frame.hidden = true;
}

function startLoading() {
  clearTimeout(loadTimer);
  bridgeReady = false;
  frame.hidden = false;
  errorMessage.hidden = true;
  loadStatus.textContent = '正在加载 ChatGPT…';
  loadTimer = setTimeout(() => {
    showError('ChatGPT 加载超过 30 秒。请点击上方的刷新按钮重试；若持续转圈，请在普通标签页完成登录或验证后重试。');
  }, 30000);
}

function finishLoading() {
  clearTimeout(loadTimer);
  loadTimer = undefined;
  errorMessage.hidden = true;
  loadStatus.textContent = 'ChatGPT 已就绪';
}

function tellFrame(message) {
  frame.contentWindow.postMessage({ channel, ...message }, 'https://chatgpt.com');
}

function loadState(nextState) {
  state = nextState;
  startLoading();
  frame.src = state.url;
}

refreshButton.addEventListener('click', () => {
  if (opening) return;
  if (state) loadState({ ...state });
  else openChatGPT();
});

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
    finishLoading();
    deliverContext();
  } else if (message.type === 'state' && message.revision === state.revision) {
    state = { ...state, url: message.url, draft: message.draft, fresh: false };
    chrome.runtime.sendMessage({ type: 'save-panel-state', windowId, state }).catch(console.error);
  } else if (message.type === 'inserted') {
    chrome.runtime.sendMessage({ type: 'context-inserted', id: message.id, windowId }).catch(console.error);
  }
});

frame.addEventListener('load', () => {
  if (!state) return;
  if (loadTimer === undefined) startLoading();
  bridgeReady = false;
  tellFrame({ type: 'hello' });
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.windowId !== windowId) return;
  if (message.type === 'context-pending') deliverContext();
  if (message.type === 'new-chat') loadState(message.state);
});

async function openChatGPT() {
  if (opening) return;
  opening = true;
  refreshButton.disabled = true;
  errorMessage.hidden = true;
  loadStatus.textContent = '正在准备…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'prepare-panel' });
    if (!result?.ok) throw new Error(result?.error || '扩展后台未就绪');
    windowId = (await chrome.windows.getCurrent()).id;
    const saved = await chrome.runtime.sendMessage({ type: 'get-panel-state', windowId });
    if (!saved?.ok) throw new Error(saved?.error || '无法恢复侧栏');
    loadState(saved.state);
  } catch (error) {
    showError(`无法打开侧栏：${error.message || String(error)}`, true);
  } finally {
    opening = false;
    refreshButton.disabled = false;
  }
}

openChatGPT();
