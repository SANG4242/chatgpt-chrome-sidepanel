# ChatGPT Chrome Side Panel

[中文](#中文) · [English](#english)

## 中文

在 Chrome 侧栏使用 ChatGPT 原网页，按需带入当前网页链接或选中文字。使用你自己的 ChatGPT 账号，不需要 API Key。

这是独立项目，与 OpenAI 无关联。当前版本为预发布，ChatGPT 页面更新可能影响兼容性。

### 安装

**[下载发行包](https://github.com/SANG4242/chatgpt-chrome-sidepanel/releases)**：打开最新版本，下载 `chatgpt-chrome-sidepanel-v版本号.zip`，不要下载自动生成的 `Source code` 包。

1. 解压 ZIP，保留文件夹。无需安装 Node.js 或运行命令。
2. 在 Chrome 地址栏输入 `chrome://extensions`，开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择包含 `manifest.json` 的文件夹。

将扩展固定到工具栏。先在同一 Chrome 用户配置中登录 [ChatGPT](https://chatgpt.com/)，再打开侧栏。

### 使用

| 操作 | 功能 |
| --- | --- |
| 点击扩展图标 / `Ctrl+G` | 打开或收起侧栏，继续上次对话 |
| `Alt+G` | 打开侧栏，将当前网页链接追加到输入框 |
| `Ctrl+Shift+G` | 新建对话，清空当前侧栏草稿 |
| 选中文字 → 点击「问问 ChatGPT」 | 将页面链接和选中文字追加到输入框 |

内容只填入草稿，**不会自动发送**。普通开关恢复本次 Chrome 会话中的对话地址和文字草稿；不恢复附件、滚动位置或正在生成的页面状态。退出 Chrome、停用或重新加载扩展会结束恢复缓存。

快捷键有冲突时，在 `chrome://extensions/shortcuts` 设置。新对话快捷键也可以改为 `Alt+Shift+G`。要把侧栏放在右边，在 `chrome://settings/appearance` 的侧栏设置中选择右侧显示。

### 更新与排错

- **更新**：关闭侧栏，将新版文件覆盖到原安装文件夹，在 `chrome://extensions` 点击重新加载，再刷新普通网页。开发者模式安装不会自动更新，请勿删除安装文件夹。
- **划词按钮未出现**：确认扩展的网站访问权限为「在所有网站上」，刷新页面后重新选中文字。输入框、Chrome 设置、扩展商店和内置 PDF 阅读器等页面不支持。部分网站可能仍有兼容问题。
- **ChatGPT 空白或验证循环**：先在普通标签页检查访问、登录和验证状态，再关闭重开侧栏。无需导出 Cookie，也不要关闭浏览器的全局安全功能。
- **链接无法读取**：传入链接不等于上传网页正文；需要登录的网站或内网页面可能无法由 ChatGPT 访问。

### 权限与安全

- HTTP/HTTPS 网站访问权限用于显示划词按钮；选区在本机检测，点击按钮后才传入链接和文字。`Alt+G` 只传入当前链接，不抓取整页正文。
- 扩展不读取 Cookie、不保存浏览历史，也不把内容发送到项目作者的服务器。填入 ChatGPT 的内容受 ChatGPT 自身的数据处理规则约束。
- 待填内容和侧栏恢复状态保存在 `chrome.storage.session` 中，不使用云同步。待填内容成功填入后删除，超过五分钟不再填入。
- 为支持嵌入，扩展移除由本扩展发起的 ChatGPT 内嵌页面响应中的 `X-Frame-Options` 和整个 `Content-Security-Policy`。这会减少该内嵌页面的浏览器端安全保护；普通标签页不应用这条规则。
- 网页链接可能包含私密参数，发送前请检查草稿。请在理解上述权限和限制后使用。

### 开发

Node.js 18+、Python 3.9+。无第三方构建依赖。

```sh
npm run check
npm test
npm run build
```

发行 ZIP 输出到 `dist/`。推送与 `manifest.json` 版本一致的 `v*` 标签后，GitHub Actions 会检查、打包并创建预发布版本。

可选浏览器验收：先安装 Playwright 和可加载扩展的测试 Chromium，再设置 `PLAYWRIGHT_ROOT` 为 Playwright 包的绝对路径、`TEST_CHROME` 为浏览器可执行文件路径，运行 `node tests/browser-check.cjs`。此测试使用模拟网页，不登录真实 ChatGPT。

## English

Use the ChatGPT website in Chrome's side panel. Add the current page URL or selected text to your draft when needed. Uses your own ChatGPT account; no API key required.

This is an independent project, not affiliated with OpenAI. The current version is a prerelease. Changes to the ChatGPT website may affect compatibility.

### Install

**[Download a release](https://github.com/SANG4242/chatgpt-chrome-sidepanel/releases)**: open the newest version and download `chatgpt-chrome-sidepanel-vVERSION.zip`, not the automatically generated `Source code` archive.

1. Extract the ZIP and keep the folder. No Node.js, build step, or terminal commands required.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the folder containing `manifest.json`.

Pin the extension to the toolbar. Sign in to [ChatGPT](https://chatgpt.com/) in a regular tab using the same Chrome profile, then open the side panel.

### Use

| Action | Result |
| --- | --- |
| Toolbar icon / `Ctrl+G` | Open or close the panel; continue the previous conversation |
| `Alt+G` | Open the panel and append the current page URL to the composer |
| `Ctrl+Shift+G` | Start a new chat and clear the current panel draft |
| Select text → click “问问 ChatGPT” | Append the page URL and selected text to the composer |

Text is added to the draft and **never sent automatically**. Reopening restores the conversation URL and text draft within the current Chrome session. Attachments, scroll position, and an ongoing generation's page state are not restored. Closing Chrome, disabling, or reloading the extension clears the restore cache.

Set shortcuts at `chrome://extensions/shortcuts` if they conflict. You can change the new-chat shortcut to `Alt+Shift+G`. Choose the right-hand side panel position in `chrome://settings/appearance`.

### Update and troubleshoot

- **Update**: close the panel, replace the files in the existing installation folder, reload the extension at `chrome://extensions`, and refresh regular web pages. Unpacked installations do not update automatically. Keep the installation folder.
- **Selection button missing**: allow site access on all sites, refresh the page, and select text again. Input fields, Chrome settings, the extension store, and the built-in PDF viewer are not supported. Some sites may still have compatibility issues.
- **Blank page or verification loop**: check access, sign-in, and verification in a regular ChatGPT tab, then reopen the panel. Do not export cookies or disable global browser security settings.
- **ChatGPT cannot read a link**: a URL does not include the page body. Private, signed-in, or intranet pages may be inaccessible to ChatGPT.

### Permissions and security

- HTTP/HTTPS site access is used for the selection button. Selections are detected locally; their URL and text are passed only when you click the button. `Alt+G` passes only the current URL, not the page body.
- The extension does not read cookies, store browsing history, or send content to the project author's servers. Content entered into ChatGPT is subject to ChatGPT's own data handling practices.
- Pending text and panel state are kept in `chrome.storage.session`, without cloud sync. Pending text is removed after insertion and is not inserted after five minutes.
- To embed ChatGPT, the extension removes `X-Frame-Options` and the entire `Content-Security-Policy` header from ChatGPT subframe responses initiated by this extension. This reduces browser-side protections for that embedded page. The rule does not apply to regular tabs.
- URLs may contain private parameters. Review the draft before sending, and use the extension only if you accept these permissions and limitations.

### Development

Node.js 18+ and Python 3.9+. No third-party build dependencies.

```sh
npm run check
npm test
npm run build
```

The ZIP is written to `dist/`. Pushing a `v*` tag matching the version in `manifest.json` runs checks, builds the archive, and creates a GitHub prerelease.

For optional browser checks, install Playwright and a test Chromium that supports extension loading. Set `PLAYWRIGHT_ROOT` to the absolute Playwright package directory and `TEST_CHROME` to the browser executable, then run `node tests/browser-check.cjs`. These tests use mock pages, not a real ChatGPT account.

## License

Project code: [MIT](LICENSE). Icon attribution and license: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). OpenAI and ChatGPT names and marks belong to their respective owners; the software license does not grant trademark rights.
