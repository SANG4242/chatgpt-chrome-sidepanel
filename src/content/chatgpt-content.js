(() => {
  if (window.parent === window) return;
  const channel = 'chatgpt-sidepanel-context';
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const pending = new Map();
  const completed = new Set();
  let connected = false;
  let timer;
  let revision;
  let restore;
  let lastSnapshot = '';

  function reply(message) {
    window.parent.postMessage({ channel, ...message }, extensionOrigin);
  }

  function findEditor() {
    return document.querySelector('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, .ProseMirror[contenteditable="true"]');
  }

  function readText(editor) {
    return editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText;
  }

  function containsText(value, text) {
    const normalize = input => input.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n\n');
    return normalize(value).includes(normalize(text));
  }

  function writeText(editor, text, replace = false) {
    if (editor.disabled || editor.getAttribute('aria-disabled') === 'true') return false;
    const existing = readText(editor);
    if (!replace && containsText(existing, text)) return true;
    const addition = replace ? text : `${existing.trim() ? '\n\n' : ''}${text}`;
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, replace ? text : existing + addition);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.setSelectionRange(editor.value.length, editor.value.length);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (!replace) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, addition)) return false;
    }
    return text ? containsText(readText(editor), text) : readText(editor) === '';
  }

  function publishState(force = false) {
    if (!connected || !revision || restore) return;
    const editor = findEditor();
    if (!editor) return;
    const snapshot = { url: location.href, draft: readText(editor), revision };
    const key = JSON.stringify(snapshot);
    if (force || key !== lastSnapshot) {
      lastSnapshot = key;
      reply({ type: 'state', ...snapshot });
    }
  }

  function flush() {
    clearTimeout(timer);
    const editor = findEditor();
    if (restore && editor) {
      const saved = restore;
      if (saved.fresh) {
        if (!writeText(editor, '', true)) { timer = setTimeout(flush, 300); return; }
      } else if (saved.draft && !writeText(editor, saved.draft, true)) {
        timer = setTimeout(flush, 300);
        return;
      }
      revision = saved.revision;
      restore = null;
      reply({ type: 'restored', revision });
      publishState(true);
    }
    for (const [id, item] of pending) {
      if (Date.now() - item.createdAt > 5 * 60 * 1000) pending.delete(id);
    }
    if (!restore && editor && revision) {
      for (const [id, item] of pending) {
        if (!writeText(editor, item.text)) break;
        pending.delete(id);
        completed.add(id);
        reply({ type: 'inserted', id });
        publishState(true);
      }
    }
    if (restore || pending.size) timer = setTimeout(flush, 300);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== extensionOrigin || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.type === 'hello') {
      connected = true;
      reply({ type: 'ready' });
      return;
    }
    if (message.type === 'restore' && typeof message.state?.revision === 'string') {
      connected = true;
      if (revision === message.state.revision) {
        reply({ type: 'restored', revision });
      } else {
        restore = message.state;
        flush();
      }
      return;
    }
    if (!connected || message.type !== 'insert' || typeof message.id !== 'string' || typeof message.text !== 'string') return;
    if (completed.has(message.id)) { reply({ type: 'inserted', id: message.id }); return; }
    if (!pending.has(message.id)) pending.set(message.id, { text: message.text, createdAt: Date.now() });
    flush();
  });
  document.addEventListener('input', () => publishState(), true);
  window.addEventListener('pagehide', () => publishState(true));
  window.addEventListener('popstate', () => setTimeout(() => publishState(), 0));
  setInterval(() => publishState(), 500);
  reply({ type: 'available' });
})();
