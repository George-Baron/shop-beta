'use strict';
// Is an import or export consignment ready for its next step, and what is missing? Pure: facts in, a plain verdict out. Nothing here reads the database
// or decides anything legal. Regulated goods and unfinished permit reminders are always passed to a person; this never marks a permit as done.
const STAGES = ['draft', 'booked', 'in_transit', 'arrived', 'cleared', 'delivered'];
const have = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '0';

// facts: { shipment, items, issued: ['commercial_invoice',...], files: ['bill_of_lading',...], checklist: { items: [...] }, flags: [{ slug,label,action,why,item }],
//          stock: [{ description, need, have }] (export, only for lines tied to a product), linked: { orders, purchase_orders }, vendor: { verified: bool } | null }
function readiness(f, now) {
  const s = f.shipment, isExp = s.direction === 'export', blockers = [], warnings = [];
  const add = (arr, code, message, fix, who) => arr.push({ code, message, fix, owner: who || 'trade' });
  const docs = new Set([...(f.issued || []), ...(f.files || [])]);
  const hasInvoice = docs.has('commercial_invoice') || docs.has('invoice'), hasPacking = docs.has('packing_list'), hasTransportDoc = docs.has('bill_of_lading') || docs.has('airway_bill') || have(s.bill_no);
  const items = f.items || [];

  // 1. The parties and the goods
  if (!have(s.party_name)) add(blockers, 'party_missing', isExp ? 'The buyer is not named.' : 'The supplier is not named.', 'Enter the party on the shipment.');
  if (isExp) {
    if (!have(s.party_address)) add(blockers, 'buyer_address', 'The buyer address is missing.', 'Enter the buyer address. It is printed on the invoice.');
    if (!have(s.party_country)) add(blockers, 'buyer_country', 'The buyer country is missing.', 'Enter the buyer country.');
    if (!have(s.party_tax_id)) add(warnings, 'buyer_tax_id', 'No buyer tax or registration number is recorded.', 'Ask the buyer for it; some destinations require it.');
    if (!have(s.party_contact)) add(warnings, 'buyer_contact', 'No buyer contact is recorded.', 'Add a contact.');
  } else if (f.vendor && !f.vendor.verified) add(blockers, 'vendor_unverified', 'The supplier on the linked purchase order has not been verified by a person.', 'Verify the supplier in Procurement before committing goods or money.', 'procurement');
  if (!items.length) add(blockers, 'no_items', 'No goods are listed.', 'Add the goods with quantity and value.');
  const noHs = items.filter((i) => !have(i.hs_code)), noOrigin = items.filter((i) => !have(i.origin_country)), noWeight = items.filter((i) => !(Number(i.weight_kg) > 0));
  if (noHs.length) add(blockers, 'hs_missing', `${noHs.length} line(s) have no HS code: ${noHs.slice(0, 3).map((i) => i.description).join(', ')}${noHs.length > 3 ? '…' : ''}.`, 'Add the HS code. If unsure of the classification, ask a customs broker; the AI does not guess it.', 'compliance');
  if (noOrigin.length) add(warnings, 'origin_missing', `${noOrigin.length} line(s) have no country of origin.`, 'Add it; customs and the certificate of origin need it.');
  if (noWeight.length) add(warnings, 'weight_missing', `${noWeight.length} line(s) have no unit weight.`, 'Add weights so packing and freight can be checked.');
  if (items.some((i) => !(Number(i.unit_value) > 0))) add(blockers, 'value_missing', 'A line has no unit value.', 'Enter the value of every line; customs value cannot be zero.');

  // 2. Compliance: the AI only raises these. A person ticks them.
  for (const fl of f.flags || []) {
    if (fl.action === 'block') add(blockers, 'restricted_blocked', `Prohibited class: ${fl.label} (${fl.why}) on "${fl.item}".`, 'Do not ship. A compliance officer must decide.', 'compliance');
    else add(blockers, 'restricted_review', `Regulated class needs a person to verify permits: ${fl.label} (${fl.why}) on "${fl.item}".`, 'Check the permit with the authority, then record it in the checklist.', 'compliance');
  }
  const open = ((f.checklist && f.checklist.items) || []).filter((c) => c.required && c.status === 'pending');
  if (open.length) add(blockers, 'checklist_open', `${open.length} required permit or licence reminder(s) not yet confirmed by a person: ${open.slice(0, 3).map((c) => c.title).join('; ')}${open.length > 3 ? '…' : ''}.`, 'Verify each with the official source and tick it off. The AI never ticks these.', 'compliance');

  // 3. Documents
  if (!hasInvoice) add(blockers, 'invoice_missing', 'No commercial invoice (issued or uploaded).', isExp ? 'Issue the commercial invoice from the shipment.' : 'Upload the supplier commercial invoice.');
  if (!hasPacking) add(blockers, 'packing_missing', 'No packing list (issued or uploaded).', 'Issue or upload the packing list.');
  if (!isExp && !docs.has('proforma') && !docs.has('purchase_order') && s.status === 'draft') add(warnings, 'proforma_missing', 'No pro forma invoice or purchase order is on file for this import.', 'Request a pro forma invoice from the supplier before booking.', 'procurement');
  if (['booked', 'in_transit', 'arrived', 'cleared', 'delivered'].includes(s.status) === false && !hasTransportDoc) add(warnings, 'transport_doc_pending', 'No bill of lading, airway bill or tracking number yet.', 'It is needed before the goods can move; enter it when the forwarder issues it.', 'forwarder');
  if (['booked', 'in_transit'].includes(s.status) && !hasTransportDoc) add(blockers, 'transport_doc_missing', 'The shipment is booked or moving with no bill of lading, airway bill or container number.', 'Get it from the forwarder.', 'forwarder');
  if (!isExp && docs.has('insurance') === false && !(Number(s.insurance) > 0) && !['CIF', 'CIP'].includes(s.incoterm)) add(warnings, 'no_insurance', 'No insurance is recorded and the Incoterm does not include it.', 'Confirm cover for the goods in transit.', 'finance');

  // 4. Forwarder and dates
  if (!have(s.forwarder) && s.status !== 'draft') add(warnings, 'no_forwarder', 'No freight forwarder or carrier is named.', 'Name the forwarder.', 'forwarder');
  if (s.eta && Number(s.eta) < now && ['booked', 'in_transit'].includes(s.status)) add(blockers, 'eta_passed', `The expected arrival date has passed (${Math.floor((now - Number(s.eta)) / 86400)} day(s) ago) and the goods are not recorded as arrived.`, 'Ask the forwarder for the real position and update the shipment.', 'forwarder');
  if (['held', 'queried'].includes(s.customs_status) && s.status !== 'delivered') add(blockers, 'customs_' + s.customs_status, `Customs has ${s.customs_status === 'held' ? 'held' : 'queried'} this consignment.`, 'Answer the query or provide what customs asks for through the clearing agent.', 'forwarder');

  // 5. Cost completeness (an estimate with gaps must say so)
  const cost = { missing: [] };
  if (!isExp) {
    if (!(Number(s.freight) > 0) && !['CIF', 'CIP', 'DAP', 'DDP', 'CFR', 'CPT', 'DPU'].includes(s.incoterm)) cost.missing.push('freight');
    if (!(Number(s.duty_pct) > 0)) cost.missing.push('duty rate (confirm; zero may be correct for some goods)');
    if (!(Number(s.agent_fee) > 0)) cost.missing.push('clearing agent fee');
    if (s.currency !== 'NGN' && !(Number(s.fx_rate) > 0)) cost.missing.push('exchange rate');
  }
  if (cost.missing.length) add(warnings, 'cost_incomplete', `The landed cost is only partly known. Missing: ${cost.missing.join(', ')}.`, 'Fill these from real quotations and receipts. The AI does not guess customs charges.', 'finance');

  // 6. Export stock
  if (isExp) for (const st of f.stock || []) if (st.have < st.need) add(blockers, 'stock_short', `Only ${st.have} of ${st.need} available for "${st.description}".`, 'Restock, reduce the quantity or split the shipment.', 'warehouse');
  if (isExp && (f.stock || []).length === 0 && items.some((i) => i.product_id)) add(warnings, 'stock_unchecked', 'Stock could not be checked.', 'Confirm the goods are in the warehouse.', 'warehouse');

  // 7. The next step, in plain words
  const idx = STAGES.indexOf(s.status);
  let next = s.status === 'cancelled' ? 'Cancelled.' : s.status === 'delivered' ? 'Complete.' : '';
  if (!next) next = blockers.length ? `Not ready: ${blockers.length} thing(s) to resolve before the next step.` : s.status === 'draft' ? 'Ready to book with the forwarder.' : s.status === 'booked' ? 'Waiting for departure. Record the transport document and track.' : s.status === 'in_transit' ? 'In transit. Track to arrival and prepare customs.' : s.status === 'arrived' ? 'Arrived. Clear customs.' : 'Cleared. Deliver to the warehouse or buyer.';
  return { ready: blockers.length === 0 && !['cancelled', 'delivered'].includes(s.status), stage: s.status, stage_index: idx, next_step: next, blockers, warnings, cost_gaps: cost.missing, needs_compliance: blockers.some((b) => b.owner === 'compliance') };
}

module.exports = { readiness, STAGES };
