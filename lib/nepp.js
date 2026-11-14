'use strict';
// National Electronic Pharmacy Platform (NEPP) integration: PLACEHOLDER ONLY.
// The official technical documentation has not been provided, so no real API is called and none is invented here.
// When you have the documentation, implement the three functions below and set NEPP_ENABLED=1. Until then every call says "not configured".
// Callers (see lib/pharmacy.js) treat "not configured" as normal and carry on, so nothing depends on this module yet.
class NotConfigured extends Error { constructor() { super('The National Electronic Pharmacy Platform integration is not set up yet (no official documentation has been provided).'); this.code = 'NEPP_NOT_CONFIGURED'; } }
const isConfigured = () => false; // change when implemented
// 1. Check a prescriber against the official register (today the pharmacist does this by hand and records the result).
async function verifyPrescriber(/* { council, regNo, name } */) { throw new NotConfigured(); }
// 2. Report a verified prescription / dispensing event to the platform.
async function reportDispensing(/* { prescriptionRef, orderRef, items, pharmacy } */) { throw new NotConfigured(); }
// 3. Report a return or recall of a medicine.
async function reportReturn(/* { orderRef, reason } */) { throw new NotConfigured(); }
module.exports = { isConfigured, verifyPrescriber, reportDispensing, reportReturn, NotConfigured };
