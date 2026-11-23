'use strict';
// Moves the big inline <script> and <style> blocks out of the page template into files that can be cached by the browser (and by Cloudflare) for a year.
//  - Runs once at start-up. Each file is named after a hash of its contents (app.3f2a9c1b7e.js), so a changed file gets a new name and nobody ever sees a stale one.
//  - Each file is compressed once here (brotli and gzip), not on every visit. Before this, every visitor was sent a 700 KB page that was built and gzipped for them alone.
//  - What is left in the page is a small shell (a few KB) with no per-visitor secret in it, so the shell itself can be cached for a short time too.
const crypto = require('crypto');
const zlib = require('zlib');

function build(template) {
  const files = new Map(); // name -> { raw, gz, br, type, etag }
  const add = (stem, ext, type, text) => {
    const raw = Buffer.from(text, 'utf8');
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
    const name = `${stem}.${hash}.${ext}`;
    if (!files.has(name)) files.set(name, { raw, gz: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }), type, etag: `"${hash}"` });
    return name;
  };
  let n = 0;
  let shell = template.replace(/<script>([\s\S]*?)<\/script>/g, (m, body) => `<script src="/assets/${add(n++ === 0 ? 'pre' : 'app' + (n > 2 ? n : ''), 'js', 'application/javascript; charset=utf-8', body)}"></script>`);
  let s = 0;
  shell = shell.replace(/<style>([\s\S]*?)<\/style>/g, (m, body) => `<link rel="stylesheet" href="/assets/${add('app' + (s++ ? s : ''), 'css', 'text/css; charset=utf-8', body)}">`);
  return { shell, files };
}

// Express handler for /assets/:name
function handler(files) {
  return (req, res, next) => {
    const f = files.get(req.params.name);
    if (!f) return next();
    res.set({ 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: f.etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' });
    if (req.get('If-None-Match') === f.etag) return res.status(304).end();
    const ae = String(req.get('Accept-Encoding') || '');
    const body = /\bbr\b/.test(ae) ? (res.set('Content-Encoding', 'br'), f.br) : /\bgzip\b/.test(ae) ? (res.set('Content-Encoding', 'gzip'), f.gz) : f.raw;
    res.set('Content-Length', String(body.length)).end(req.method === 'HEAD' ? undefined : body);
  };
}

module.exports = { build, handler };
