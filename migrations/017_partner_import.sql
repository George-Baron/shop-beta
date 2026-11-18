-- Partner stores can import and export their own catalogue; remember which store an import belonged to. Additive only.
ALTER TABLE catalog_imports ADD COLUMN vendor_id BIGINT REFERENCES vendors(id) ON DELETE SET NULL;
CREATE INDEX idx_catalog_imports_vendor ON catalog_imports(vendor_id, id DESC) WHERE vendor_id IS NOT NULL;
