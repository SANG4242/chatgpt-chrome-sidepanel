(() => {
  if (window.parent === window) return;
  const channel = 'chatgpt-sidepanel-context';
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const pending = new Map();
  const completed = new Set();
  const failed = new Map();
  const confirmationTimeout = 1500;
  let connected = false;
  let timer;
  let revision;
  let restore;
  let restoreFailure;
  let lastSnapshot = '';

  function reply(message) {
    window.parent.postMessage({ channel, ...message }, extensionOrigin);
  }

  function findEditor() {
    return document.querySelector('#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, .ProseMirror[contenteditable="true"]');
  }

  const blockTags = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  function readEditable(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeName === 'BR') return '\n';
    let text = '';
    let seen = false;
    let previousBlock = false;
    let previousBreak = false;
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE && child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.nodeType === Node.TEXT_NODE && !child.textContent) continue;
      const block = blockTags.has(child.nodeName);
      if (seen && (previousBlock || block) && !previousBreak) text += '\n';
      text += readEditable(child);
      seen = true;
      previousBlock = block;
      previousBreak = child.nodeName === 'BR';
    }
    if (node.lastChild?.nodeName === 'BR') text = text.slice(0, -1);
    return text;
  }

  function readText(editor) {
    return editor.tagName === 'TEXTAREA' ? editor.value : readEditable(editor);
  }

  function comparableText(text) {
    return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  }

  function containsText(value, text) {
    const normalize = input => comparableText(input).replace(/\n{2,}/g, '\n\n');
    return normalize(value).includes(normalize(text));
  }

  function matchesText(editor, text, replace) {
    const actual = readText(editor);
    return replace ? comparableText(actual) === comparableText(text) : containsText(actual, text);
  }

  function writeText(editor, text, replace = false) {
    const existing = readText(editor);
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
      document.execCommand('insertText', false, addition);
    }
  }

  function confirmText(editor, operation, text, replace = false) {
    if (matchesText(editor, text, replace)) return 'confirmed';
    if (operation.attemptedAt === undefined) {
      if (editor.disabled || editor.getAttribute('aria-disabled') === 'true') return 'waiting';
      operation.attemptedAt = Date.now();
      try {
        writeText(editor, text, replace);
      } catch (error) {
        operation.error = error.message || String(error);
      }
      if (matchesText(editor, text, replace)) return 'confirmed';
    }
    return Date.now() - operation.attemptedAt >= confirmationTimeout ? 'failed' : 'waiting';
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
    if (restoreFailure) return;
    if (restore && editor) {
      const saved = restore;
      const result = saved.fresh || saved.draft ? confirmText(editor, saved, saved.fresh ? '' : saved.draft, true) : 'confirmed';
      if (result === 'waiting') { timer = setTimeout(flush, 300); return; }
      if (result === 'failed') {
        restoreFailure = { revision: saved.revision, error: '未能确认草稿恢复，已停止自动重试。' };
        restore = null;
        console.error(restoreFailure.error);
        reply({ type: 'restore-failed', ...restoreFailure });
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
        const result = confirmText(editor, item, item.text);
        if (result === 'waiting') break;
        pending.delete(id);
        if (result === 'failed') {
          const error = '未能确认文字填入，已停止自动重试。';
          failed.set(id, error);
          console.error(error);
          reply({ type: 'insert-failed', id, error });
        } else {
          completed.add(id);
          reply({ type: 'inserted', id });
        }
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
      if (restoreFailure?.revision === message.state.revision) {
        reply({ type: 'restore-failed', ...restoreFailure });
      } else if (revision === message.state.revision) {
        reply({ type: 'restored', revision });
      } else {
        if (restore?.revision !== message.state.revision) {
          restore = { ...message.state };
          restoreFailure = null;
        }
        flush();
      }
      return;
    }
    if (!connected || message.type !== 'insert' || typeof message.id !== 'string' || typeof message.text !== 'string') return;
    if (completed.has(message.id)) { reply({ type: 'inserted', id: message.id }); return; }
    if (failed.has(message.id)) { reply({ type: 'insert-failed', id: message.id, error: failed.get(message.id) }); return; }
    if (!pending.has(message.id)) pending.set(message.id, { text: message.text, createdAt: Date.now() });
    flush();
  });
  document.addEventListener('input', () => publishState(), true);
  window.addEventListener('pagehide', () => publishState(true));
  window.addEventListener('popstate', () => setTimeout(() => publishState(), 0));
  setInterval(() => publishState(), 500);
  reply({ type: 'available' });
})();
