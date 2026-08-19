'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * electron-builder afterPack hook: ad-hoc sign the macOS bundle.
 *
 * Without this the app ships with the signature Electron's own binary was
 * linker-signed with, which no longer matches the bundle after electron-builder
 * renames it and adds resources. macOS reads a *broken* signature as
 * "'Tether' is damaged and can't be opened" — a harsher and more alarming
 * failure than having no signature at all, and on Apple Silicon an unsigned
 * binary will not launch regardless.
 *
 * Ad-hoc signing (`--sign -`) costs nothing and no account. It does not make
 * the app notarized: Gatekeeper still warns about an unidentified developer,
 * and users still right-click → Open the first time. It only stops macOS from
 * declaring the app corrupt.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // --deep is deprecated for real signing identities, but remains the practical
  // way to ad-hoc sign an Electron bundle's nested helpers and frameworks.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Fail the build rather than shipping another bundle that cannot launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });

  console.log(`  • ad-hoc signed  ${appName} (${context.arch === 1 ? 'x64' : 'arm64'})`);
};
