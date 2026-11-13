# Pharmacy department (phase 2)

**Status: groundwork. Switched off. This is software, not legal advice, and it does not make the business compliant by itself.**
The rules below come from a summary supplied by the owner. They must be checked against the official texts (NAFDAC, PCN, NDPA, the e-pharmacy and aggregator rules) by a Nigerian lawyer and the PCN before any medicine is sold. Do not turn it on, and do not list any medicine, until then.

## 1. Switching it on and off

| Setting | Meaning |
|---|---|
| `PHARMACY_ENABLED` empty (default) | Pharmacy does not exist for customers. The Pharmacy department tab, medicines, search, cart, wishlist, sitemap and `/api/pharmacy/*` all behave as if it were not there. The seeded demo medicines stay hidden. |
| `PHARMACY_ENABLED=1` | Approved, in-date medicines from approved, licensed partner pharmacies become visible and orderable. |

Admin > Pharmacy shows a **readiness checklist** that never switches anything on. `npm run preflight` fails if the flag is on without `PHARMACY_DATA_KEY` and an SMS gateway.

## 2. Who does what

| Role | Where | Can |
|---|---|---|
| Admin | /admin > Pharmacy | Add pharmacies, upload the signed agreement, approve or suspend a pharmacy, create pharmacist accounts, clear flags, handle problem reports, set homepage details. **Cannot open prescriptions.** |
| Partner pharmacist (`pharmacist`, pharmacy set) | /pharmacist | Verify prescriptions for orders of their own pharmacy; set medicine details (prescription-only flag, NAFDAC no., batch, expiry, storage, cold chain) for their own pharmacy's products. |
| Our superintendent pharmacist (`pharmacist`, no pharmacy) | /pharmacist | Approves or rejects medicine listings; reviews suspicious-order flags; can see all queues. |
| Rider | /rider | Medicine orders need the buyer's name as well as the 6-digit code; cold-chain orders only go to riders marked GDP. |

## 3. Rules enforced in code

* **Partner pharmacies**: premises licence no., e-pharmacy licence no., superintendent name and reg. no., licence year (valid 1 Jan - 31 Dec), signed agreement upload (encrypted, private bucket). Approval is refused with missing papers or a finished licence year. Editing licence details sends it back for approval. When a licence year ends its medicines disappear automatically.
* **Medicines**: hidden until the pharmacy sets the details **and our superintendent approves**: NAFDAC number (for medicines), batch, a future expiry date, storage temperature, an approved pharmacy. Any later edit sends the listing back for approval. An expired batch hides itself.
* **Buying**: signed-in customer, phone verified by SMS code (6 digits, 10 minutes, 5 tries), ID type and number (stored encrypted; staff see only the last 4), one pharmacy per order, medicines never mixed with other goods, home delivery only (no pickup), delivery stays inside Nigeria.
* **Prescriptions**: photo or PDF (JPG, PNG, PDF; content checked, 4 MB), prescriber name, reg. no., phone or email, Nigerian address, patient name, date, duration, medicines with quantities. Valid 6 months from the date. Only the quantity written can be supplied. Refills only if the prescription allows more than one supply and only after the prescriber's interval. The file and patient details are encrypted before storage.
* **Single use**: a fill is reserved when the pharmacist approves, used when delivered, and given back if the order is cancelled. The same image (hash) or the same prescriber + patient + date (keyed fingerprint) raises a flag.
* **Pharmacist check**: compare items and quantities, record the manual council-register lookup (required text), confirm the ID was checked, then approve / partly approve (amends the order and returns stock) / reject (order cancelled, stock returned) / ask for more information. Pharmacist name, reg. no. and time are saved on the prescription and the order history. Nothing can move to paid/processing/shipped/delivered without approval.
* **Paying**: for prescription orders nothing is charged at checkout. The customer pays after approval from the order page. Unverified orders are cancelled after `pharm_unverified_hours` (default 48) and the stock returns.
* **Suspicious orders** (hold until the superintendent reviews): many orders by the same person in 24 hours, the same address used by a different customer within 7 days, a quantity above the limit, a reused prescription.
* **Handover**: code **and** the recipient's name must match the buyer. Admin override cannot complete a medicine delivery. Cold-chain orders can only be assigned to a rider with the GDP flag.
* **Returns**: only tampered, expired, damaged or wrong item, within `pharm_return_days`. Returned medicines are never put back on sale automatically.
* **Records**: kept 5 years (`retain_until`), separate tables with row-level security on, every opening of a prescription, order review or agreement is written to the audit log (Admin > Pharmacy).

