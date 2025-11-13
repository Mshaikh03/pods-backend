-- 1) Basic indexes (keep even with FTS)
CREATE INDEX IF NOT EXISTS idx_podcasts_title ON podcasts(title);
CREATE INDEX IF NOT EXISTS idx_podcasts_author ON podcasts(itunesAuthor);
CREATE INDEX IF NOT EXISTS idx_podcasts_popularity ON podcasts(popularityScore);

-- 2) FTS virtual table
DROP TABLE IF EXISTS podcasts_fts;
CREATE VIRTUAL TABLE podcasts_fts USING fts5(
  title,
  description,
  itunesAuthor,
  content='podcasts',
  content_rowid='id',
  tokenize='porter'
);

-- 3) Seed FTS
INSERT INTO podcasts_fts(rowid, title, description, itunesAuthor)
SELECT id, title, description, itunesAuthor FROM podcasts;

-- 4) Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS podcasts_ai AFTER INSERT ON podcasts BEGIN
  INSERT INTO podcasts_fts(rowid, title, description, itunesAuthor)
  VALUES (new.id, new.title, new.description, new.itunesAuthor);
END;

CREATE TRIGGER IF NOT EXISTS podcasts_ad AFTER DELETE ON podcasts BEGIN
  INSERT INTO podcasts_fts(podcasts_fts, rowid, title, description, itunesAuthor)
  VALUES('delete', old.id, old.title, old.description, old.itunesAuthor);
END;

CREATE TRIGGER IF NOT EXISTS podcasts_au AFTER UPDATE ON podcasts BEGIN
  INSERT INTO podcasts_fts(podcasts_fts, rowid, title, description, itunesAuthor)
  VALUES('delete', old.id, old.title, old.description, old.itunesAuthor);
  INSERT INTO podcasts_fts(rowid, title, description, itunesAuthor)
  VALUES (new.id, new.title, new.description, new.itunesAuthor);
END;
