# raw-browser (raw)

**直接驱动你已登录的 Chrome / Edge —— 一段脚本，一个完整任务。**

零运行时依赖的浏览器自动化运行时、CLI 与 MCP server，为 AI Agent 设计。
不新开 profile，不重新登录，不再「点一下 → 看一眼」。

[![ci](https://github.com/liutingqiu/raw-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/liutingqiu/raw-browser/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/liutingqiu/raw-browser)](https://github.com/liutingqiu/raw-browser/releases)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.21.0-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) | 简体中文

![raw-browser 演示：一段脚本完成搜索、选择与导出](assets/demo.gif)

*演示本身就是一段脚本：快照、点击、输入、选择、导出。[MP4 版本](assets/demo.mp4)。*

---

## 快速开始

需要 **Node.js 22.21+**，以及 Chrome 或 Edge。

```bash
npm install -g raw-browser
raw status
raw run -e "const p = await page.newTab('https://example.com'); console.log(await p.title()); await p.closeTab()"
```

直连 CDP 模式下，首次运行会在 `~/.raw/` 下启动一个专用浏览器 profile，并在
多次运行之间保留，登录状态不会丢。

或者从源码安装：

```bash
git clone https://github.com/liutingqiu/raw-browser.git
cd raw-browser
npm install
npm run build
npm link
raw status
```

需要固定版本或离线安装时，可以用每个
[Release](https://github.com/liutingqiu/raw-browser/releases/latest) 附带的
`raw-browser.tgz`。扩展桥安装脚本在 npm 包和克隆仓库里都有；全局安装时用
`$(npm root -g)\raw-browser\scripts\install-edge-bridge.ps1` 运行。

## 为什么是 raw-browser

- **就是你的浏览器。** 扩展桥挂载到你日常使用的 Chrome / Edge profile，
  登录态、Cookie、扩展本来就在那里。
- **一段脚本，一个任务。** 多步任务写成一个带循环、条件、等待的 JavaScript
  程序，而不是每点一次就模型往返一次。轮次更少、成本更低、状态不用反复重读。
- **运行时零依赖。** 只用 Node 内置的 `fetch` 与 `WebSocket`；`npm install`
  只安装开发用的 TypeScript 和 Node 类型。

## 一段脚本，一个任务

```js
const p = await page.newTab('https://app.example.com/orders');

const snapshot = await p.snapshot({ scope: 'viewport' });
console.log(snapshot);                       // 带编号的元素：[0]、[1]……

await p.click('role=button[name="Search"]');
await p.fill('role=textbox', 'Initech');
await p.click('text=Initech');

const file = await p.waitForDownload(() => p.click('text=Export CSV'));
console.log(file.path);                      // orders.csv 已落盘
await p.closeTab();
```

从文件运行：

```bash
node dist/browser-cli.js run < demo/example.mjs
```

或者直接内联：

```bash
raw run -e "const p = await page.newTab('example.com'); console.log(await p.snapshot()); await p.closeTab()"
```

## 能力概览

| 方面 | 能力 |
|---|---|
| **定位器** | 快照编号（`#12`）、CSS、XPath、`text=`、`:has-text()`、`role=…[name=…]`；穿透开放 Shadow DOM 与同源 iframe |
| **输入** | 真实 CDP 鼠标/键盘事件、按键位掩码、拖拽路径插值、组合键、文件选择 |
| **富文本编辑器** | Monaco、CodeMirror 5/6、contenteditable、React 受控输入，并回报实际使用的写入策略 |
| **等待** | 导航、弹窗、下载、文件选择框、DOM 变更、网络响应、函数与 URL |
| **读取** | 编号快照、无障碍树、文本/HTML、frame 列表（含跨域） |
| **浏览器能力** | 标签页、Cookie、代理、历史、书签、扩展、下载、通知、CSS 注入 |
| **隔离** | `--space` 创建独立 Cookie / 缓存 / 存储的浏览器上下文（直连 CDP 模式） |
| **Agent 集成** | CLI、JavaScript 脚本 API、16 个工具的 MCP server |

完整脚本 API 见 [docs/API.md](docs/API.md)。

## 常见问题

**这是 Playwright 的替代品吗？**
Playwright 是完整的测试框架，自带浏览器上下文、runner 和断言。`raw` 是给
Agent 用的小型运行时：它可以驱动你已经登录的 profile，并把一段脚本当作一个
任务。两者解决的问题不同，可以共存。

**它会隐藏自动化、绕过反爬吗？**
不会。没有 stealth 补丁，不覆盖 `navigator.webdriver`，不做指纹伪造。拦截
自动化的站点仍然能看到调试器已挂载。

**会上传 Cookie 或页面数据吗？**
不会。运行时与桥接只在本机工作，监听 `127.0.0.1`。页面内容，以及脚本显式
请求的 Cookie 值，会交给调用它的 Agent，因此边界是 Agent 的权限模式。

**支持哪些浏览器？**
Chrome 与 Microsoft Edge（Chromium）。直连 CDP 模式也可以驱动其他 Chromium
构建。

## 工作原理

![raw-browser 架构](assets/architecture.svg)

有两条到达浏览器的路径：

1. **直连 CDP** —— `raw` 用 `--remote-debugging-port` 启动一个专用 Chromium
   profile（默认 `9222`）。跨平台、支持隔离 space、不需要扩展。
2. **扩展桥** —— MV3 扩展用 `chrome.debugger` 挂到真实标签页，通过 stdio 与
   .NET 原生宿主通信；宿主在本地回环暴露带 token 的 CDP facade。Edge 用
   `9333`，Chrome 用 `9334`。这条路径驱动的就是你已登录的 profile。

桥接只监听 `127.0.0.1`，每个浏览器一份随机 token，校验 `Host` 头，并拒绝
不属于自己的调试端口。扩展不会自行复制或记录 Cookie；只有脚本显式调用
Cookie API 时才会返回 Cookie 值。

## 驱动已登录的浏览器

桥接安装脚本目前是 Windows PowerShell；直连 CDP 模式支持 Windows / macOS / Linux。

```powershell
# 全局 npm 安装
powershell -ExecutionPolicy Bypass -File "$(npm root -g)\raw-browser\scripts\install-edge-bridge.ps1" -Browser both

# 源码克隆
powershell -ExecutionPolicy Bypass -File scripts/install-edge-bridge.ps1 -Browser both
```

安装脚本会发布自包含的原生宿主，生成独立的
`~/.raw/edge-bridge.json` 与 `~/.raw/chrome-bridge.json`，并注册所选浏览器的
Native Messaging 宿主。没有 .NET 9 SDK 时，它会从
[Releases](https://github.com/liutingqiu/raw-browser/releases) 下载匹配版本的
预编译宿主，并在有 `SHA256SUMS.txt` 时校验。也可以用 `-HostPath <exe>`
安装自己编译的宿主，或用 `-BuildFromSource` 强制本地编译。

然后在每个要驱动的浏览器里加载一次解压扩展：

1. 打开 `edge://extensions` 或 `chrome://extensions`；
2. 开启「开发人员模式」；
3. 选择「加载解压缩的扩展」，指向安装器输出的 `ExtensionPath`
   （克隆仓库里是 `edge-bridge/extension`）。

在 `~/.raw/browser-profiles/current.json` 中选择桥：

```json
{ "mode": "edge-extension" }
```

或 `{ "mode": "chrome-extension" }`。`raw status` 会显示当前桥、端口和扩展版本。
如果升级后桥接没有连上，重启一次浏览器：它会在进程生命周期内缓存
Native Messaging 宿主路径。从旧版安装脚本升级的用户，重启浏览器后再运行一次
安装脚本并加上 `-CleanLegacyHosts`，即可删除旧的 `host-*` 目录。

## CLI

| 命令 | 说明 |
|---|---|
| `raw status` | 显示调试端口、桥、profile 与浏览器路径 |
| `raw run` | 从 stdin 读取脚本执行 |
| `raw run -e "<code>"` | 执行内联脚本 |

| 选项 | 说明 |
|---|---|
| `--timeout-ms N` | 脚本超时（默认 `180000`） |
| `--space NAME` | 在隔离的浏览器上下文中运行（直连模式） |
| `--headless` | 浏览器未运行时以无界面启动 |
| `--profile PATH` | 覆盖持久化 profile 目录 |
| `--port N` | 覆盖 CDP 端口 |
| `--browser PATH` | 指定 Chrome / Edge 可执行文件 |
| `--downloads PATH` | 覆盖下载目录 |
| `--output-dir PATH` | 内联图片的落盘目录 |

## MCP server

`mcp/raw-browser-mcp.mjs` 把运行时暴露为 16 个 MCP 工具：`raw_use`、
`raw_status`、`raw_tabs`、`raw_new`、`raw_goto`、`raw_text`、`raw_html`、
`raw_eval`、`raw_snapshot`、`raw_click`、`raw_fill`、`raw_visit`、
`raw_screenshot`、`raw_cookies`、`raw_frames`，以及逃生舱 `raw_call`。

```json
{
  "mcpServers": {
    "raw-browser": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/raw-browser/mcp/raw-browser-mcp.mjs"],
      "env": { "RAW_BRIDGE_BROWSER": "edge" }
    }
  }
}
```

服务端会记住当前标签页，截图以 image content 返回，工具调用串行执行，并支持
取消。`raw-bridge.mjs` 不在服务端旁边时用 `RAW_CLI` 指定；用
`RAW_BRIDGE_BROWSER=edge|chrome` 选择桥。

## 安全模型

- 所有监听器只绑定 `127.0.0.1`，默认拒绝远程连接。
- 每个 HTTP / WebSocket 请求都需要对应浏览器的 token；比较为常数时间，
  并校验 `Host` 头。
- 属于其他进程的调试端口会被拒绝，而不是复用。
- 脚本运行在 worker 中，超时可以终止 CPU 密集代码。worker 是超时边界，
  **不是安全沙箱**。
- `clearBrowsingData` 只清除调用方明确指定的数据类型。
- 页面内容是不可信输入；不要把未校验的网页文本拼进 shell 命令。

`raw` 以当前操作系统用户的权限执行模型生成的脚本。调用它的 Agent 的提示词与
权限模式才是动作边界。详见 [SECURITY.md](SECURITY.md)。

## 测试

```bash
npm run typecheck   # 严格 TypeScript 检查
npm test            # 51 个单元测试
npm run build
npm run smoke:browser
npm run check       # 以上全部 + 浏览器冒烟测试
```

CI 在 Ubuntu / Windows / macOS × Node 22/24/26 上跑完整套件，另有 Windows
桥接宿主冒烟测试和依赖审计。

## 已知限制

1. **桥接安装脚本目前仅限 Windows。** 直连 CDP 模式跨平台。
2. **单标签页单调试器。** Chromium 同一标签页只允许一个 CDP 调试客户端；
   并发挂载会互相 detach。
3. **桥接模式不支持 `--space`。** 扩展无法创建
   `Target.createBrowserContext` 的等价物。
4. **浏览器大版本会改变地基。** Chromium 升级偶尔会改变调试行为或权限提示；
   升级后重新加载扩展或重启浏览器即可。

## 参与贡献

欢迎 issue 与 pull request。见 [CONTRIBUTING.md](CONTRIBUTING.md) 与
[更新日志](CHANGELOG.md)。安全问题请按 [SECURITY.md](SECURITY.md) 使用
GitHub 私有漏洞报告。

如果 raw-browser 帮你省下了几次模型往返，点个 star 能让更多人看到它。

## 开源许可

[MIT](LICENSE)
