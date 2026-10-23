# Releasing

The release workflow (`.github/workflows/release.yml`) runs on a `v*` tag. It
builds the self-contained Windows host, publishes `raw-bridge-host-win-x64.zip`
and `SHA256SUMS.txt`, packs the npm tarball, and optionally publishes to npm.

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

   `npm run check` includes the browser smoke test. On Windows, also run:

   ```powershell
   node scripts/smoke-bridge.mjs
   ```

4. Commit, tag, and push:

   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

5. The workflow creates the GitHub release and uploads the host archive,
   checksums and npm tarball. To publish to npm automatically, add an
   `NPM_TOKEN` repository secret (`npm token create`); otherwise download the
   tarball from the release and run `npm publish`.

6. Upload `assets/social-card.png` as the repository social preview in GitHub
   settings if the card changed. GitHub has no API for that image.

## Bridge upgrades

The host installs to `~/.raw/edge-bridge/current/` so the native-messaging path
stays stable. After upgrading from a pre-`current` install, restart the browser
once, then run the installer with `-CleanLegacyHosts` to remove the old
`host-<timestamp>` directories.
