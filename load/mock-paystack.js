'use strict';
// A stand-in for Paystack for load tests ONLY (never used in production). Remembers each payment started with /transaction/initialize and
// reports it as paid, for the exact amount, when /transaction/verify is called. Adds a small delay like a real network call.
//   PORT=4999 LATENCY_MS=120 node load/mock-paystack.js
const http = require('http');
const paid = new Map(); let inits = 0, verifies = 0;
const LATENCY = Number(process.env.LATENCY_MS) || 120;
http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => setTimeout(() => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/stats') return send(200, { inits, verifies, known: paid.size });
    if (req.url === '/transaction/initialize' && req.method === 'POST') { const b = JSON.parse(Buffer.concat(chunks)); inits++; paid.set(b.reference, b.amount); return send(200, { status: true, data: { authorization_url: 'https://checkout.paystack.test/' + b.reference, reference: b.reference } }); }
    const v = /^\/transaction\/verify\/(.+)$/.exec(req.url);
    if (v) { verifies++; const ref = decodeURIComponent(v[1]); return paid.has(ref) ? send(200, { status: true, data: { reference: ref, status: 'success', amount: paid.get(ref), currency: 'NGN' } }) : send(404, { status: false, message: 'Transaction reference not found' }); }
    send(404, { error: 'no route' });
  }, LATENCY));
}).listen(Number(process.env.PORT) || 4999, '127.0.0.1', () => console.log('mock paystack on', process.env.PORT || 4999));
