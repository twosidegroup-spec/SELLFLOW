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

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let path = join(ROOT, normalize(url === '/' ? '/index.html' : url));

  // Never serve outside dist.
  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
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
}).listen(PORT, () => {
  console.log(`  SellFlow site -> http://127.0.0.1:${PORT}/`);
});