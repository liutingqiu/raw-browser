# Scripting API

A `raw` script runs in a worker thread with four names in scope:

| Name | What it is |
|---|---|
| `page` | a `PageHandle` for the current tab |
| `space` | `space(name)` → an isolated browser context (direct CDP mode only) |
| `sleep` | `sleep(ms)` → a promise |
| `console` | `log` / `info` / `warn` / `error`, collected into the tool result |

The script may use top-level `await`. Its return value is printed after any
`console.log` output. The worker is terminated when the script exceeds
`--timeout-ms`, including CPU-bound loops.

```js
await page.goto('https://example.com');
console.log(await page.title());
return { title: await page.title() };
```

## Locators

Every method that takes a selector accepts the same locator syntax:

| Locator | Example | Notes |
|---|---|---|
| Snapshot index | `12` or `'#12'` | refers to the numbered element from `page.snapshot()` |
| CSS | `'button.primary'`, `'css=#export'` | crosses open shadow roots and same-origin iframes |
| XPath | `'xpath=//button[text()="Save"]'` | evaluated in the top document and same-origin frames |
| Text | `'text=Export CSV'`, `':has-text("Export")'` | case-insensitive substring; smallest matching element wins |
| ARIA role | `'role=button'`, `'role=button[name="Export"]'` | `button`, `link`, `textbox`, `checkbox`, `combobox`, or any `[role=…]` |

Locator resolution never mutates the page: snapshot indices live in a
JavaScript `Map`, not in `data-*` attributes, so a snapshot cannot trigger the
page's own `MutationObserver`s.

## Page and tabs

| Method | Description |
|---|---|
| `page.newTab(url?, { active? })` | open a tab and return its own `PageHandle` |
| `page.attachTab(selector)` | attach to an existing tab by exact target id or exact URL |
| `page.switchTab(selector)` | activate and attach to an existing tab |
| `page.activateTab(selector?)` | bring this tab (or another) to the front |
| `page.closeTab(selector?)` | close the real browser tab |
| `page.restoreClosedTab()` | restore the most recently closed tab (bridge mode) |
| `page.followPopup({ timeoutMs? })` | attach to a tab created after this handle |
| `page.waitForPopup(action, { timeoutMs? })` | run an action, attach only to a tab it creates |
| `page.tabs()` | list `{ id, title, url, active, windowId, attached }` |
| `page.targetId()` | stable CDP target id |
| `page.close()` | close the handle, leave the tab open |

## Navigation

| Method | Description |
|---|---|
| `page.goto(url, timeoutMs?)` | navigate and wait for load or same-document navigation |
| `page.reload(timeoutMs?)` | reload and wait |
| `page.back(timeoutMs?)` | history back and wait |
| `page.url()` / `page.title()` | current URL / title |
| `page.waitForNavigation(action, { timeoutMs? })` | arm the load listener, then run the action |
| `page.waitForLoadState('load' \| 'domcontentloaded' \| 'networkidle', { timeout?, idleMs? })` | wait for a document state |

`goto` preserves `file:`, `data:`, `about:`, `edge:` and `chrome:` URLs and adds
`https://` only to bare host names.

## Reading

| Method | Description |
|---|---|
| `page.snapshot({ scope?, root?, max? })` | numbered interactive elements plus visible text |
| `page.text(selector?)` | `innerText` of an element or the body |
| `page.html(selector?)` | `outerHTML` of an element or the document |
| `page.eval(js)` | evaluate a JavaScript expression in the page |
| `page.find(selector)` | describe one element (`tag`, `text`, `value`, `href`, `box`) |
| `page.findAll(selector)` | describe every match (max 50) |
| `page.count(selector)` | number of matches |
| `page.axSnapshot({ max?, interestingOnly? })` | accessibility tree from CDP |
| `page.frames({ tabId? })` | every frame in a tab, including cross-origin frames (bridge mode) |

## Input

| Method | Description |
|---|---|
| `page.click(selector, { double?, button?, modifiers? })` | real mouse press/release at the element's centre |
| `page.dblclick(selector, { modifiers? })` | double click |
| `page.hover(selector, { steps?, delay? })` | move the real pointer onto an element |
| `page.mouseMove(x, y, { steps?, delay?, modifiers? })` | move to viewport coordinates |
| `page.mouseDown(x, y, { button?, modifiers? })` / `page.mouseUp(...)` | hold / release a button |
| `page.dragAndDrop(source, target, { steps?, delay?, modifiers?, dropDelay? })` | paced drag path for canvas editors |
| `page.setValue(selector, value, { append?, notifyChange? })` | write into native inputs, contenteditable, Monaco, CodeMirror 5/6 and React-controlled fields |
| `page.fill(selector, value, { clearFirst? })` | `setValue` with a readable result |
| `page.type(selector, value)` | alias of `fill` |
| `page.press(key)` | a key or chord: `Enter`, `Control+A`, `Meta+Shift+P` |
| `page.typeText(text, { delay? })` | type into the focused element; `delay` sends real key events |
| `page.selectOption(selector, value \| { value?, label?, index? })` | select an `<option>` and dispatch `input` + `change` |
| `page.setInputFiles(selector, file \| files[])` | attach files to a file input |
| `page.scroll(dy?)` | scroll the window, returns `scrollY` |

