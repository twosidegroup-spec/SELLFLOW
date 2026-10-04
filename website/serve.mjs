/**
 * Minimal static server for previewing website/dist locally.
 *
 *   node website/serve.mjs [port]
 *
 * Deliberately small, but it handles the two things a plain file:// open
 * cannot: correct MIME types, and HEAD requests (the download buttons issue a
 * HEAD against the APK to confirm it is really there before claiming success).
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const PORT = Number(process.argv[2] ?? 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

/**
 * Mirrors the routing the Vercel project applies, so a local preview behaves like
 * the deployment instead of like a plain file server.
 *
 * Both rules come from the root `vercel.json` and are duplicated here on purpose:
 * a preview that resolves deep links but production does not (or the reverse) is
 * worse than no preview, because it hides exactly the bug you opened the preview
 * to find.
 */
const DASHBOARD_BASE = '/app';

/** `/login`, `/register`, `/dashboard` -> the real authenticated routes. */
const REDIRECTS = {
  '/login': `${DASHBOARD_BASE}/sign-in`,
  '/register': `${DASHBOARD_BASE}/register`,
  '/dashboard': DASHBOARD_BASE,
};

createServer((req, res) => {
  /*
   * Wrapped because this is a preview tool that a long audit run depends on, and
   * an unhandled throw here kills the process. A browser opening and abandoning
   * several requests in a row is enough to do that: a socket reset on a HEAD, or a
   * request for a path with no extension, and the server is gone. Then every later
   * navigation reports "connection refused" and the run's results are all
   * infrastructure noise masquerading as application failures.
   */
  try {
    handle(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('Preview server error');
    } else {
      res.end();
    }
    console.error(`serve: ${req.method} ${req.url} -- ${error.message}`);
  }
}).listen(PORT, () => {
  console.log(`  SellFlow site     -> http://127.0.0.1:${PORT}/`);
  console.log(`  Seller dashboard  -> http://127.0.0.1:${PORT}${DASHBOARD_BASE}/`);
  console.log(`  Sign in           -> http://127.0.0.1:${PORT}/login\n`);
});

function handle(req, res) {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

  const redirect = REDIRECTS[url.replace(/\/$/, '') || '/'];
  if (redirect) {
    res.writeHead(302, { location: redirect }).end();
    return;
  }

  let path = join(ROOT, normalize(url === '/' ? '/index.html' : url));

  // Never serve outside dist.
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');

  if (!existsSync(path)) {
    /*
     * The dashboard is a single-page export (`web.output: "single"`), so every
     * route below it is resolved on the client. Production rewrites any
     * unmatched /app/* request to /app/index.html; without this a hard refresh on
     * /app/orders returns 404 locally and the preview stops predicting production.
     *
     * Real files still win, because this only runs after the existence check.
     */
    if (url === DASHBOARD_BASE || url.startsWith(`${DASHBOARD_BASE}/`)) {
      path = join(ROOT, DASHBOARD_BASE, 'index.html');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }

  const stat = statSync(path);
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-cache',
    // Long enough to let the APK download without being cut off mid-transfer.
    'accept-ranges': 'bytes',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
}