## 4. NOT built, or only partly built. Be honest with your lawyer about these.

* **NEPP**: placeholder only (`lib/nepp.js` throws "not configured"). We have not been given the official API documentation and have not invented one.
* **Same payment details flag**: not built. It needs a card fingerprint from Paystack, which is not stored yet.
* **Prescriber verification** is manual (the pharmacist looks them up and records it); there is no automatic register lookup.
* **ID verification** is a pharmacist check of what the buyer typed; there is no NIN/BVN service connected.
* **Automatic deletion** after 5 years is not built (`retain_until` is recorded; no job deletes yet). **Data-subject requests** (NDPA access/erasure) are manual.
* **Pharmacy-side stock, pricing and settlement** are not separated: pharmacy products are ordinary products linked to a pickup point.
* **GDP couriers**: a simple flag on the rider; no temperature logging.
* **SMS**: no vendor is built in. Use `SMS_DRIVER=webhook`: the app POSTs `{ "to": "2348031234567", "message": "..." }` with `Authorization: Bearer SMS_WEBHOOK_TOKEN` to `SMS_WEBHOOK_URL`. Adapt to your provider (a tiny proxy function is enough).
* Customers can add a prescription to a waiting order only by its reference; the checkout screen is the proper place to upload.
* Not tested against real Supabase Storage, a real SMS gateway or real pharmacists.

## 5. Setup order when the time comes

1. Create two **private** Supabase Storage buckets: `prescriptions`, `pharmacy-docs`.
2. Set `PHARMACY_DATA_KEY` (24+ chars, keep a copy outside Render), the SMS variables, then deploy with `PHARMACY_ENABLED` still empty.
3. Admin > Pharmacy: add the pickup point of each partner pharmacy, enter licences, upload the signed agreement, create its pharmacist and our superintendent pharmacist, approve the pharmacy. Fill the homepage details (PCN logo, aggregator licence number, prescription-only statement).
4. The pharmacy sets medicine details at /pharmacist; our superintendent approves each listing.
5. Lawyer and PCN review. Tick the two confirmations in the checklist. Only then set `PHARMACY_ENABLED=1`.
6. Backups include these tables; **restoring needs the same `PHARMACY_DATA_KEY`** to read prescriptions, patient details and ID numbers.

## 6. Compliance checklist (for your lawyer and the PCN)

Tick each only after it has been checked against the official text.

- [ ] Aggregator licence: is one needed, who holds it, and the exact wording and logo the PCN requires on the site
- [ ] Each partner pharmacy: valid premises licence and e-pharmacy licence for the current year; superintendent registered; written agreement covers responsibility for dispensing, returns and records
- [ ] Which products may be sold online at all (controlled drugs, antibiotics, cold-chain items, medical devices) and whether the "prescription-only" list is ours or the pharmacy's to set
- [ ] Prescription content and validity: the fields required, the 6-month validity, quantity and refill limits, electronic prescriptions and NEPP obligations
- [ ] Verification duty: what a pharmacist must check and record before supply, and who must be named on the record
- [ ] Buyer identity: whether ID is required, which types, and what may be kept
- [ ] Delivery: who may deliver, GDP and temperature rules, hand-over to the patient or a representative, delivery outside Nigeria
- [ ] Returns and recalls: tampered, expired and recalled products; adverse-event reporting
- [ ] NDPA: lawful basis for health data, privacy notice, retention (5 years assumed), security, breach notice, cross-border storage (Supabase region), data-processing agreements (Supabase, Render, Paystack, SMS vendor), registration or DPCO audit duty
- [ ] Advertising: rules for promoting medicines (promo codes and discounts on prescription-only items should probably be disabled)
- [ ] Terms, privacy policy and checkout wording reviewed
