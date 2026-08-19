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

## Signing: ad-hoc, not notarized

Builds are **ad-hoc signed** (`scripts/adhoc-sign.js`, run as an electron-builder
`afterPack` hook) and **not notarized**. The distinction matters more than it
sounds:

- **No signature at all** — what shipping with `identity: null` alone produced —
  leaves the bundle carrying Electron's own linker signature, which stops
  matching once electron-builder renames the app and adds resources. macOS reads
  a broken signature as **"'Tether' is damaged and can't be opened"**, which
  sounds like corruption and pushes people to bin the app. On Apple Silicon an
  unsigned binary will not launch at all.
- **Ad-hoc signed** costs nothing, needs no account, and makes the signature
  valid: `codesign --verify --deep --strict` passes. The app is no longer
  "damaged".
- **Notarized** would remove the warning entirely, and needs a paid Apple
  Developer account. Tether does not have one.

So users still see an "unidentified developer" prompt on first launch. What they
do about it depends on the macOS version:

**macOS 15 (Sequoia) and later** — Apple removed the Control-click → *Open*
shortcut. Open the app, let it be blocked, then go to **System Settings →
Privacy & Security**, scroll to the message about Tether, and click **Open
Anyway**.

**macOS 14 and earlier** — Control-click the app and choose *Open*.

**Either version**, the reliable one-liner:

```bash
xattr -dr com.apple.quarantine /Applications/Tether.app
```

Windows SmartScreen warns about an unrecognised publisher for the same reason —
no code-signing certificate. Choose *More info* → *Run anyway*.

The signing hook verifies its own work and fails the build if the signature does
not validate, so a bundle that cannot launch is not something a release can
silently ship again.

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
