# Product photos, import and export

## Photos
Product forms (admin and partner portal) have one photo area: drag and drop or click, previews, **Make main**, **Replace**, **Remove**, a progress bar per photo and plain error messages. Photos are shrunk in the browser first (longest side 1,600 px, WEBP, or JPEG where WEBP is unavailable), so phone photos of 5–20 MB upload fine. Accepted: JPG, JPEG, PNG, WEBP (and https links). Up to 8 per product. A broken image shows a placeholder. Storage is unchanged (Supabase bucket `product-images`).

## Import (Admin → Import & export, Partner portal → Import & export)
1. Pick **Create new** or **Update existing** and download the Excel or CSV template (it also lists your departments and categories).
2. Upload the file (.xlsx or .csv, up to 10,000 rows / 8 MB). Match columns (done automatically by name; editable).
3. Check: every row is validated and nothing is saved. Problems are listed per row; **Fix** edits a row in place and rechecks it. Warnings flag likely duplicates (same name and brand) with a "skip them" option.
4. Import: only rows without problems are saved, 200 rows at a time, each row on its own, and **re-validated on the server**. Download an error report (CSV) for the rest.

Rules: name and selling price required (create); Internal Reference or Barcode finds the product (update); empty cells never erase data; changes are shown from → to; duplicate reference/barcode are refused; categories and departments must already exist; pharmacy products cannot be imported; wholesale columns and the Partner column are admin-only; partner imports start as "pending review" (price and stock updates do not need review); products with sizes/colours do not take stock from an import; Tax is a note only. Cost price is private and never appears in the public shop.

## Export
Excel or CSV, filtered by status, category, brand, partner (admin), missing photos, low stock (stock ≤ minimum stock), or selected products (tick them on the Products page). Spreadsheet formulas in text are neutralised. Up to 20,000 rows per export. Imports and exports are listed under **History**.

Tests: `npm run test:catalog`.
