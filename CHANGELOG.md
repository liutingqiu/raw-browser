# Changelog

All notable changes to `raw` are documented here. The format follows Keep a Changelog and versions
follow Semantic Versioning.

## [Unreleased]

### Fixed

- **One bridge host per signed-in profile.** A newly started host used to kill
  every other host with the same name, so several Chrome or Edge profiles took
  turns owning the single bridge port and the extension hello flooded the log.
  Each profile now keeps its own host. Chrome ports start at 9334 and Edge
  ports at 9333, with sixteen ports available. A reconnect retires only the
  previous host of that same profile.

### Added

- The extension hello carries a stable per-profile id. The host writes
  `~/.raw/chrome-sessions.json` or `~/.raw/edge-sessions.json` with the profile
  id, port, and account address. On Chrome the address comes from the profile
  picker when the hello does not include one.
- `"account"` in `~/.raw/browser-profiles/current.json` (or
  `RAW_BROWSER_ACCOUNT`) selects which live profile `raw` drives. The value is
  the email or the profile id. `raw status` lists every connected profile.
  With more than one profile and no account selected, `raw run` stops and
  prints the list instead of attaching to an arbitrary one.

## [0.9.0] - 2026-11-14

The browser-native release: per-agent tabs that never steal the human's focus,
per-origin approvals, and a browser tool surface that grew from 16 to 27 tools.

`raw-browser` is a browser automation project. The multi-agent substrate that had
grown inside it — a task blackboard, a mailbox, a tmux topology and a contract
verifier — was removed before this release; orchestration now belongs to the
agent runtime that calls this server.

### Added

- **Origin permissions**: `~/.raw/permissions.json` with `allow` / `ask` / `deny`
  per origin, plus `raw_approve` for session or persistent approval.
- **Automatic tab groups**: every claimed tab joins a Chrome tab group named by
  the model per task (`raw_claim { group }`), even a single tab, so agent tabs
  stay visibly separate from the human's. `raw_group` regroups, ungroups or
  closes a finished task's tabs.
- **Tab ownership** (`raw_claim`, `raw_release`, `raw_close`, `raw_clone`): each
  agent claims its own tabs, tagged with a model-chosen label that is painted on
  the tab banner. `raw_tabs` reports the owner per tab and never re-points the
  agent at the human's active tab; `raw_goto` opens a new tab when the agent has
  none. Agent tabs open in the background, so the human keeps focus. Another
  agent's tab is read-only: reads work and report the owner, while `raw_clone`
  copies its URL and scroll position into a tab the agent owns.
