# Import & Export enquiries

The public **Import & Export** page (live in the next step) lets a visitor ask for help bringing goods **into** Nigeria (import) or buying Nigerian goods to send **abroad** (export). This document covers how an enquiry travels through the system.

## What happens when someone sends the form
- `POST /api/trade-enquiries` (public, no account needed; signed-in visitors are linked to their account). Limited to 5 an hour per visitor; a hidden "website" field catches bots; the same person sending the same item twice within a day is one enquiry.
- Needed: Import or Export, name, a valid email, what they want, which country (where the goods come from for an import, where they go for an export) and a few details. Optional: company, phone, quantity, budget, timing, air or sea.
- The visitor gets an email with a reference (`TE-XXXXXXXX`). The team gets a notification (and email) in the **Requests for quotation** module.
- All text is stored as plain text and escaped in emails.

## The inbox
Admin → **Import & export enquiries**. Anyone with the *Requests for quotation* module can read it (Sales Representative, Finance Officer, Wholesale Sales Officer, Commercial roles, the owner); changing a status or note needs *Requests for quotation: Edit*. Filter by type or status, or search by name, email, company, item or reference. Open an enquiry to email or call the person, set the status (New, In progress, Quote sent, Won, Lost, Spam) and leave an internal note. The first change from New records when the team first responded and who.

No money moves in an enquiry. A real deal becomes a wholesale quote or a dropship order, and the shipment, documents and landed-cost tools in **Dropshipping → Imports & exports** (owner-only) take over.

Table: `trade_enquiries` (migration 044). No new environment variables.