## Waiting

| Method | Description |
|---|---|
| `page.sleep(ms)` | pause the script |
| `page.waitForSelector(selector, { timeout?, state? })` | `attached`, `visible`, `hidden`, `detached` |
| `page.waitForMutation(selector, { timeout?, state?, text? })` | `MutationObserver`-backed wait |
| `page.waitForFunction(fnOrExpr, { timeout?, polling? })` | await a predicate; async predicates are awaited |
| `page.waitForURL(pattern, { timeout? })` | wait for the URL to match a string or RegExp |
| `page.waitForResponse(url \| RegExp \| predicate, { timeout?, resourceType?, status? })` | wait for a matching network response |
| `page.waitForLoadState(...)` | see Navigation |

## Downloads and files

| Method | Description |
|---|---|
| `page.waitForDownload(action, { timeoutMs? })` | arm the listener, run the action, return `{ id, path, filename, bytes, url }` |
| `page.waitForDownload({ timeoutMs? })` | wait for a download started elsewhere |
| `page.downloads()` | download records for this run |
| `page.download(url, { filename?, saveAs? })` | start a download through the browser (bridge mode) |
| `page.cancelDownload(id)` | cancel a download |
| `page.waitForFileChooser({ timeoutMs? })` | intercept the picker, then `setFiles(path \| paths[])` |

Always prefer the action form:

```js
const file = await page.waitForDownload(() => page.click('#export'), { timeoutMs: 20_000 });
```

## Screenshots

```js
const shot = await page.screenshot({
  path: 'out.png',        // default: ~/.raw/downloads/screenshot-*.png
  fullPage: false,
  format: 'png',          // or 'jpeg'
  quality: 70,            // jpeg only
  element: '#chart',      // element clip
  clip: { x, y, width, height, scale }, // viewport clip
  inline: false,          // don't attach to the tool result
});
```

`format`, `quality`, `element` and `clip` are optional. `inline: false` avoids
the 4-image tool-result limit when capturing many frames.

## Browser surfaces

These use the extension bridge's full browser authority and throw
`requires the extension bridge` in direct CDP mode.

| Method | Description |
|---|---|
| `page.cookies(details?)` / `page.cookie(details)` | list / read cookies |
| `page.setCookie(details)` / `page.removeCookie(details)` | write / delete a cookie |
| `page.proxy()` / `page.setProxy(value, { scope? })` / `page.clearProxy({ scope? })` | read / set / clear proxy settings |
| `page.history({ text?, maxResults?, startTime?, endTime? })` | search browser history |
| `page.bookmarks()` | list bookmarks |
| `page.extensions()` | list installed extensions |
| `page.setExtensionEnabled(id, enabled?)` | enable/disable an extension (never itself) |
| `page.clearBrowsingData({ cookies?, cache?, history?, … }, { since?, origins? })` | clear named data types only |
| `page.updateTab(update, { tabId? })` | update tab properties |
| `page.notify(title, message, { silent? })` | desktop notification |
| `page.insertCSS(css, { tabId?, allFrames? })` / `page.removeCSS(...)` | inject / remove CSS |

## Dialogs, handoff, escape hatches

| Method | Description |
|---|---|
| `page.setDialogPolicy('auto' \| 'accept' \| 'dismiss')` | `auto` accepts everything except `beforeunload` |
| `page.dialog()` | last dialog `{ type, message, at }` |
| `page.handoff(message, { timeoutMs? })` | ask a human for input (MCP/agent integrations) |
| `page.fetch(url, { method?, headers?, body?, saveAs? })` | page-context fetch with the profile's cookies |
| `page.cdpSend(method, params)` | raw page-scoped CDP |
| `page.browserCdpSend(method, params)` | raw browser-scoped CDP |
| `page.on(event, listener)` | subscribe to a CDP event; returns an unsubscribe function |

## Isolated spaces

`--space <name>` (CLI) or `space('<name>')` (script) creates a browser context
with its own cookies, cache and storage:

```js
const isolated = await space('checkout-test').page();
await isolated.goto('https://example.com');
// … other spaces do not see these cookies
```

Spaces need `Target.createBrowserContext`, so they are available in direct CDP
mode only.

## Errors and results

