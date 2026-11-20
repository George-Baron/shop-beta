-- Global Trade phase 6: customs declarations, generated documents, receiving imported stock, landed cost.
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS entry_number TEXT NOT NULL DEFAULT '';   -- number given by customs / the broker when filed outside this system
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS submitted_at BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cd_export ON customs_declarations(export_order_id) WHERE export_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cd_import ON customs_declarations(import_shipment_id) WHERE import_shipment_id IS NOT NULL;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS grn_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS landed_run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS landed_total_ngn NUMERIC(18,2);
ALTER TABLE import_shipment_items ADD COLUMN IF NOT EXISTS qty_sellable INTEGER;
-- Inventory valuation for imported goods: weighted-average landed cost per product (NGN). One row per product.
CREATE TABLE IF NOT EXISTS trade_product_costs (
  product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, avg_cost_ngn NUMERIC(18,4) NOT NULL, last_landed_ngn NUMERIC(18,4) NOT NULL, qty_basis INTEGER NOT NULL DEFAULT 0,
  last_shipment_id BIGINT REFERENCES import_shipments(id) ON DELETE SET NULL, updated BIGINT NOT NULL
);
ALTER TABLE trade_product_costs ENABLE ROW LEVEL SECURITY;
