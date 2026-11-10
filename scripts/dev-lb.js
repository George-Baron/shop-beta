#!/usr/bin/env node
'use strict';
// A small round-robin load balancer for trying (and testing) several instances on one computer.
//   node scripts/dev-lb.js 8080 http://127.0.0.1:3101 http://127.0.0.1:3102
// It checks /health every second, stops sending traffic to an instance that is down or shutting down, and
// quietly retries a GET on another instance if one fails mid-request (like Render's load balancer does).
const http = require('http');

function createLb(targets, { healthMs = 1000 } = {}) {
  const state = targets.map((t) => ({ url: new URL(t), up: true }));
  let rr = 0;
  const check = (s) => new Promise((resolve) => {
    const r = http.get({ hostname: s.url.hostname, port: s.url.port, path: '/health', timeout: 1500 }, (res) => { res.resume(); s.up = res.statusCode === 200; resolve(); });
    r.on('error', () => { s.up = false; resolve(); }); r.on('timeout', () => { r.destroy(); });
  });
  const timer = setInterval(() => state.forEach(check), healthMs); timer.unref();
  const pick = (skip) => { for (let i = 0; i < state.length; i++) { const s = state[(rr++) % state.length]; if (s.up && !skip.has(s)) return s; } return null; };
  const server = http.createServer((req, res) => {
    const body = []; req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const payload = Buffer.concat(body), tried = new Set(), retryable = req.method === 'GET' || req.method === 'HEAD';
      const attempt = () => {
        const s = pick(tried);
        if (!s) { res.writeHead(502); return res.end('No healthy instance'); }
        tried.add(s);
        const up = http.request({ hostname: s.url.hostname, port: s.url.port, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
        up.on('error', () => { s.up = false; if (retryable && !res.headersSent) attempt(); else if (!res.headersSent) { res.writeHead(502); res.end('Instance failed'); } });
        up.end(payload);
      };
      attempt();
    });
  });
  server.on('close', () => clearInterval(timer));
  return { server, state };
}
module.exports = { createLb };

if (require.main === module) {
  const [port, ...targets] = process.argv.slice(2);
  if (!port || !targets.length) { console.error('Usage: node scripts/dev-lb.js <port> <instance url> [<instance url> ...]'); process.exit(1); }
  createLb(targets).server.listen(Number(port), () => console.log(`Load balancer on :${port} -> ${targets.join(', ')}`));
}
