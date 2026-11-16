'use strict';
// Downloads a supplier's product photo for us to keep. The address comes from a spreadsheet we did not write, so it is treated as hostile:
// only http/https on the normal ports, and the connection is refused if the name resolves to a private or internal address
// (checked at connect time, so a DNS trick cannot slip past), redirects are re-checked, size and time are capped.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateIp(mapped[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true; // not an address at all
}
const allowPrivate = () => process.env.ALLOW_PRIVATE_IMAGE_HOSTS === '1' && process.env.NODE_ENV !== 'production'; // tests only (they download from 127.0.0.1); ignored in production

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = allowPrivate() ? list : list.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error('That address is not allowed.'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function once(url, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('Not a valid address.')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Only http and https addresses are allowed.'));
    if (u.username || u.password) return reject(new Error('Addresses with a login are not allowed.'));
    if (!allowPrivate() && u.port && !['80', '443'].includes(u.port)) return reject(new Error('That port is not allowed.'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate() && isPrivateIp(host)) return reject(Object.assign(new Error('That address is not allowed.'), { code: 'EBLOCKED' })); // Node skips `lookup` for raw IPs
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: guardedLookup, timeout: timeoutMs, headers: { 'User-Agent': 'ShopBetaImageFetch/1.0', Accept: 'image/*' }, agent: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u).toString() }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('The photo link answered ' + res.statusCode + '.')); }
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); return reject(new Error('The photo is too large.')); }
      const chunks = []; let n = 0, done = false;
      const settle = (fn, v) => { if (!done) { done = true; fn(v); } };
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { settle(reject, new Error('The photo is too large.')); req.destroy(); } else chunks.push(c); });
      res.on('end', () => settle(resolve, { buf: Buffer.concat(chunks), type: String(res.headers['content-type'] || '') }));
      res.on('error', (e) => settle(reject, e));
      res.on('close', () => settle(reject, new Error('The connection closed early.')));
    });
    req.on('timeout', () => req.destroy(new Error('The photo link took too long.')));
    req.on('error', reject);
  });
}

async function fetchBuffer(url, { maxBytes = 5_000_000, timeoutMs = 10000, redirects = 3 } = {}) {
  let cur = url;
  for (let i = 0; i <= redirects; i++) {
    const r = await once(cur, { maxBytes, timeoutMs });
    if (r.redirect) { cur = r.redirect; continue; }
    return r;
  }
  throw new Error('Too many redirects.');
}

module.exports = { fetchBuffer, isPrivateIp };
