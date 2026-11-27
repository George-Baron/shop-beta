-- Who opened a return (the customer, or a staff member on the customer's behalf), and the Operations Manager role.
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS opened_by TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS opened_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS opened_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS open_note TEXT NOT NULL DEFAULT '';
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS past_window SMALLINT NOT NULL DEFAULT 0;

-- Built-in role. seedRoles() only runs on an empty table (and already includes this role), so existing shops get it here; a brand-new database is left to seedRoles. Safe to re-run.
INSERT INTO staff_roles (name, description, perms, builtin, created)
SELECT 'Operations Manager', 'Runs returns and day-to-day operations: opens and reviews returns for customers, manages orders, delivery and customers. The owner gives the final approval on refunds.',
 '["orders:view","orders:edit","customers:view","customers:edit","delivery:view","delivery:edit","catalog:view","partners:view","wholesale:view","rfq:view","warehouse:view","finance:view","reports:view"]',
 1, EXTRACT(EPOCH FROM now())::bigint
WHERE EXISTS (SELECT 1 FROM staff_roles)
ON CONFLICT (name) DO NOTHING;
