# Changelog

All notable changes to `raw` are documented here. The format follows Keep a Changelog and versions
follow Semantic Versioning.

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

[Unreleased]: https://github.com/liutingqiu/raw-browser/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.5.0
[0.4.0]: https://github.com/liutingqiu/raw-browser/releases/tag/v0.4.0
