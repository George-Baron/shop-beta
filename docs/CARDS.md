# VELTO-MART CARD (phase 3)

A real card, issued by a licensed issuer. VELTO-MART never creates card numbers and never stores a card number, CVV, BVN or NIN. **The programme is OFF until an issuer is chosen, contracted and tested**: `card_enabled` = 0 and no `CARD_PROVIDER` is set, so customers see "coming soon" and cannot apply.

## What is built (issuer-neutral)
- **Adapter layer** `lib/card-providers/`: one small interface (create application, activate, freeze, unfreeze, block, reveal session, verify/parse webhook). Real adapters are added only after a contract, credentials and sandbox tests exist. A `sandbox` adapter exists for the automated tests and **refuses to load when NODE_ENV=production**.
- **Application flow:** consent record (terms version + time) -> BVN/NIN passed straight to the issuer (not stored, not returned) -> status driven by the issuer's webhooks: submitted, under_review, info_needed (message shown to the customer), approved, rejected (reason shown; may re-apply), issued. Statuses never move backwards. One open application per customer and kind.
- **Cards:** only issuer reference, network, last 4, expiry (if permitted), status, delivery status and an optional issuer-reported balance. Balance is **never combined with the wallet**.
- **Controls (always through the issuer first; nothing changes locally if the issuer call fails):** activate, freeze, unfreeze, block (lost/stolen), replace (blocks the old card, opens a replacement; old card becomes `replaced` when the new one is issued). Full details are shown only on the issuer's own secure page (`GET /:id/reveal` returns a short-lived issuer URL, never card data).
- **Transactions:** issuer webhooks store merchant, amount and status once (unique per transaction id).
- **Webhook:** `POST /api/cards/webhook` verifies the issuer signature; each event id is processed once.
- **Notifications:** application received, more info needed, approved, rejected, card issued, activated, frozen, blocked, delivery updates, transactions.
- **Admin (admin role):** list/read applications and history (metadata only), block a card via the issuer with a reason (audited), report of application/card/transaction counts.

## API (`/api/cards`, also `/api/mobile/v1/cards`)
GET `/` (programme availability, applications, cards) · POST `/apply {kind: virtual|physical, consent: true, bvn|nin, full_name?, delivery{name,phone,address,city,state} (physical)}` · POST `/:id/activate|freeze|unfreeze|block` · POST `/:id/replace` · GET `/:id/transactions` · GET `/:id/reveal`. Admin: GET `/api/admin/cards/applications?status=`, GET `/applications/:id`, POST `/:id/block {reason}`, GET `/report`. Webhook: POST `/api/cards/webhook`.

## Issuer selection: what I could and could not confirm (research, Nov 2026)
Gateway checkout is not card issuing. Findings come from public pages; **everything marked "confirm" must be verified with the provider before any decision**.
| Candidate | What the public sources say | To confirm |
|---|---|---|
| Flutterwave | Developer docs describe virtual cards in USD and NGN, funded from a Flutterwave wallet, with fund/cancel/transactions API and callbacks (funding, purchases, freezes, terminations). **Naira cards only work on platforms that use Flutterwave as processor.** Live creation needs an approved account via support. A 2022 report says Flutterwave shut an earlier virtual-card service. | Whether naira cards are available to VELTO-MART now, physical cards (not mentioned), fees, limits, usable beyond Flutterwave-processed merchants |
| Sudo Africa | Card-issuing API platform: Verve, Mastercard, Visa; virtual and physical; mainly **prefunded** cards; spend limits, settlement accounts, webhooks; platform plus per-authorisation fees. (Source is a competitor's blog.) | Issuing bank/licence, KYC/KYB, fee schedule, funding model fit, disputes |
| Bridgecard | Physical and virtual cards with Mastercard or Visa logo, "start in a week". The page gave no detail on naira, bank, KYC, fees. | Everything: naira support, bank, fees, limits, webhooks |
| Miden | Visa-partnered, NGN and USD, virtual and physical, pooled treasury funding (no per-card prefunding), full KYB, PCI DSS stated. (Self-published.) | Fees (quoted per programme), onboarding terms |
| Paystack, Interswitch, Monnify | I found **no public card-issuing product** for merchants (Interswitch is the Verve network owner; a card programme there would be a bank/issuer relationship). | Ask each directly; do not assume |
| US/EU issuers (Marqeta, Lithic, Adyen) | Need US/UK/EEA entities and lack Nigerian identity checks (BVN/NIN) and local rails. | Not suitable for a Nigerian-only programme |

**Criteria to score each candidate (ask every provider the same questions):** issuing bank and CBN licence; network (Verve, Mastercard, Visa); virtual and physical; naira and USD; who does KYC and which BVN/NIN checks; funding model (prefunded per card, pooled, or bank-linked debit); issuance, maintenance and per-transaction fees; limits; domestic vs international and POS/ATM; card management API (freeze, block, replace); webhooks; settlement timing; disputes and chargebacks; our regulatory responsibilities; branding/design approval and physical production time.
**Important modelling point:** if the card is prefunded or pooled, the card balance is a separate balance from the VELTO wallet (kept separate here). Wallet-to-card funding should only be built if the chosen issuer explicitly supports it. Do not advertise ATM, international or POS use until the issuer confirms it in writing.

## To go live (external, cannot be done in code)
1. Choose and contract an issuer; obtain sandbox credentials. 2. Write that provider's adapter against the interface above and test it in the issuer's sandbox. 3. Card design: network and issuer approval (VELTO navy-and-gold, logo) before any physical production. 4. Legal review of the card terms (`velto-card-terms-v1` is a placeholder version id, the real terms text must be approved), NDPR/consent for BVN/NIN handling and the issuer data-sharing agreement. 5. Set `CARD_PROVIDER`, `CARD_WEBHOOK_SECRET`/issuer keys, register the webhook URL, then set `card_enabled` = 1 in staging first.

Run: `npm run test:cards`.
