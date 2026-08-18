# Packaging and releases

Installers are built by [`electron-builder`](https://www.electron.build/) and
published to [GitHub Releases](https://github.com/gremstard/tether/releases),
which is where the download buttons on
[chat-tether.web.app](https://chat-tether.web.app) point.

## Building locally

```bash
npm run dist:mac
```

Produces a `.dmg` per architecture in `release/`. Apple Silicon and Intel are
built separately rather than as one universal binary — two smaller downloads
beat one that is twice the size for everybody.

```bash
npm run dist:win
```

Produces an NSIS installer — **but only on Windows.** Building a Windows
installer from macOS needs Wine, which is more fragility than it is worth when
GitHub's runners are free. In practice you never run this locally; the release
workflow does it on a Windows runner.

```bash
npm run pack
```

Unpacked directory only, no installer. Useful for checking what actually ended
up inside the app.

## Cutting a release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds macOS
on a macOS runner and Windows on a Windows runner, then attaches both to a
GitHub Release. Each platform builds on its own OS because neither can be
cross-built reliably.

## The builds are unsigned

Signing macOS needs a paid Apple Developer account; signing Windows needs a
code-signing certificate. Tether has neither, so:

- **macOS** refuses to open the app on first launch ("damaged, move to bin" —
  which is Gatekeeper being unhelpful rather than anything being wrong). Users
  right-click the app and choose *Open*, or run:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Tether.app
  ```

- **Windows** SmartScreen warns on an unrecognised publisher. Users choose
  *More info* → *Run anyway*.

This is stated on the release notes and worth repeating anywhere the app is
linked. It is the single roughest edge in the download experience, and the only
fix is paying for certificates.

## What ships inside the package

Only what runs: `main/`, the built renderer, `shared/`, `assets/`, and the
default Firebase config. Tests, scripts, docs, and the rules templates are
excluded — `templates/server.rules` is something a founder reads from the repo,
not something the app needs at runtime.

The renderer bundle is built before packaging (`prepackage`), so `renderer/app.js`
and its imports never ship; only `renderer/dist/bundle.js` does.

## Configuration in a packaged build

`config/firebase.config.default.json` is committed and travels inside the
package, so a downloaded build reaches the directory project with no setup. A
local `config/firebase.config.json` overrides it and stays out of git, for
pointing a dev build somewhere else.

A Firebase client config is public by design — security lives in the Firestore
rules, not in hiding the project id.
