(() => {
  if (document.querySelector('[data-chatgpt-selection-button]')) return;
  if (window.parent !== window && location.hostname === 'chatgpt.com') return;
  const host = document.createElement('div');
  host.setAttribute('popover', 'manual');
  host.setAttribute('data-chatgpt-selection-button', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;z-index:2147483647!important;display:none!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = 'button{box-sizing:border-box;padding:7px 11px;border:1px solid #d8e4dd;border-radius:8px;background:#fff;color:#176b4b;box-shadow:0 3px 14px #0002;font:13px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap}button:hover{background:#edf6f0}button:focus-visible{outline:2px solid #29855e;outline-offset:2px}button:disabled{opacity:.7;cursor:wait}';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '问问 ChatGPT';
  shadow.append(style, button);
  document.documentElement.append(host);
  let selectedText = '';
  let dismissedText = '';
  let busy = false;
  let updateTimer;

  function hide() {
    if (host.matches(':popover-open')) host.hidePopover();
    host.style.setProperty('display', 'none', 'important');
    if (!busy) selectedText = '';
  }

  function editable(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'));
  }

  function showSelection() {
    if (busy) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || editable(selection.anchorNode) || editable(selection.focusNode)) {
      dismissedText = '';
      hide();
      return;
    }
    const text = selection.toString().trim();
    if (!text || text === dismissedText) {
      hide();
      return;
    }
    const rects = selection.getRangeAt(selection.rangeCount - 1).getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect || rect.bottom < 0 || rect.top > innerHeight) {
      hide();
      return;
    }
    selectedText = text;
    button.textContent = '问问 ChatGPT';
    if (!host.isConnected) document.documentElement.append(host);
    host.style.setProperty('display', 'block', 'important');
    if (!host.matches(':popover-open')) host.showPopover();
    const box = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right, innerWidth - box.width - 8));
    const below = rect.bottom + 7;
    const top = Math.max(8, Math.min(below + box.height <= innerHeight - 8 ? below : rect.top - box.height - 7, innerHeight - box.height - 8));
    host.style.setProperty('left', `${left}px`, 'important');
    host.style.setProperty('top', `${top}px`, 'important');
  }

  function scheduleSelection() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(showSelection, 120);
  }

  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', async event => {
    if (!event.isTrusted || busy || !selectedText) return;
    busy = true;
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ask-selection', text: selectedText });
      if (!result?.ok) throw new Error(result?.error || '无法打开侧栏');
      dismissedText = selectedText;
      clearTimeout(updateTimer);
      hide();
    } catch (error) {
      button.textContent = '未能打开，请重试';
      console.error(error);
    } finally {
      busy = false;
      button.disabled = false;
      if (host.style.display === 'none') selectedText = '';
    }
  });
  document.addEventListener('selectionchange', scheduleSelection);
  document.addEventListener('pointerup', scheduleSelection);
  document.addEventListener('keyup', scheduleSelection);
  document.addEventListener('pointerdown', event => {
    if (!event.composedPath().includes(host)) {
      clearTimeout(updateTimer);
      hide();
    }
  }, true);
  document.addEventListener('scroll', () => { clearTimeout(updateTimer); hide(); }, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', () => { clearTimeout(updateTimer); hide(); });
})();
