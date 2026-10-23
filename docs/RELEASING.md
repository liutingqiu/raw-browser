# Releasing

The release workflow (`.github/workflows/release.yml`) runs on a `v*` tag. It
builds self-contained hosts for Windows, macOS and Linux, publishes:

```text
raw-bridge-host-win-x64.zip
raw-bridge-host-linux-x64.tar.gz
raw-bridge-host-linux-arm64.tar.gz
raw-bridge-host-osx-x64.tar.gz
raw-bridge-host-osx-arm64.tar.gz
SHA256SUMS.txt
raw-browser.tgz
```

It packs the npm tarball and optionally publishes to npm.

## Checklist

1. Update the version in all four places:

   - `package.json`
   - `edge-bridge/extension/manifest.json`
   - `edge-bridge/host/Program.cs`
   - `mcp/raw-browser-mcp.mjs` (`serverInfo.version`)

   Then run:

   ```bash
   npm run check:versions
   ```

2. Add the release notes to `CHANGELOG.md` and move anything relevant out of
   `[Unreleased]`.

3. Verify locally:

   ```bash
   npm run check
   ```

   `npm run check` includes the browser smoke test. On any platform with the
   .NET 9 SDK, also build the host and run the native bridge smoke test:

   ```bash
   dotnet build edge-bridge/host/RawEdgeBridge.csproj -c Release --nologo
   node scripts/smoke-bridge.mjs
   ```

   On macOS/Linux, also exercise the installer against a disposable home:

   ```bash
   node scripts/install-edge-bridge.mjs --browser both \
     --host-path "$PWD/edge-bridge/host/bin/Release/net9.0/raw-edge-bridge" \
     --home "$(mktemp -d)/raw-home"
   ```

4. Commit, tag, and push:

   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

5. The workflow creates the GitHub release and uploads every host archive,
   checksums and the npm tarball. To publish to npm automatically, set the
   repository variable `NPM_AUTOPUBLISH` to `true` and add a valid `NPM_TOKEN`
   repository secret; otherwise publish manually with `npm publish`.

6. Upload `assets/social-card.png` as the repository social preview in GitHub
   settings if the card changed. GitHub has no API for that image.

## Bridge upgrades

The host installs to `~/.raw/edge-bridge/current/` on every platform so the
native-messaging path stays stable. After upgrading from a pre-`current`
install, restart the browser once, then run the installer with
`--clean-legacy-hosts` (`-CleanLegacyHosts` on Windows) to remove the old
`host-<timestamp>` directories.

The macOS and Linux single-file hosts are unsigned. Node's installer downloads
them with `fetch`, which does not add the macOS quarantine attribute; if a host
was downloaded through a browser instead, macOS may ask the user to allow it in
Privacy & Security.
