'use strict';
// Test-only issuer. Never loaded in production (see index.js). It issues no real cards and invents no card numbers: the tests send "issuer" webhooks themselves.
const crypto = require('crypto');
const secret = () => process.env.CARD_WEBHOOK_SECRET || 'sandbox-secret';
let n = 0;
module.exports = {
  name: 'sandbox',
  async createApplication({ kyc }) { if (!kyc || (!kyc.bvn && !kyc.nin)) { const e = new Error('The issuer needs a BVN or NIN.'); e.status = 400; throw e; } return { providerRef: 'SBX-APP-' + Date.now().toString(36) + (n++), status: 'under_review' }; },
  async activate() { return {}; }, async freeze() { return {}; }, async unfreeze() { return {}; }, async block() { return {}; },
  async revealSession(card) { return { url: 'https://issuer.example/secure/' + card.provider_card_id, expires: Math.floor(Date.now() / 1000) + 120 }; },
  verifyWebhook(raw, headers) { const want = crypto.createHmac('sha256', secret()).update(raw || '').digest('hex'), got = String(headers['x-card-signature'] || ''); return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); },
  parseWebhook(b) { return b; },
  sign(raw) { return crypto.createHmac('sha256', secret()).update(raw).digest('hex'); },
};
