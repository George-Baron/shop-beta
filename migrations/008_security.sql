-- Only one administrator account can exist (two setups at the same moment cannot both succeed).
-- If the shop later gets several staff accounts, replace this with a proper staff role and drop the index.
CREATE UNIQUE INDEX uq_single_admin ON users (role) WHERE role = 'admin';
