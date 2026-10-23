# Security policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
<https://github.com/liutingqiu/raw-browser/security/advisories/new>.

Include the affected version, operating system, reproduction steps, impact, and any suggested fix.
Do not include secrets or account data. Please avoid filing a public issue until a fix is available.

## Trust model

`raw` intentionally executes model-generated browser scripts with the current user's operating-system
permissions. The worker used for timeouts isolates CPU-bound scripts; it is not a security sandbox.
The extension bridge runs with the browser's full extension authority (`<all_urls>`, `debugger`,
cookies, proxy, downloads, history, management), and plain CDP mode controls a dedicated browser
profile. The calling agent's prompt and permission mode are the authority for which actions run.

The bridge is defended at the transport boundary: listeners bind only to `127.0.0.1`, every HTTP and
WebSocket request requires a per-browser random token, native messaging is restricted to the pinned
extension id, and a host only attaches to a debug port it owns. Release host binaries are published
with `SHA256SUMS.txt`; `scripts/install-edge-bridge.ps1` verifies the checksum when it downloads one.
Cookies, tokens and page contents are secrets; do not log or forward them to external services.

Configuration, downloads, bridge tokens and the dedicated browser profile are stored locally under
`~/.raw/`. Remote page content is untrusted input to the model and can influence subsequent tool
calls; use the calling agent's permission mode when reviewing content that should not trigger state
changes automatically.
