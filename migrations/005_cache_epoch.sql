-- One counter that tells every instance "the catalogue or settings changed, drop your in-memory cache".
CREATE TABLE cache_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), epoch BIGINT NOT NULL DEFAULT 0);
INSERT INTO cache_epoch (id, epoch) VALUES (1, 0);
