# Raw Browser Bridge

Raw Browser Bridge lets Raw drive ordinary tabs in the user's real Microsoft
Edge or Google Chrome Default profile. Authentication remains inside the
browser: the bridge does not copy, decrypt or log cookies on its own, and cookie
values are returned only when a script explicitly calls a cookie API.

## Components

- `extension/`: an unpacked Manifest V3 extension that works in both Edge and
  Chrome. It uses `chrome.debugger` for page-level CDP and connects to the local
  native host.
- `host/`: a .NET native-messaging host. It exposes a token-protected CDP facade
  on loopback for the existing Raw browser runtime: Edge on `127.0.0.1:9333`,
  Chrome on `127.0.0.1:9334`.
- `scripts/install-edge-bridge.mjs`: the cross-platform installer for macOS,
  Linux and Windows (on Windows it delegates to the PowerShell script).
- `scripts/install-edge-bridge.ps1`: the Windows installer. It builds or
  downloads a versioned host, copies it to `raw-edge-bridge.exe` and
  `raw-chrome-bridge.exe`, generates independent local tokens, and registers
  both native hosts under HKCU.

The extension exposes tabs across browser windows. Page-scoped CDP commands are
forwarded without a method allowlist, including Network and Storage commands.
Browser- and Target-domain commands are routed through extension APIs when a
tab-scoped `chrome.debugger` session cannot perform them directly. The user's
prompt and permission mode govern which actions an agent may take.

The toolbar popup reports whether the native host is connected, its extension
version and the browser user agent, and offers a **Disconnect** switch. While
paused, the extension keeps no native port and cannot be driven remotely;
**Reconnect** resumes it.

## Install

The cross-platform installer is the normal entry point:

```bash
# from a source checkout, macOS / Linux / Windows
node scripts/install-edge-bridge.mjs --browser both

# global npm install, macOS / Linux
node "$(npm root -g)/raw-browser/scripts/install-edge-bridge.mjs" --browser both
```

On Windows it delegates to the PowerShell installer, which registers the HKCU
native-messaging keys. The PowerShell script also remains directly usable:

```powershell
# both browsers (default)
& .\scripts\install-edge-bridge.ps1 -Browser both

# or one of them
& .\scripts\install-edge-bridge.ps1 -Browser edge
& .\scripts\install-edge-bridge.ps1 -Browser chrome
```

The installer builds a self-contained host when the .NET 9 SDK is on `PATH`.
Without the SDK it downloads the matching release asset
(`raw-bridge-host-<rid>.tar.gz` on macOS/Linux, `raw-bridge-host-win-x64.zip` on
Windows) and verifies `SHA256SUMS.txt` when present. To use a host you built
yourself, pass `--host-path` (`-HostPath` in PowerShell); to force a local
build, pass `--build-from-source` (`-BuildFromSource`). `--prefer-prebuilt`
(`-PreferPrebuilt`) downloads the release asset even when an SDK is installed.

On macOS and Linux the installer writes the native-messaging manifests to the
browser's user directory:

```text
macOS Chrome: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
macOS Edge:   ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts
Linux Chrome: ~/.config/google-chrome/NativeMessagingHosts
Linux Edge:   ~/.config/microsoft-edge/NativeMessagingHosts
```

The host lives at `~/.raw/edge-bridge/current/` on every platform. Upgrades
replace the executable in place, because a running Edge or Chrome caches the
resolved native-messaging path for the life of the browser process. If you
upgraded from an installer that used `host-<timestamp>` directories, the
browser may keep using one of those until it restarts; restart it, then run the
installer once with `--clean-legacy-hosts` (`-CleanLegacyHosts`) to remove the
old directories.

The browser and the host must run in the same operating system. A Windows
browser cannot use a host installed inside WSL; install a Linux Chrome/Edge in
WSL with WSLg and run the macOS/Linux installer there instead. Snap- and
Flatpak-confined browsers do not read the user-level native-messaging directory;
use a deb/rpm or app-bundle install for the bridge.

Load the unpacked extension once in each browser you want to drive: open
`edge://extensions` and/or `chrome://extensions`, enable Developer mode, choose
**Load unpacked**, and select `edge-bridge/extension` (`edge-bridge\extension`
on Windows). The extension ID must be
`gfpadofoapicldopjkghnfbnbkljihmk`; the installer verifies the manifest key
before registering anything.

Load unpacked is the only install that survives a browser restart. Both
`--load-extension=...` and the CDP `Extensions.loadUnpacked` call load the
extension for the current browser session only: the profile keeps no record of
it, so the next ordinary launch has no bridge and the port stays closed.
Loading it once through the extensions page takes effect immediately, without a
restart, and every later launch picks it up.

Set `mode` in `~/.raw/browser-profiles/current.json`:

```json
{ "mode": "edge-extension" }
```

or

```json
{ "mode": "chrome-extension" }
```

The installed `raw-bridge.mjs` wrapper then reads
`~/.raw/edge-bridge.json` or `~/.raw/chrome-bridge.json`, authenticates to the
matching local facade, and uses the real browser profile.

## Troubleshooting

A `fetch failed` from the bridge, or nothing listening on the expected port,
means the extension is not running in that browser session. Check the
extensions page for **Raw Browser Bridge**; if it is missing, load
`edge-bridge\extension` again. The same symptom appears if the browser is
running a different profile from the one the extension was loaded into.

The host process is started by the extension, not by the installer, and it
exits when the extension detaches. Only one host serves each port: a host that
is launched through native messaging retires older instances of the same
browser build, and the extension therefore keeps a single native port. If the
port flaps between samples, look for repeated `connect()` calls in
`service-worker.js`; every extra port starts another host that kills the
previous one.

Ephemeral Raw Spaces remain unavailable because extensions cannot create an
incognito browser context equivalent to CDP `Target.createBrowserContext`.
Closing a Raw session only detaches the debugger; it does not close the browser.

The bridge supports `/json/version`, `/json/protocol`, `/json/list`,
`/json/new`, `/json/activate/{tabId}`, `/json/close/{tabId}`, and
`/json/restore` plus page and browser WebSocket endpoints. The browser endpoint
accepts general CDP methods, flattened Target sessions, and target lifecycle
events. The browser still decides whether a particular protocol command is
valid for privileged `edge://` / `chrome://` pages, file URLs without extension
file access, and other protected targets.

Host logs are written to `~/.raw/edge-bridge.log` or
`~/.raw/chrome-bridge.log`; set `RAW_BRIDGE_LOG=0` to disable them.

## Rollback

Remove `mode` from `current.json` to return to the selected dedicated profile.
Disable or remove **Raw Browser Bridge** from the browser's extensions page and
remove the per-user registration:

```text
Windows (HKCU)
  HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.raw.edge_bridge
  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.raw.edge_bridge

macOS
  ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.raw.edge_bridge.json
  ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.raw.edge_bridge.json

Linux
  ~/.config/google-chrome/NativeMessagingHosts/com.raw.edge_bridge.json
  ~/.config/microsoft-edge/NativeMessagingHosts/com.raw.edge_bridge.json
```

The previous host pair remains at `~/.raw/edge-bridge/previous/` after an
upgrade; move it back to `current/` if a new host misbehaves.
