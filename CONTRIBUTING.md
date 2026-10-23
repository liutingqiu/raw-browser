# Contributing

Contributions are welcome. This checkout is browser-only: `raw` is the
Chrome/Edge browser automation runtime. The former model CLI has been removed
and must not be reintroduced.

## Development

Use Node 22.21 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/browser-cli.js --help
```

Run `npm run smoke:browser` when changing browser automation. It opens the
dedicated local browser profile and verifies same-origin iframe interaction,
downloads, screenshots and CPU-timeout termination.

Run `npm run smoke:bridge` on Windows (with the .NET 9 SDK) when changing the
native host or the extension. It builds the host and exercises the bridge
protocol.

Add focused `node:test` coverage for protocol serialization, context boundaries,
permissions, and filesystem behavior. Keep generated files out of commits;
`dist/` is built during packaging. The demo assets are generated, but the source
page and scripts are checked in:

```bash
npm run demo          # rebuild assets/demo.gif and assets/demo.mp4 (needs ffmpeg)
npm run social-card   # rebuild assets/social-card.png
```

## Pull requests

Explain the concrete behavior change and how you verified it. Keep unrelated
changes separate. For browser-surface changes, list which mode they affect
(direct CDP, extension bridge, or both) and whether `docs/API.md` needs an
update.

## Releases

See [docs/RELEASING.md](docs/RELEASING.md) for the version-bump and release
checklist. `npm run check:versions` must pass before tagging.
