/**
 * Serve dist/ as static files over HTTP, with sane caching headers and
 * traversal guards. No express, no new dependencies. The whole contract is
 * one route table with five branches.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, resolve, sep, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
};

/**
 * Serve a static file from dist/, or fall back to index.html for SPA routes.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function serveStatic(req, res) {
  const method = req.method;
  // Only GET and HEAD.
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end('405 Method Not Allowed');
    return;
  }

  // /healthz first, before any filesystem work.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (method === 'GET') res.end('ok');
    else res.end();
    return;
  }

  // Parse the pathname, strip the query string.
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // Decode and normalize, with traversal guard.
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, rel);

  // Traversal guard, mandatory.
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Directory to index.html.
  let targetPath = full;
  if (pathname.endsWith('/')) {
    targetPath = join(full, 'index.html');
  }

  // Stat the file.
  let s;
  try {
    s = await stat(targetPath);
  } catch {
    // Missing file: two different behaviours.
    if (pathname.endsWith('/') || !extname(pathname)) {
      // SPA fallback: serve index.html with 200 for extensionless paths.
      targetPath = join(ROOT, 'index.html');
      try {
        s = await stat(targetPath);
      } catch {
        // dist/ is entirely absent.
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dist/ is missing. Run "npm run build". In dev the page is served by vite on 5273.');
        return;
      }
    } else {
      // Extensioned path that does not exist: 404.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
  }

  // Not a file.
  if (!s.isFile()) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // ETag / Last-Modified.
  const lastModified = s.mtime.toUTCString();
  const ifModifiedSince = req.headers['if-modified-since'];
  if (ifModifiedSince && ifModifiedSince === lastModified) {
    res.writeHead(304);
    res.end();
    return;
  }

  // Cache-Control.
  let cacheControl;
  const ext = extname(targetPath).toLowerCase();
  if (ext === '.map') {
    cacheControl = 'no-store';
  } else if (pathname.startsWith('/assets/')) {
    cacheControl = 'public, max-age=31536000, immutable';
  } else if (targetPath.endsWith('index.html')) {
    cacheControl = 'no-cache';
  } else {
    cacheControl = 'public, max-age=3600';
  }

  // Serve the file.
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': s.size,
    'Last-Modified': lastModified,
    'Cache-Control': cacheControl,
    ...(ext === '.map' && { 'X-Robots-Tag': 'noindex' }),
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(targetPath);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('500 Internal Server Error');
  });
  stream.pipe(res);
}
