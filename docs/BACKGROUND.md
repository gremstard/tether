# Running in the background

Tether's notion of "online" is simply **this process is running**. That matches
the goal from the build doc (§3.4): a message should arrive whenever your
computer is on, without push infrastructure, certificates, or an always-on
server holding a socket open for you.

## Closing the window does not quit

Closing hides the window; the process keeps running with a tray / menu-bar icon.
Quitting happens only through **Quit Tether** in the tray menu.

That is what keeps messages arriving. The Firestore listener, the local-history
writes, and the sweep all live in the renderer, and a hidden window's renderer
keeps executing — verified by driving the real app: after `window.close()` the
window is hidden but not destroyed, and the renderer still evaluates code.

## Why the listener stayed in the renderer

The build doc describes a background process holding the listener, and the
obvious reading is a separate main-process Firestore client. That was rejected:
it would mean a second Firebase app instance, a second auth session to keep
signed in, and two writers racing over local history and acks.

A hidden renderer *is* the resident process, and it already holds authenticated
state, the listener, and the sweep. Keeping one owner for all of it is simpler
and removes a whole class of races. The trade is that the background work is
tied to a window that exists but is never shown.

## Start at login

Toggle it in **Settings → Start Tether at login**, or from the tray menu. It
uses each platform's own mechanism through Electron
(`app.setLoginItemSettings`) — macOS Login Items, Windows startup registry — so
there is nothing custom to uninstall.

Launched that way, Tether starts hidden (`--hidden`, plus `openAsHidden` on
macOS) and goes straight to the tray rather than throwing a window up during
login. On macOS the dock icon is hidden while the window is, so a resident
Tether does not sit in the dock doing nothing.

Tether never enables this by itself. It is off until you turn it on.

## One instance only

The app takes a single-instance lock. A second launch — including the login item
firing while Tether is already open — raises the existing window instead of
starting a rival process with its own listener, which would double every
notification and have two writers acking the same messages.

## Notifications

New messages fire a native OS notification from the main process
(`UNUserNotificationCenter` on macOS, toast on Windows) with the sender's
username as the title. Clicking one raises the window **and opens that
conversation**, rather than just focusing whatever was last on screen.

Notifications are suppressed for the first snapshot after a thread opens — that
batch is backlog, not news, and would otherwise fire one toast per undelivered
message every time you sign in.
