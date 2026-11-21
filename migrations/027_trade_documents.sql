-- Step 5 of dropshipping: import and export paperwork. Shipment records, trade documents, a compliance checklist per country pair
-- and restricted-item classes. Safe to run again. Nothing here changes existing data.

-- One row per shipment (an import from a supplier, or an export to a buyer).
CREATE TABLE IF NOT EXISTS trade_shipments (
  id BIGSERIAL PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,                                              -- SH-00001
  direction TEXT NOT NULL CHECK (direction IN ('import','export')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','booked','in_transit','arrived','cleared','delivered','cancelled')),
  incoterm TEXT NOT NULL DEFAULT 'FOB' CHECK (incoterm IN ('EXW','FCA','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',                               -- the currency of the values on the documents
  supplier_id BIGINT REFERENCES suppliers(id),                           -- the other party when it is one of our suppliers
  party_name TEXT NOT NULL DEFAULT '', party_address TEXT NOT NULL DEFAULT '', party_country CHAR(2),
  party_tax_id TEXT NOT NULL DEFAULT '', party_contact TEXT NOT NULL DEFAULT '',   -- supplier (import) or buyer (export): copied here so the documents never change later
  origin_country CHAR(2) NOT NULL, dest_country CHAR(2) NOT NULL,
  transport TEXT NOT NULL DEFAULT 'air' CHECK (transport IN ('air','sea','road','courier','rail')),
  forwarder TEXT NOT NULL DEFAULT '', forwarder_contact TEXT NOT NULL DEFAULT '',
  container_no TEXT NOT NULL DEFAULT '', bill_no TEXT NOT NULL DEFAULT '',   -- container number; airway bill or bill of lading number
  port_of_loading TEXT NOT NULL DEFAULT '', port_of_discharge TEXT NOT NULL DEFAULT '',
  eta BIGINT, etd BIGINT,
  customs_status TEXT NOT NULL DEFAULT 'not_started' CHECK (customs_status IN ('not_started','docs_ready','submitted','queried','held','cleared')),
  packages INTEGER CHECK (packages IS NULL OR packages >= 0), gross_weight_kg NUMERIC(10,3) CHECK (gross_weight_kg IS NULL OR gross_weight_kg >= 0),
  freight NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (freight >= 0), insurance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (insurance >= 0),
  duty_pct NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (duty_pct >= 0 AND duty_pct <= 500), vat_pct NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (vat_pct >= 0 AND vat_pct <= 100),
  agent_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (agent_fee >= 0), other_fees NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (other_fees >= 0),
  fx_rate NUMERIC(20,8),                                                  -- Naira per 1 unit of the currency when it was worked out (NULL when the currency is Naira)
  notes TEXT NOT NULL DEFAULT '',
  created BIGINT NOT NULL, created_by TEXT NOT NULL DEFAULT '', updated BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_ship_status ON trade_shipments(status, direction);

CREATE TABLE IF NOT EXISTS trade_items (
  id BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES trade_shipments(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  hs_code TEXT NOT NULL DEFAULT '', origin_country CHAR(2),
  qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 10000000),
  unit_value NUMERIC(14,4) NOT NULL CHECK (unit_value >= 0),             -- per unit, in the shipment currency
  weight_kg NUMERIC(10,3) CHECK (weight_kg IS NULL OR weight_kg >= 0),   -- net weight per unit
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trade_items_ship ON trade_items(shipment_id);

-- Document numbers we have issued. One per shipment and kind, so printing a document again always gives the same number and date.
CREATE TABLE IF NOT EXISTS trade_issued (
  id BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES trade_shipments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('commercial_invoice','packing_list','proforma','purchase_order','customs_sheet')),
  number TEXT NOT NULL UNIQUE, issued BIGINT NOT NULL, issued_by TEXT NOT NULL DEFAULT '',
  UNIQUE (shipment_id, kind)
);

-- Files attached to a shipment (bill of lading, certificates, permits, the forwarder's papers). Stored in Supabase Storage, private.
CREATE TABLE IF NOT EXISTS trade_files (
  id BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES trade_shipments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bill_of_lading','airway_bill','certificate','permit','invoice','packing_list','customs','insurance','other')),
  file_key TEXT NOT NULL, file_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0,
  created BIGINT NOT NULL, created_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_trade_files_ship ON trade_files(shipment_id);

CREATE TABLE IF NOT EXISTS trade_events (
  id BIGSERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES trade_shipments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', created BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_events_ship ON trade_events(shipment_id, id);

-- Reminders: what to check for a country pair. The admin edits these. They are reminders to verify, never legal advice.
-- from_country / to_country: a two-letter code or '*' for any. product_class: '' for every shipment, or a restricted class that must be among the items.
CREATE TABLE IF NOT EXISTS trade_rules (
  id BIGSERIAL PRIMARY KEY,
  from_country TEXT NOT NULL DEFAULT '*' CHECK (from_country = '*' OR from_country ~ '^[A-Z]{2}$'),
  to_country TEXT NOT NULL DEFAULT '*' CHECK (to_country = '*' OR to_country ~ '^[A-Z]{2}$'),
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('import','export','both')),
  product_class TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'permit' CHECK (category IN ('permit','licence','registration','banned','tax','document','other')),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0), detail TEXT NOT NULL DEFAULT '', authority TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, updated BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_rules_key ON trade_rules(from_country, to_country, direction, product_class, lower(title));

CREATE TABLE IF NOT EXISTS trade_checks (
  shipment_id BIGINT NOT NULL REFERENCES trade_shipments(id) ON DELETE CASCADE,
  rule_id BIGINT NOT NULL REFERENCES trade_rules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done','na')),
  note TEXT NOT NULL DEFAULT '', checked_by TEXT NOT NULL DEFAULT '', checked_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (shipment_id, rule_id)
);

-- Restricted items: words and HS code starts that block a dropship product or send it to a person for a compliance check before it can be listed.
CREATE TABLE IF NOT EXISTS restricted_classes (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,30}$'),
  label TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'review' CHECK (action IN ('block','review')),
  keywords TEXT NOT NULL DEFAULT '', hs_prefixes TEXT NOT NULL DEFAULT '',   -- comma separated
  note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, updated BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS restriction_class TEXT NOT NULL DEFAULT '';
ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS compliance_note TEXT NOT NULL DEFAULT '';
ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS compliance_by TEXT NOT NULL DEFAULT '';
ALTER TABLE dropship_products ADD COLUMN IF NOT EXISTS compliance_at BIGINT;

INSERT INTO restricted_classes (slug, label, action, keywords, hs_prefixes, note, updated) VALUES
 ('medicines', 'Medicines and medical products', 'block', 'medicine,medicines,drug,drugs,tablet,tablets,capsule,capsules,antibiotic,antibiotics,syrup,injection,vaccine,prescription,painkiller,paracetamol,ibuprofen,amoxicillin', '3001,3002,3003,3004,3005,3006', 'Medicines are sold only through the pharmacy, which stays behind PHARMACY_ENABLED. They are never dropshipped.', 0),
 ('weapons', 'Weapons and ammunition', 'block', 'gun,guns,firearm,firearms,rifle,pistol,revolver,ammunition,ammo,bullet,bullets,explosive,explosives,grenade,taser,stun gun,switchblade', '93', 'Weapons are never listed.', 0),
 ('food', 'Food, drink and supplements', 'review', 'food,snack,snacks,beverage,supplement,supplements,vitamin,vitamins,protein powder,spice,spices,sauce,tea,coffee,infant formula,baby formula', '16,17,18,19,20,21,22', 'Food and supplements usually need regulator registration and labelling checks before they can be sold.', 0),
 ('chemicals', 'Chemicals and hazardous liquids', 'review', 'chemical,chemicals,solvent,acid,bleach,pesticide,insecticide,herbicide,fertilizer,aerosol,flammable,paint thinner,adhesive remover', '28,29,38', 'Chemicals can need permits and special transport. A person checks first.', 0),
 ('batteries', 'Batteries and power banks', 'review', 'battery,batteries,lithium,li-ion,power bank,powerbank,lipo', '8506,8507', 'Lithium batteries have air-freight and shipping limits. A person checks first.', 0)
ON CONFLICT (slug) DO NOTHING;

-- Starting reminders. Placeholders to verify: confirm each one against the official source before relying on it.
INSERT INTO trade_rules (from_country, to_country, direction, product_class, category, title, detail, authority, required, sort, updated)
SELECT * FROM (VALUES
 ('*','*','both','','document','Commercial invoice and packing list agree with each other and with the goods','Values, quantities, weights, HS codes and the country of origin must match on every document.','',1,10,0),
 ('*','*','both','','other','HS code checked for each item','Duty and permits depend on the HS code. Ask the clearing agent to confirm it.','',1,20,0),
 ('*','*','both','','other','Incoterm agreed with the other party, and who pays freight, insurance and duty','',  '',1,30,0),
 ('*','*','both','','other','Import and export rules of the other country checked','Check the destination country import rules for these goods, and whether any licence, permit or label is needed.','',1,40,0),
 ('*','NG','import','','registration','Form M (import declaration) opened through an authorised dealer bank','Check whether Form M is needed for these goods, and that it is approved before the goods are shipped.','Nigeria Customs Service / your bank',1,10,0),
 ('*','NG','import','','banned','Goods are not on the current Nigerian import prohibition list','Check the latest list before ordering. Goods on it cannot be imported.','Nigeria Customs Service',1,20,0),
 ('*','NG','import','','permit','SON conformity (SONCAP) checked for regulated products','Check whether these goods are on the Standards Organisation of Nigeria regulated list and need a conformity certificate before shipping.','SON',1,30,0),
 ('*','NG','import','','permit','NAFDAC registration or permit checked for food, drinks, cosmetics, medical devices, chemicals','Check whether the goods need NAFDAC registration or an import permit.','NAFDAC',1,40,0),
 ('*','NG','import','','tax','Duty, VAT and levies estimated with the clearing agent','Use the landed-cost calculator and compare with the agent quote.','Nigeria Customs Service',1,50,0),
 ('NG','*','export','','registration','NEPC export registration is current','Check that your business is registered as an exporter with the Nigerian Export Promotion Council.','NEPC',1,10,0),
 ('NG','*','export','','registration','Form NXP opened through an authorised dealer bank for non-oil exports','Check that Form NXP is raised and processed before the goods leave Nigeria.','Your bank / CBN rules',1,20,0),
 ('NG','*','export','','permit','NAFDAC export permit or certificate checked for food, drugs or cosmetics','Check whether the goods need a NAFDAC certificate for export.','NAFDAC',1,30,0),
 ('NG','*','export','','banned','Goods are not on the current Nigerian export prohibition list','Check the latest list before shipping.','Nigeria Customs Service',1,40,0),
 ('NG','*','export','','document','Certificate of origin, if the buyer or their country asks for one','','',0,50,0),
 ('*','*','both','batteries','permit','Battery shipping rules checked (UN38.3 test summary, carrier limits)','Air carriers limit lithium batteries. Ask the forwarder before booking.','Carrier / forwarder',1,60,0),
 ('*','*','both','chemicals','document','Safety data sheet and dangerous-goods paperwork ready','Ask the forwarder whether these goods count as dangerous goods.','Carrier / forwarder',1,60,0),
 ('*','*','both','food','permit','Food labelling, shelf life and regulator approval checked','','',1,60,0)
) AS v(from_country, to_country, direction, product_class, category, title, detail, authority, required, sort, updated)
WHERE NOT EXISTS (SELECT 1 FROM trade_rules r WHERE r.from_country=v.from_country AND r.to_country=v.to_country AND r.direction=v.direction AND r.product_class=v.product_class AND lower(r.title)=lower(v.title));

ALTER TABLE trade_shipments ENABLE ROW LEVEL SECURITY; ALTER TABLE trade_items ENABLE ROW LEVEL SECURITY; ALTER TABLE trade_issued ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_files ENABLE ROW LEVEL SECURITY; ALTER TABLE trade_events ENABLE ROW LEVEL SECURITY; ALTER TABLE trade_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_checks ENABLE ROW LEVEL SECURITY; ALTER TABLE restricted_classes ENABLE ROW LEVEL SECURITY;
