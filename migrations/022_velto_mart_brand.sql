-- Rebrand: Shop-Beta becomes VELTO-MART. Only rows still carrying the old default names are changed; anything the owner customised is left alone.
UPDATE settings SET value='VELTO-MART' WHERE key='store_name' AND value IN ('Shop-Beta','Shopbeta','Shop Beta');
UPDATE settings SET value='Shop Beyond Limits.' WHERE key='tagline' AND value='Everything you need, delivered across Nigeria';
UPDATE stores SET name=regexp_replace(name, '^Shop-Beta ', 'VELTO-MART ') WHERE name LIKE 'Shop-Beta %';
