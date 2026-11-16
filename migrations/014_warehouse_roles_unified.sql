-- Warehouse staff now use the shared Employees & roles system (module "warehouse"), so the separate role table is no longer used.
-- It is dropped only when empty; if anyone was given a role in it, it is kept so nothing is lost silently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM wholesale_user_roles) THEN DROP TABLE wholesale_user_roles; END IF;
END $$;
