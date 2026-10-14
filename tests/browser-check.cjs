const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function run() {
  const playwrightRoot = process.env.PLAYWRIGHT_ROOT;
  const executablePath = process.env.TEST_CHROME;
  if (!playwrightRoot || !executablePath) throw new Error('Set PLAYWRIGHT_ROOT and TEST_CHROME to installed test tools.');
  const { chromium } = createRequire(path.join(playwrightRoot, 'package.json'))('playwright');
  const root = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext('', {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionOrigin = worker.url().split('/').slice(0, 3).join('/');
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    assert.ok(commands.some(command => command.name === 'send-current-link' && command.shortcut === 'Alt+G'));
    const exampleBody = '<!doctype html><html><body><p id="passage">A selected passage for ChatGPT.</p><input id="private-input" value="private draft"></body></html>';
    const chatBody = '<!doctype html><html><body><div id="prompt-textarea" class="ProseMirror" contenteditable="true">Existing draft</div><button id="send">Send</button><script>window.sends=0;document.getElementById("send").onclick=()=>window.sends++;</script></body></html>';
    await context.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: exampleBody }));
    await context.route('https://chatgpt.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: chatBody }));
    const errors = [];
    const panel = await context.newPage();
    panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`${extensionOrigin}/src/panel/sidepanel.html`);
    const editor = panel.frameLocator('#chatgpt').locator('#prompt-textarea');
    await editor.waitFor();
    const example = await context.newPage();
    example.on('pageerror', error => errors.push(error.message));
    await example.goto('https://example.com/article');
    await example.locator('[data-chatgpt-selection-button]').waitFor({ state: 'attached' });
    await example.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('passage'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const widget = example.locator('[data-chatgpt-selection-button]');
    await widget.waitFor({ state: 'visible' });
    const box = await widget.boundingBox();
    await example.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await panel.waitForFunction(() => {
      const frame = document.querySelector('iframe');
      return Boolean(frame);
    });
    await editor.filter({ hasText: 'https://example.com/article' }).waitFor();
    const inserted = await editor.innerText();
    assert.ok(inserted.startsWith('Existing draft'));
    assert.ok(inserted.includes('A selected passage for ChatGPT.'));
    await widget.waitFor({ state: 'hidden' });
    await example.evaluate(() => {
      window.getSelection().removeAllRanges();
      const input = document.getElementById('private-input');
      input.focus();
      input.select();
    });
    await example.waitForTimeout(250);
    assert.equal(await widget.isVisible(), false);
    await example.evaluate(() => {
      document.getElementById('private-input').blur();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('passage'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await widget.waitFor({ state: 'visible' });
    await example.evaluate(() => window.getSelection().removeAllRanges());
    await widget.waitFor({ state: 'hidden' });
    const frame = panel.frames().find(item => item.url() === 'https://chatgpt.com/');
    assert.equal(await frame.evaluate(() => window.sends), 0);
    await panel.evaluate(() => {
      document.getElementById('chatgpt').contentWindow.postMessage({
        channel: 'chatgpt-sidepanel-context', type: 'insert', id: 'repeat-check',
        text: 'https://example.com/article\n\nA selected passage for ChatGPT.'
      }, 'https://chatgpt.com');
    });
    await panel.waitForTimeout(150);
    assert.equal(await editor.innerText(), inserted);
    await frame.evaluate(() => { document.getElementById('prompt-textarea').remove(); });
    await panel.evaluate(() => {
      document.getElementById('chatgpt').contentWindow.postMessage({
        channel: 'chatgpt-sidepanel-context', type: 'insert', id: 'delayed-check', text: 'https://example.com/delayed'
      }, 'https://chatgpt.com');
    });
    await frame.evaluate(() => {
      const area = document.createElement('textarea');
      area.id = 'prompt-textarea';
      area.value = 'Textarea draft';
      document.body.append(area);
    });
    await frame.waitForFunction(() => document.getElementById('prompt-textarea').value.includes('https://example.com/delayed'));
    assert.equal(await frame.locator('#prompt-textarea').inputValue(), 'Textarea draft\n\nhttps://example.com/delayed');
    const ordinaryChat = await context.newPage();
    await ordinaryChat.goto('https://chatgpt.com/');
    await ordinaryChat.evaluate(origin => {
      window.dispatchEvent(new MessageEvent('message', {
        origin, source: window, data: { channel: 'chatgpt-sidepanel-context', type: 'insert', id: 'invalid', text: 'should not insert' }
      }));
    }, extensionOrigin);
    assert.equal(await ordinaryChat.locator('#prompt-textarea').innerText(), 'Existing draft');
    await frame.evaluate(() => {
      history.pushState({}, '', '/c/test-conversation');
      document.getElementById('prompt-textarea').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await panel.waitForFunction(async () => {
      const stored = await chrome.storage.session.get(null);
      return Object.values(stored).some(value => value?.url === 'https://chatgpt.com/c/test-conversation');
    });
    await panel.close();
    const reopened = await context.newPage();
    await reopened.goto(`${extensionOrigin}/src/panel/sidepanel.html`);
    const reopenedEditor = reopened.frameLocator('#chatgpt').locator('#prompt-textarea');
    await reopenedEditor.filter({ hasText: 'Textarea draft' }).waitFor();
    assert.ok(reopened.frames().some(item => item.url() === 'https://chatgpt.com/c/test-conversation'));
    assert.ok((await reopenedEditor.innerText()).includes('https://example.com/delayed'));
    const windowId = await reopened.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const saved = await reopened.evaluate(async windowId => chrome.runtime.sendMessage({ type: 'get-panel-state', windowId }), windowId);
    const fresh = { url: 'https://chatgpt.com/', draft: '', revision: 'new-browser-test', fresh: true };
    await worker.evaluate(async ({ windowId, fresh }) => {
      await chrome.storage.session.set({ [`panel-state-${windowId}`]: fresh });
      await chrome.runtime.sendMessage({ type: 'new-chat', windowId, state: fresh });
    }, { windowId, fresh });
    await reopened.waitForFunction(() => document.getElementById('chatgpt').src === 'https://chatgpt.com/');
    await reopenedEditor.waitFor();
    await reopened.waitForFunction(async windowId => {
      const result = await chrome.runtime.sendMessage({ type: 'get-panel-state', windowId });
      return result.state.revision === 'new-browser-test' && result.state.fresh === false;
    }, windowId);
    assert.equal(await reopenedEditor.innerText(), '');
    await reopened.evaluate(async ({ windowId, saved }) => chrome.runtime.sendMessage({ type: 'save-panel-state', windowId, state: saved.state }), { windowId, saved });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ installedExtension: true, mode: 'mock website; no real ChatGPT account', selectionClick: true, draftPreserved: true, duplicatePrevented: true, delayedTextarea: true, ordinaryChatUnchanged: true, conversationRestored: true, newChatCleared: true, autoSendCount: 0 }, null, 2));
  } finally {
    await context.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
