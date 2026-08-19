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
 * The server binds to the loopback interface on an ephemeral port, so it is
 * reachable only from this machine, and serves a fixed whitelist of directories
 * — never the whole app root, which would expose main/ and config/ to any other
 * local process.
 */

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

/** Start the renderer's origin. Resolves to the base URL. */
function startRendererServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
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
          // Nothing here should ever be cached between runs of a dev build.
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    });

    server.on('error', reject);

    // Port 0 = let the OS pick a free one, so two instances never collide.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://localhost:${port}/renderer/index.html`, port });
    });
  });
}

module.exports = { startRendererServer, resolveWithinRoot };
