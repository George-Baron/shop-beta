-- Security review: catalog_imports (import history, with product names and error details) was created without row level security.
-- Every other table has it, so the public (anon) database key reads nothing. The app connects with its own database role and is not affected.
ALTER TABLE catalog_imports ENABLE ROW LEVEL SECURITY;
