'use strict';
// Card issuer adapters. VELTO never creates card numbers: a licensed issuer does, and an adapter is the only code that talks to it.
// Every adapter must provide:
//   createApplication({ user, kind, kyc, delivery })  -> { providerRef, status }   (kyc holds BVN/NIN etc. and is passed straight through, never stored or logged)
//   activate(card)  freeze(card)  unfreeze(card)  block(card, reason)             -> {}   (card.provider_card_id identifies it at the issuer)
//   revealSession(card) -> { url, expires }   (the issuer's own secure page for showing full details)
//   verifyWebhook(rawBody, headers) -> boolean ;  parseWebhook(body) -> { eventId, type, ... }
// Real adapters (Sudo Africa, Bridgecard, Flutterwave, Miden, ...) are added here only after the contract, credentials and sandbox tests exist.
// The "sandbox" adapter is for automated tests and refuses to load in production.
const name = () => String(process.env.CARD_PROVIDER || '').toLowerCase();
function get() {
  const n = name(); if (!n) return null;
  if (n === 'sandbox') { if (process.env.NODE_ENV === 'production') throw new Error('The sandbox card provider cannot be used in production.'); return require('./sandbox'); }
  try { return require('./' + n.replace(/[^a-z0-9_-]/g, '')); } catch { console.error('Card provider "%s" is not installed.', n); return null; }
}
module.exports = { get, name };
