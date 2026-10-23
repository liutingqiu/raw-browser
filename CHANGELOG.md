# Changelog

All notable changes to `raw` are documented here. The format follows Keep a Changelog and versions
follow Semantic Versioning.

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

[Unreleased]: https://github.com/liutingqiu/raw-browser/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.6.1
[0.6.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.6.0
[0.5.1]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.5.1
[0.5.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.5.0
[0.4.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.4.0
