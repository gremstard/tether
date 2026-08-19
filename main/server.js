'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Serves the renderer over http://localhost instead of loading it from file://.
 *
 * Firebase's sign-in popup hands the credential back to its opener by
 * postMessage, and checks the opener's origin against the project's authorized
 * domains. A `file://` page has no real origin to authorize, so Google sign-in
 * fails there with a bare `auth/internal-error`. `localhost` is an authorized
 * domain in every Firebase project by default, so serving the same files over
 * HTTP makes the popup flow work with no console configuration.
 *
 * The port is fixed, and that matters more than it looks. Firebase persists a
 * signed-in session in storage keyed by origin, and an origin includes its port
 * — so binding to a random port every launch silently signed the user out each
 * time, and took their conversation and server lists with it, since those only
 * load once signed in.
 *
 * The server binds to the loopback interface only, so it is reachable just from
 * this machine, and serves a fixed whitelist of directories — never the whole
 * app root, which would expose main/ and config/ to any other local process.
 */

/**
 * Fixed so the origin — and therefore the stored session — survives a restart.
 * Arbitrary, in the IANA dynamic range, chosen to be unlikely to collide.
 */
const PREFERRED_PORT = 47821;

const SERVABLE = ['renderer', 'assets'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function resolveWithinRoot(root, urlPath) {
  // Strip the query, decode, and normalize before deciding anything: the check
  // has to run on the resolved path, not on the text the client sent.
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);

  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const [top] = relative.split(path.sep);
  if (!SERVABLE.includes(top)) return null;

  return resolved;
}

/**
 * Start the renderer's origin.
 *
 * Binds both loopback families on the same port. `localhost` resolves to ::1
 * before 127.0.0.1 on a typical macOS box, and Chromium does not fall back the
 * way node's fetch does — an IPv4-only listener is simply unreachable, which
 * shows up as a bare ERR_FAILED. Binding both keeps the origin spelled
 * "localhost", which is what Firebase authorizes and what the stored session is
 * keyed to.
 *
 * Only loopback addresses are bound, never a wildcard, so nothing is reachable
 * from the network.
 *
 * Falls back to an ephemeral port if the preferred one is occupied: better a
 * lost session than an app that will not open. The caller is told, so it can say
 * so rather than leaving the user wondering why they were signed out.
 */
function startRendererServer(root, { port = PREFERRED_PORT } = {}) {
  const handler = (req, res) => {
    const file = resolveWithinRoot(root, req.url === '/' ? '/renderer/index.html' : req.url);

    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(String(err.code ?? 'error'));
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  };

  const listen = (server, host, wanted) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(wanted, host, () => {
        server.removeAllListeners('error');
        resolve(server.address().port);
      });
    });

  return (async () => {
    const v4 = http.createServer(handler);

    let actual;
    let stable = true;
    try {
      actual = await listen(v4, '127.0.0.1', port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      actual = await listen(v4, '127.0.0.1', 0);
      stable = false;
    }

    // Best effort: some systems have no IPv6 loopback, and IPv4 alone is fine
    // there because localhost will resolve to 127.0.0.1.
    let v6 = http.createServer(handler);
    try {
      await listen(v6, '::1', actual);
    } catch {
      v6.close();
      v6 = null;
    }

    return {
      url: `http://localhost:${actual}/renderer/index.html`,
      port: actual,
      stable,
      families: v6 ? ['127.0.0.1', '::1'] : ['127.0.0.1'],
      close() {
        v4.close();
        v6?.close();
      },
    };
  })();
}

module.exports = { startRendererServer, resolveWithinRoot, PREFERRED_PORT };
