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
    const chatBody = '<!doctype html><html><head><style>#prompt-textarea{min-height:24px}</style></head><body><div id="prompt-textarea" class="ProseMirror" contenteditable="true">Existing draft</div><button id="send">Send</button><script>window.sends=0;document.getElementById("send").onclick=()=>window.sends++;</script></body></html>';
    await context.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: exampleBody }));
    let paragraphEditor = false;
    await context.route('https://chatgpt.com/**', route => {
      if (new URL(route.request().url()).pathname === '/auth/login') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body><script>location.replace("/c/test-conversation");</script></body></html>'
        });
      }
      const body = paragraphEditor ? chatBody.replace('>Existing draft</div>', '><p>Existing draft</p></div>') : chatBody;
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const errors = [];
    const panel = await context.newPage();
    panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`${extensionOrigin}/src/panel/sidepanel.html`);
    const editor = panel.frameLocator('#chatgpt').locator('#prompt-textarea');
    await editor.waitFor();
    await panel.waitForFunction(() => document.getElementById('load-status').textContent === 'ChatGPT 已就绪');
    const topUrl = `${extensionOrigin}/src/panel/sidepanel.html`;
    const navigationRequest = { url: 'https://chatgpt.com/auth/login?next=%2F', initiator: 'https://chatgpt.com', topUrl, type: 'sub_frame' };
    const matchCases = [
      ['extension opens ChatGPT', { ...navigationRequest, initiator: extensionOrigin }, true],
      ['ChatGPT navigates itself', navigationRequest, true],
      ['auth returns to ChatGPT', { ...navigationRequest, initiator: 'https://auth.openai.com' }, true],
      ['ordinary ChatGPT tab', { ...navigationRequest, topUrl: 'https://chatgpt.com/', type: 'main_frame' }, false],
      ['ordinary website iframe', { ...navigationRequest, topUrl: 'https://example.com/article' }, false],
      ['other extension iframe', { ...navigationRequest, topUrl: `chrome-extension://${'a'.repeat(32)}/panel.html` }, false],
      ['other destination', { ...navigationRequest, url: 'https://auth.openai.com/' }, false],
      ['top-level navigation', { ...navigationRequest, type: 'main_frame' }, false]
    ];
    for (const [name, request, matches] of matchCases) {
      const result = await panel.evaluate(request => chrome.declarativeNetRequest.testMatchOutcome(request), request);
      assert.deepEqual(result.matchedRules.map(rule => rule.ruleId), matches ? [1] : [], name);
    }
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
    reopened.on('pageerror', error => errors.push(error.message));
    await reopened.goto(`${extensionOrigin}/src/panel/sidepanel.html`);
    const reopenedEditor = reopened.frameLocator('#chatgpt').locator('#prompt-textarea');
    await reopenedEditor.filter({ hasText: 'Textarea draft' }).waitFor();
    assert.ok(reopened.frames().some(item => item.url() === 'https://chatgpt.com/c/test-conversation'));
    assert.ok((await reopenedEditor.innerText()).includes('https://example.com/delayed'));
    const restoredDraft = await reopenedEditor.innerText();
    const reopenedFrame = reopened.frames().find(item => item.url() === 'https://chatgpt.com/c/test-conversation');
    const loginResponse = reopened.waitForResponse(response => response.url() === navigationRequest.url && response.status() === 200);
    await reopenedFrame.evaluate(url => { location.href = url; }, navigationRequest.url);
    await loginResponse;
    await reopenedEditor.filter({ hasText: 'Textarea draft' }).waitFor();
    await reopened.waitForFunction(() => document.getElementById('load-status').textContent === 'ChatGPT 已就绪');
    assert.equal(reopenedFrame.url(), 'https://chatgpt.com/c/test-conversation');
    assert.equal(await reopenedEditor.innerText(), restoredDraft);
    const refreshedResponse = reopened.waitForResponse(response => response.url() === 'https://chatgpt.com/c/test-conversation');
    await reopened.getByRole('button', { name: '刷新当前 ChatGPT 网页' }).click();
    await refreshedResponse;
    await reopenedEditor.filter({ hasText: 'Textarea draft' }).waitFor();
    assert.equal(await reopenedEditor.innerText(), restoredDraft);
    const windowId = await reopened.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const saved = await reopened.evaluate(async windowId => chrome.runtime.sendMessage({ type: 'get-panel-state', windowId }), windowId);
    await reopened.evaluate(() => {
      window.draftSnapshots = [];
      window.addEventListener('message', event => {
        if (event.source === document.getElementById('chatgpt').contentWindow && event.origin === 'https://chatgpt.com' && event.data?.channel === 'chatgpt-sidepanel-context' && event.data.type === 'state') {
          window.draftSnapshots.push(event.data);
        }
      });
    });
    const draftCases = ['first\nsecond', 'first\n\nsecond', 'first\n\n\nsecond', '\nfirst\n\n', '\n\n', 'first\n', '<b>literal</b>\n中文'];
    for (const paragraphs of [false, true]) {
      paragraphEditor = paragraphs;
      for (const [index, draft] of draftCases.entries()) {
        const state = { ...saved.state, draft, revision: `multiline-${paragraphs}-${index}`, fresh: false };
        for (let round = 0; round < 3; round++) {
          await reopened.evaluate(() => { window.draftSnapshots = []; });
          const navigated = reopened.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() === reopened.mainFrame() && frame.url() === state.url });
          if (round === 0) {
            await worker.evaluate(async ({ windowId, state }) => {
              await chrome.storage.session.set({ [`panel-state-${windowId}`]: state });
              await chrome.runtime.sendMessage({ type: 'new-chat', windowId, state });
            }, { windowId, state });
          } else {
            await reopened.getByRole('button', { name: '刷新当前 ChatGPT 网页' }).click();
          }
          await navigated;
          await reopened.waitForFunction(revision => window.draftSnapshots.some(snapshot => snapshot.revision === revision), state.revision);
          const snapshot = await reopened.evaluate(() => window.draftSnapshots.at(-1));
          assert.equal(snapshot.draft, draft, `paragraphs=${paragraphs}, case=${index}, round=${round}`);
          await reopened.waitForFunction(async ({ windowId, draft, revision }) => {
            const result = await chrome.runtime.sendMessage({ type: 'get-panel-state', windowId });
            return result.state.revision === revision && result.state.draft === draft;
          }, { windowId, draft, revision: state.revision });
          const currentFrame = reopened.frames().find(item => item.url() === state.url);
          assert.equal(await currentFrame.evaluate(() => window.sends), 0);
        }
      }
    }
    await reopened.evaluate(() => {
      window.insertReplies = [];
      window.addEventListener('message', event => {
        if (event.source === document.getElementById('chatgpt').contentWindow && event.origin === 'https://chatgpt.com' && event.data?.channel === 'chatgpt-sidepanel-context') {
          window.insertReplies.push(event.data);
        }
      });
    });
    async function postToEditor(message, repeat = 1) {
      await reopened.evaluate(({ message, repeat }) => {
        for (let index = 0; index < repeat; index++) {
          document.getElementById('chatgpt').contentWindow.postMessage({ channel: 'chatgpt-sidepanel-context', ...message }, 'https://chatgpt.com');
        }
      }, { message, repeat });
    }
    const insertionCases = ['line\n  indented text', 'double  spaces', 'tab\ttext', 'no\u00a0break'];
    for (const paragraphs of [false, true]) {
      paragraphEditor = paragraphs;
      const state = { url: saved.state.url, draft: '', revision: `insertions-${paragraphs}`, fresh: true };
      const navigated = reopened.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() === reopened.mainFrame() && frame.url() === state.url });
      await worker.evaluate(async ({ windowId, state }) => {
        await chrome.storage.session.set({ [`panel-state-${windowId}`]: state });
        await chrome.runtime.sendMessage({ type: 'new-chat', windowId, state });
      }, { windowId, state });
      await navigated;
      await reopened.waitForFunction(revision => window.insertReplies.some(message => message.type === 'restored' && message.revision === revision), state.revision);
      const currentFrame = reopened.frames().find(item => item.url() === state.url);
      for (const [index, text] of insertionCases.entries()) {
        const id = `whitespace-${paragraphs}-${index}`;
        const marker = `INSERT_MARK_${index}`;
        const message = { type: 'insert', id, text: `https://example.com/${id}\n\n${marker} ${text}` };
        await postToEditor(message, 3);
        await reopened.waitForFunction(id => window.insertReplies.some(message => message.type === 'inserted' && message.id === id), id);
        await postToEditor(message, 3);
        assert.equal((await reopenedEditor.textContent()).split(marker).length - 1, 1, id);
      }
      await currentFrame.evaluate(() => {
        window.changedWrites = 0;
        window.delayedWrites = 0;
        document.getElementById('prompt-textarea').addEventListener('input', event => {
          const editor = event.currentTarget;
          if (editor.textContent.includes('EXPECTED_TOKEN')) {
            window.changedWrites++;
            editor.textContent = editor.textContent.replaceAll('EXPECTED_TOKEN', 'CHANGED_TOKEN');
          }
          if (editor.textContent.includes('DELAYED_TOKEN') && !window.delayedWrites) {
            window.delayedWrites++;
            const html = editor.innerHTML;
            editor.textContent = 'Editor updating';
            setTimeout(() => { editor.innerHTML = html; }, 600);
          }
        });
      });
      const failedId = `changed-${paragraphs}`;
      const changed = { type: 'insert', id: failedId, text: 'https://example.com/changed\n\nFAILURE_MARK EXPECTED_TOKEN' };
      await postToEditor(changed, 3);
      await reopened.waitForFunction(id => window.insertReplies.some(message => message.type === 'insert-failed' && message.id === id), failedId);
      await postToEditor(changed, 3);
      await reopened.waitForTimeout(350);
      assert.equal(await currentFrame.evaluate(() => window.changedWrites), 1);
      assert.equal((await reopenedEditor.textContent()).split('FAILURE_MARK').length - 1, 1);
      assert.equal(await reopened.evaluate(id => window.insertReplies.some(message => message.type === 'inserted' && message.id === id), failedId), false);
      const delayedId = `delayed-confirmation-${paragraphs}`;
      await postToEditor({ type: 'insert', id: delayedId, text: 'https://example.com/delayed-confirmation\n\nDELAYED_TOKEN' }, 3);
      await reopened.waitForFunction(id => window.insertReplies.some(message => message.type === 'inserted' && message.id === id), delayedId);
      assert.equal(await currentFrame.evaluate(() => window.delayedWrites), 1);
      assert.equal((await reopenedEditor.textContent()).split('DELAYED_TOKEN').length - 1, 1);
      for (const [index] of insertionCases.entries()) {
        assert.equal((await reopenedEditor.textContent()).split(`INSERT_MARK_${index}`).length - 1, 1);
      }
      assert.equal(await currentFrame.evaluate(() => window.sends), 0);
      const failedRestore = { ...state, revision: `restore-failure-${paragraphs}`, draft: 'EXPECTED_TOKEN', fresh: false };
      const writesBeforeRestore = await currentFrame.evaluate(() => window.changedWrites);
      await postToEditor({ type: 'restore', state: failedRestore }, 3);
      await reopened.waitForFunction(revision => window.insertReplies.some(message => message.type === 'restore-failed' && message.revision === revision), failedRestore.revision);
      await postToEditor({ type: 'restore', state: failedRestore }, 3);
      await reopened.waitForTimeout(350);
      assert.equal(await currentFrame.evaluate(() => window.changedWrites), writesBeforeRestore + 1);
      assert.equal(await reopened.evaluate(revision => window.insertReplies.some(message => message.type === 'restored' && message.revision === revision), failedRestore.revision), false);
    }
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
    await example.evaluate(() => {
      const passage = document.getElementById('passage');
      passage.textContent = 'END_TO_END_MARK\n  indented selection';
      const range = document.createRange();
      range.selectNodeContents(passage);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await widget.waitFor({ state: 'visible' });
    const indentedBox = await widget.boundingBox();
    await example.mouse.click(indentedBox.x + indentedBox.width / 2, indentedBox.y + indentedBox.height / 2);
    await reopenedEditor.filter({ hasText: 'END_TO_END_MARK' }).waitFor();
    await reopened.waitForFunction(async windowId => {
      const result = await chrome.runtime.sendMessage({ type: 'get-context', windowId });
      return result.ok && result.items.length === 0;
    }, windowId);
    await reopened.waitForTimeout(1800);
    assert.equal((await reopenedEditor.textContent()).split('END_TO_END_MARK').length - 1, 1);
    assert.equal(await reopened.frames().find(item => item.url() === 'https://chatgpt.com/').evaluate(() => window.sends), 0);
    await reopened.evaluate(async ({ windowId, saved }) => chrome.runtime.sendMessage({ type: 'save-panel-state', windowId, state: saved.state }), { windowId, saved });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ installedExtension: true, mode: 'mock website; Chrome rule matcher; no real ChatGPT account', ruleScopeCases: matchCases.length, multilineDraftCases: draftCases.length * 2, restoreRoundsPerCase: 3, whitespaceInsertionCases: insertionCases.length * 2, failedConfirmationStops: true, delayedConfirmationSingleWrite: true, failedRestoreStops: true, indentedSelectionQueueCleared: true, selfNavigationRestored: true, loginReturnRestored: true, refreshRestored: true, selectionClick: true, draftPreserved: true, duplicatePrevented: true, delayedTextarea: true, ordinaryChatUnchanged: true, conversationRestored: true, newChatCleared: true, autoSendCount: 0 }, null, 2));
  } finally {
    await context.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