Methods throw on failure; a thrown error ends the script, keeps everything
logged so far, and returns a non-zero exit status from the CLI. Results are
truncated to 24 000 characters; use `page.text(selector)` or
`page.snapshot({ root })` to narrow large reads.

## MCP tab ownership

Several agents can share one browser without fighting over tabs. Each MCP
process is one agent, identified by a label (the name shown on the tab banner).
Agent tabs open in the background, so the human keeps focus. Ownership is stored
in `$RAW_HOME/tab-owners-<browser>.json` and shared by every process.

| Tool | Parameters | What it does |
|---|---|---|
| `raw_claim` | `label`, `tabId`?, `url`?, `force`? | Open a tab (or take `tabId`) and claim it; `label` renames this agent and keeps its tabs |
| `raw_release` | `tabId`? | Give a tab back without closing it |
| `raw_close` | `tabId`?, `force`? | Close a tab and release it; another agent's tab needs `force: true` |

Target resolution:

1. an explicit `tabId` is always honoured — agents cooperate, and the result
   carries a `[note: tab ... belongs to "..."]` line when it is someone else's;
2. otherwise the agent's current tab, or its first owned tab;
3. otherwise `raw_goto` opens a new tab rather than touching the human's active
   tab, and other tools return "you have no claimed tab".

`raw_tabs` is read-only: it annotates each tab with `owner` and `owned` and
never changes the current target. `raw_call` is a trusted escape hatch and is
not ownership-checked, so agents should not use it to reach foreign tabs.

## MCP origin permissions

`$RAW_HOME/permissions.json` controls navigation:

```json
{ "defaultAccess": "allow", "origins": { "https://github.com": { "access": "allow" } } }
```

`allow` (default), `ask` and `deny`; an origin entry wins over the default.
With `ask`, navigation fails with the origin and the human approves through
`raw_approve { "origin": "...", "scope": "session" | "persistent" }`. Non-http
schemes (`file:`, `about:`, `data:`) are outside the origin model.

`raw_task verify` also attaches best-effort evidence when the agent has a
claimed tab: a screenshot under `$RAW_HOME/evidence/<task>.png` plus the page
URL and title. Verification is allowed to run up to `RAW_VERIFY_MAX_MS`
(default 30 minutes) instead of the generic 2-minute local tool cap.

## MCP multi-agent tools

The stdio server exposes two folded tools so a team of agents shares one
blackboard and one terminal topology without adding a dozen tool schemas.
Parameters are camelCase; snake_case aliases listed below are accepted, and an
unknown key is rejected instead of being dropped.

### `raw_task`

| `action` | Parameters | What it does |
|---|---|---|
| `create` | `title`, `creator`, `assignee`, `contextData`, `contractSpec` | Create a task and dispatch a `task_request` envelope to the assignee |
| `send` | `sender`, `recipient`, `msgType`, `payload` (or `text`), `taskId`? | Post a mailbox message; without `taskId` it starts a new thread |
| `poll` | `recipient`, `unreadOnly` (default `true`), `markRead` | Read the inbox as XML envelopes |
| `list` | `assignee`, `status`, `limit` (default 20, max 500) | List tasks, newest first |
| `get` | `taskId` | Fetch one task |
| `update` | `taskId`, `status`, `resultData` | Change status; the value must be one of `draft`, `dispatched`, `running`, `verifying`, `completed`, `failed`, `blocked` |
| `submit_artifact` | `taskId`, `author`, `artifactType`, `content` | Store content-addressed content; the same bytes may belong to several tasks |
| `verify` | `taskId`, `cwd` | Run the task's contract and record `completed` / `failed` |

Aliases: `task_id`, `artifact_type`, `msg_type`, `context_data`,
`contract_spec`, `result_data`, `unread_only`, `mark_read`.

`verify` executes every `checks[]` entry in a shell, compares the real exit
code to `expectedExitCode` (default 0), and returns `verified` only when all
checks pass. `protectedFiles` are compared against their committed `HEAD`
version: a protected file that is missing, untracked, or changed refutes the
contract even when the checks pass. A check that exceeds `timeoutMs` has its
whole process tree killed and is reported as a timeout.

### `raw_term`

| `action` | Parameters | What it does |
|---|---|---|
| `list` | `session`? | List panes; without a reachable tmux server it returns an empty `panes` array and a note |
| `peek` | `target`, `lines` (max 500) | Read a pane and record the Read-Before-Act guard |
| `wake` | `target`, `taskId` | Type `raw pickup <taskId>` after the guard check |
| `name` | `target`, `name` | Set the pane title |

`wake` refuses a pane that was not peeked at within the last 60 seconds, so a
signal never lands in the middle of a human typing. `taskId` must match
`^[a-zA-Z0-9_-]{1,64}$`.
