'use strict';
// The real visitor's IP. Behind Cloudflare, Express's own req.ip is a Cloudflare address shared by thousands of people, so limits keyed on it
// would block everyone together. We use Cloudflare's CF-Connecting-IP header, but ONLY when the request really came through Cloudflare
// (its last hop is a Cloudflare address). A direct hit on the origin cannot fake the header.
const net = require('net');

const V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
// Cloudflare publishes its ranges at https://www.cloudflare.com/ips/ . Override with CLOUDFLARE_RANGES="a/b,c/d" if they change.
const RANGES = (process.env.CLOUDFLARE_RANGES ? process.env.CLOUDFLARE_RANGES.split(',') : V4.concat(V6)).map((s) => s.trim()).filter(Boolean);

const toBig = (ip) => {
  if (net.isIPv4(ip)) return { v: 4, n: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
  if (!net.isIPv6(ip)) return null;
  let [head, tail] = ip.split('::'); const h = head ? head.split(':') : [], t = tail === undefined ? [] : tail ? tail.split(':') : [];
  if (tail === undefined && h.length !== 8) return null;
  const parts = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (parts.some((p) => p.includes('.'))) return null; // IPv4-in-IPv6 forms are not Cloudflare edges
  return { v: 6, n: parts.reduce((a, p) => (a << 16n) + BigInt(parseInt(p || '0', 16)), 0n) };
};
const parsed = RANGES.map((c) => { const [ip, bits] = c.split('/'); const b = toBig(ip); return b && { v: b.v, n: b.n, bits: Number(bits) }; }).filter(Boolean);
function isCloudflare(ip) {
  const x = toBig(String(ip || '').replace(/^::ffff:/, ''));
  if (!x) return false;
  return parsed.some((r) => { if (r.v !== x.v) return false; const total = r.v === 4 ? 32n : 128n, shift = total - BigInt(r.bits); return (x.n >> shift) === (r.n >> shift); });
}
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  // The last address in X-Forwarded-For is the hop our own host (Render) saw: if that is Cloudflare, the header is genuine.
  const lastHop = xff.length ? xff[xff.length - 1] : String(req.socket && req.socket.remoteAddress || '');
  if (cf && net.isIP(cf) && isCloudflare(lastHop)) return cf;
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}
module.exports = { clientIp, isCloudflare };
