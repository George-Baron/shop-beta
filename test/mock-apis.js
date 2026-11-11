'use strict';
// Stand-ins for Resend (email) and Paystack (payments) so tests can make them fail on purpose. Used by tests only.
const http = require('http');

function start() {
  const state = {
    resend: { script: [], byTo: {}, calls: [] }, // statuses to answer with, in order (byTo: per recipient); when empty answer 200
    paystack: { verify: {}, verifyDown: false, calls: [] }, // verify[ref] = {status, amount, currency}
  };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString(), send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/emails' && req.method === 'POST') {
        const b = JSON.parse(body); const own = state.resend.byTo[b.to[0]]; const status = own && own.length ? own.shift() : state.resend.script.length ? state.resend.script.shift() : 200;
        state.resend.calls.push({ key: req.headers['idempotency-key'], to: b.to[0], subject: b.subject, status, auth: req.headers.authorization });
        return send(status, status === 200 ? { id: 'em_' + state.resend.calls.length } : { message: 'mock failure ' + status });
      }
      if (req.url === '/transaction/initialize' && req.method === 'POST') { const b = JSON.parse(body); state.paystack.calls.push({ init: b.reference, amount: b.amount }); return send(200, { status: true, data: { authorization_url: 'https://checkout.paystack.test/' + b.reference, reference: b.reference } }); }
      const v = /^\/transaction\/verify\/(.+)$/.exec(req.url);
      if (v && req.method === 'GET') {
        const ref = decodeURIComponent(v[1]); state.paystack.calls.push({ verify: ref });
        if (state.paystack.verifyDown) return send(503, { status: false, message: 'down' });
        const d = state.paystack.verify[ref]; if (!d) return send(404, { status: false, message: 'Transaction reference not found' });
        return send(200, { status: true, data: { reference: ref, status: d.status, amount: d.amount, currency: d.currency || 'NGN' } });
      }
      send(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + server.address().port, state, close: () => server.close() })));
}
module.exports = { start };
