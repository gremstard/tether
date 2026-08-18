'use strict';

const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('node:path');

/**
 * Menu-bar / system-tray presence.
 *
 * Tether's notion of "online" is "this process is running" — so the window
 * closing must not end the process, and the tray is what makes that state
 * visible and escapable. Without it, a hidden-on-close app is just a process
 * the user cannot see or quit.
 */

const ASSETS = path.join(__dirname, '..', 'assets');

function trayImage() {
  // macOS recolours template images for light/dark menu bars automatically;
  // Windows and Linux need a normal coloured icon.
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'tray-win.png'));
}

function createTray({ onShow, onQuit, getLaunchAtLogin, setLaunchAtLogin }) {
  const tray = new Tray(trayImage());

  const render = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Tether', click: onShow },
        { type: 'separator' },
        {
          label: 'Start at login',
          type: 'checkbox',
          checked: getLaunchAtLogin(),
          click: (item) => {
            setLaunchAtLogin(item.checked);
            render();
          },
        },
        { type: 'separator' },
        { label: 'Quit Tether', click: onQuit },
      ])
    );
  };

  render();
  tray.setToolTip('Tether');

  // On Windows the tray icon's own click is the expected way to reopen; on
  // macOS a left click opens the menu, which is the platform convention.
  if (process.platform !== 'darwin') tray.on('click', onShow);

  return { tray, refresh: render };
}

/** Login-item control, using each platform's own mechanism via Electron. */
function getLaunchAtLogin() {
  return app.getLoginItemSettings().openAtLogin;
}

function setLaunchAtLogin(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Launched at login it should come up quiet and resident, not throw a
    // window in the user's face during startup.
    openAsHidden: true,
    args: ['--hidden'],
  });
}

/** Did this launch come from the login item (or a --hidden relaunch)? */
function startedHidden() {
  if (process.argv.includes('--hidden')) return true;
  const settings = app.getLoginItemSettings();
  return Boolean(settings.wasOpenedAtLogin || settings.wasOpenedAsHidden);
}

module.exports = { createTray, getLaunchAtLogin, setLaunchAtLogin, startedHidden };