- **Browser tools**: `raw_press`, `raw_select`, `raw_scroll`, `raw_wait`,
  `raw_group` (one Chrome tab group per agent; the extension now requests the
  `tabGroups` permission, reload it once) and `raw_run` (a JavaScript snippet
  bound to the agent's tab), for 27 MCP tools in total.

### Changed

- The installer selects `browser-profiles/current.json` when one browser is
  installed, and the PowerShell installer falls back to the latest release.
- `raw-bridge --help` and argument errors no longer require a bridge config.
- Extension bridge draws agent pointer animations and synchronizes driving runtime identity
  via MAIN-world DOM reflection.
- The extension bridge replaces the border glow with a dense dot field lit by slow
  waves: the source is a circle whose radius is half a period and whose centre sits
  below the viewport, so wavefronts climb out of the bottom edge. Dots have a fixed
  size, exist only while a crest lights them, and the `raw controlling` badge (owner
  label) plus the agent pointer are unchanged.
- The agent pointer eases to each target (150–700 ms depending on distance)
  instead of a CSS hop, uses a custom 32 px arrow, and drifts inside a small disc
  while idle. Detach, tab close and navigation still remove it.
- Bridge navigation normalizes a bare host name (`raw_goto example.com`) instead of
  sending it to `Page.navigate` as an invalid URL.
- An unreachable bridge now names the browser, the port and the install command
  instead of surfacing `fetch failed`.
- The bridge installer falls back to the `latest` release assets when the current
  version has not been published yet.
- `check-versions` also covers `package-lock.json`.
- New installs use `~/.raw/browser-profile` and `~/.raw/downloads`; an existing
  `codex-*` directory keeps being used so logins survive the upgrade.

### Removed

- `raw.mesh` (SQLite task blackboard, mailbox and artifacts), `raw.term` (tmux
  pane topology and wake signals), `raw.verify` (acceptance-contract runner) and
  the folded MCP tools `raw_task` / `raw_term`. The `raw` CLI, the extension
  bridge and the MCP server are unaffected.

### Fixed

- Screenshots larger than 8 MB are returned as a path instead of an inline image.
- The CLI sets a non-zero exit status from an explicit failure flag rather than by
  matching an `Error:` prefix in the script output.

## [0.7.0] - 2026-10-23

### Added

- The extension bridge now installs on macOS and Linux. A cross-platform
  `scripts/install-edge-bridge.mjs` handles the native-messaging host,
  `~/.raw/edge-bridge.json` / `~/.raw/chrome-bridge.json`, and the browser
  manifests under `~/Library/Application Support` (macOS) or `~/.config`
  (Linux). On Windows it delegates to the existing PowerShell installer, so
  one command works everywhere.
- Release builds now publish self-contained hosts for `linux-x64`,
  `linux-arm64`, `osx-x64` and `osx-arm64` alongside `win-x64`, plus a single
  `SHA256SUMS.txt` covering every archive.
- CI runs the native-host smoke test on Ubuntu, macOS and Windows, plus a real
  installer pass on Ubuntu and macOS.

### Changed

- Browser discovery also finds Chrome Beta/Canary, Chromium and Edge
  Beta/Dev/Canary, plus Linux packages under `/opt` and snap Chromium, so
  macOS/Linux users are less likely to need `RAW_BROWSER_PATH`.
- README, README.zh-CN and `edge-bridge/README.md` document the cross-platform
  install, the per-OS native-messaging directories, and the WSL/snap caveats.

### Fixed

- The native host treats process enumeration as best-effort, so a restricted
  `Process.GetProcessesByName` call on macOS or Linux cannot prevent startup.

## [0.6.2] - 2026-10-23

### Added

- `raw-mcp` bin: a global install now exposes the stdio MCP server as
  `raw-mcp`, so MCP clients can start it without a path to
  `mcp/raw-browser-mcp.mjs`. The path-based configuration still works.
- README and README.zh-CN document both launch forms and the HOL Guard
  catalog entry for the MCP server.

## [0.6.1] - 2026-10-23

### Changed

- Rebuilt the demo, social card and architecture diagram around a browser and
  selection visual identity: paper, ink, browser chrome and a single signal
  orange. No gradients.
- `demo/dashboard.html` is now a browser workbench with a live `run.mjs` panel;
  the recorded demo highlights each script line as it executes.

### Fixed

- `scripts/smoke-browser.mjs` allows a cold browser 60 seconds to launch and no
  longer masks the real failure when a failed-launch profile cannot be removed.

## [0.6.0] - 2026-10-23

### Added

- `page.on(event, listener)` subscribes to a tab's CDP events from a script and
  returns an unsubscribe function.
- Zero-SDK bridge install: when the .NET 9 SDK is missing,
  `scripts/install-edge-bridge.ps1` downloads the matching prebuilt
  `raw-bridge-host-win-x64.zip` from GitHub Releases and verifies
  `SHA256SUMS.txt` when present. `-HostPath` and `-BuildFromSource` cover local
  hosts and forced builds, and `-CleanLegacyHosts` removes old timestamped
  installs after a browser restart.
- The bridge host now installs to the stable path
  `~/.raw/edge-bridge/current/` and upgrades replace its files in place. Edge
  and Chrome cache the resolved native-messaging path for the life of the
  browser process, so the previous `host-<timestamp>` layout could leave
  reconnects pointing at a deleted binary after an upgrade.
- `.github/workflows/release.yml` builds a self-contained single-file host,
  publishes checksums and uploads the npm tarball on tag pushes.
- `docs/API.md`: the full scripting reference (locators, input, waits,
  downloads, browser surfaces, spaces, escape hatches).
- Runnable demo: `demo/dashboard.html`, `demo/example.mjs`, `scripts/demo.mjs`,
  generated `assets/demo.gif` / `assets/demo.mp4`, and `assets/social-card.png`.

### Changed

- The package is published on npm as `raw-browser`; the README quick start now
  leads with `npm install -g raw-browser` and documents the bridge installer in
  a global install (`$(npm root -g)\raw-browser\scripts\...`).
- README and README.zh-CN lead with a quick start and a demo, document the
  prebuilt-host install path, and link the API reference.
- npm metadata now includes MCP/browser keywords, funding, `publishConfig`, and
  ships `docs/`, `demo/` and `assets/`.

### Fixed

- README.zh-CN duplicated two known-limitation entries.
- CONTRIBUTING still referred to provider model lists from the removed chat CLI.
- The source-build install path now publishes a self-contained single-file host
  instead of a framework-dependent build, so the bridge keeps working without
  the .NET runtime installed.

## [0.5.1] - 2026-10-22

### Added

- The extension toolbar popup reports bridge status and offers a Disconnect /
  Reconnect switch, backed by `chrome.storage` so the pause survives a service
  worker restart.

### Fixed

- `page.waitForDownload(action, opts)` arms the browser-level listener before
  the action runs, eliminating the race where a fast download completed before
  `Browser.downloadWillBegin` was wired up. Progress events now also synthesize
  a record when the begin event was missed.

## [0.5.0] - 2026-10-22

### Added

- **Chrome support for the extension bridge.** The installer now publishes
  `raw-edge-bridge.exe` and `raw-chrome-bridge.exe`, registers both native
  messaging hosts (`HKCU\Software\Microsoft\Edge\...` and
  `HKCU\Software\Google\Chrome\...`), and writes independent
  `edge-bridge.json` / `chrome-bridge.json` tokens. Edge listens on 9333,
  Chrome on 9334.
- `mode: "chrome-extension"` in `~/.raw/browser-profiles/current.json`, plus
  `RAW_BROWSER_BRIDGE_BROWSER=chrome` for scripts.
- `mcp/raw-browser-mcp.mjs`: a persistent MCP server with current-tab tracking,
  `raw_use` browser switching, image results for screenshots, cancellation and
  output caps.
- The extension toolbar popup reports bridge status and offers a Disconnect /
  Reconnect switch, backed by `chrome.storage` so the pause survives a service
  worker restart.
- `page.axSnapshot()` exposes the accessibility tree alongside the existing
  interactive-element snapshot.
- Shadow-DOM traversal in locators, snapshots and click/fill.
- `page.waitForNavigation(action)`, element/clip screenshots, binary
  `page.fetch()`, direct-mode `page.frames()`, and `selectOption` by
  value/label/index.
- `raw-bridge.mjs` gained `html`, `visit`, single-socket commands, load-event
  waiting and page-helper locators/rich-text writes.
- `page.waitForMutation()` and `dragAndDrop()` with interpolated pointer paths.

### Fixed

- `click()` now sends the CDP `buttons` bitmask, so canvas and drag-aware
  widgets see a real pressed button.
- `setValue()` honors `notifyChange: false` and `append` in Monaco, CodeMirror
  5/6, contenteditable and native inputs; file inputs report that
  `setInputFiles()` is required.
- `goto()` preserves `file:`, `data:`, `about:`, `edge:` and `chrome:` URLs
  instead of prefixing them with `https://`, and waits on same-document
  navigation instead of stalling for 30 seconds.
- `waitForFunction()` awaits async predicates; `waitForURL()` tolerates an
  invalid regex; `press()` understands `cmd`/`command`, punctuation and
  lowercase key names.
- `downloads()` returns the id `cancelDownload()` expects, and direct mode
  cancels through `Browser.cancelDownload`.
- The MCP client no longer targets the active tab implicitly: it remembers the
  current tab, and `goto`/`new`/`visit` wait for load and surface navigation
  errors.
- The extension sends one event frame instead of two, and the host fans it out
  to page and browser sockets with a bounded per-socket queue, so a slow client
  cannot stall the native read loop.
- The extension reconnects with exponential backoff instead of once per second;
  `bridgeWarning` messages reach the host log and browser sockets.
- The bridge host activates lazy `Network.enable`, accepts `RAW_HOME`, writes
  optional logs, validates the `Host` header, compares tokens in constant time,
  honors per-command timeouts and reports the extension's protocol/user agent.
- `Target.closeTarget` requires an explicit target; `Browser.close` is disabled
  in extension mode and replaced by `Raw.closeBrowser { confirm: true }`;
  disabling the bridge extension itself is refused.
- Bridge configs are read without BOM sensitivity; the installer writes
  BOM-free JSON, verifies the extension id from the manifest key, and keeps the
  newest three host builds.
- The CLI uses direct-mode port 9222 instead of always claiming 9333, fails fast
  for `--space` in bridge mode, and warns when `--headless` is ignored.
- `browser.ts` isolates throwing event listeners, awaits async
  `waitForFunction` predicates, preserves `unserializableValue`, and serializes
  concurrent scripts in the worker.

### Changed

- Renamed the project from `raw-agent` to `raw-browser` to match its scope:
  one runtime, two browsers. Package, repository, docs and README links now use
  the new name.
- The npm package now includes `scripts/`, `mcp/` and the extension source so
  the bridge and MCP server can be installed from the package.

## [0.4.0] - 2026-09-12

### Added

- OpenAI Responses and Anthropic Messages adapters with native reasoning-state replay.
- Image input from file paths and the clipboard across all three provider protocols.
- Standing goals, context inspection, manual compaction, permission modes, and durable notes.
- Chrome/Edge automation with same-origin iframe locators, isolated spaces, downloads, and screenshots.
- A worker-isolated browser script runtime whose timeout can terminate CPU-bound scripts.

### Fixed

- Concurrent builds now publish a complete `dist` directory instead of racing over partial files.
- File writes and edits replace their targets atomically, and large overwritten files are not loaded solely for diffs.
- Web fetches now enforce output and response-size limits and honor `maxChars`.
- Context pruning keeps tool exchanges intact and retries image-rejecting models without stale payloads.
- Oversized current tool turns are shortened without breaking their protocol structure.
- Workspace file boundaries reject symlink escapes.
- Config and session writes are atomic, and corrupt config/session files are reported.
- CLI and setup arguments fail clearly instead of silently accepting invalid values.
- Interactive API keys no longer echo; malformed tool arguments and empty/HTML API responses fail clearly.
- Tool arguments are checked against their schemas before permission prompts or execution.
- Provider overrides no longer inherit credentials or endpoints from a different provider.
- Chat Completions image follow-ups retain standard string tool messages for broad API compatibility.
- Session resume is workspace-scoped and restores its provider, model, and reasoning effort.
- Session loading, model responses, file reads, and grep fallbacks enforce memory limits.
- One-shot failures and exhausted tool loops now return a non-zero exit status.
- Truncated Chat Completions, Anthropic, and Responses API results are reported as incomplete instead of being saved as successful answers.
- Legacy Unicode note filenames migrate without overwriting a colliding note.
- TUI dynamic imports resolve correctly in the published directory layout.

### Security

- Browser attachment refuses an unknown process on the default debug port.
- Browser ownership markers are bound to the current debugger instance rather than only its port.
- Clipboard images have a configurable size limit and temporary files are removed after reading.
- Proxy URLs reject unsupported protocols and mask embedded credentials in terminal output.
- Timed-out shell commands terminate their process tree.

### Engineering

- Strict TypeScript checking, a locked development toolchain, and full CLI protocol, setup, and permission smoke tests now gate publication.
- Browser smoke testing uses a disposable profile and covers forms, iframes, downloads, screenshots, isolated spaces, cleanup, and CPU timeouts.

[Unreleased]: https://github.com/liutingqiu/raw-browser/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.9.0
[0.7.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.7.0
[0.6.2]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.6.2
[0.6.1]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.6.1
[0.6.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.6.0
[0.5.1]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.5.1
[0.5.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.5.0
[0.4.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.4.0
