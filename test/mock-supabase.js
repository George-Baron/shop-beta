'use strict';
// A tiny stand-in for Supabase Storage so tests can check what the app sends. Used by the tests only.
// Speaks the parts of the Storage REST API the app uses: create bucket, upload (POST), public read (GET), delete.
const http = require('http');

function start(serviceKey) {
  const objects = new Map(); // "bucket/path" -> { buf, type, cache }
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks), url = new URL(req.url, 'http://x');
      const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
      const pub = /^\/storage\/v1\/object\/public\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && pub) { const o = objects.get(decodeURIComponent(pub[1])); return o ? send(200, o.buf, o.type) : send(404, { error: 'not found' }); }
      // everything else needs the service key, like the real thing
      if (req.headers.authorization !== 'Bearer ' + serviceKey || req.headers.apikey !== serviceKey) { log.push({ denied: req.method + ' ' + url.pathname }); return send(401, { error: 'Unauthorized' }); }
      if (req.method === 'POST' && url.pathname === '/storage/v1/bucket') { const b = JSON.parse(buf.toString()); log.push({ bucket: b }); return send(b.id === 'exists' ? 409 : 200, { name: b.name }); }
      const obj = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (obj && req.method === 'POST') {
        const key = obj[1] + '/' + decodeURIComponent(obj[2]);
        if (objects.has(key) && req.headers['x-upsert'] !== 'true') return send(409, { error: 'Duplicate' });
        objects.set(key, { buf, type: req.headers['content-type'], cache: req.headers['cache-control'] });
        log.push({ put: key, type: req.headers['content-type'], bytes: buf.length }); return send(200, { Key: key });
      }
      if (obj && req.method === 'DELETE') { objects.delete(obj[1] + '/' + decodeURIComponent(obj[2])); return send(200, { message: 'Successfully deleted' }); }
      send(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + server.address().port, objects, log, close: () => server.close() })));
}
module.exports = { start };
