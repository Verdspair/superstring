-- Derived lookup only. memory_entries folded_search remains authoritative.
CREATE TABLE memory_search_index_ids (
  index_id INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE REFERENCES memory_entries(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE memory_search_fts USING fts5(
  f0, f1, f2, f3, f4,
  tokenize = 'trigram case_sensitive 1',
  content = '', contentless_delete = 1
);

CREATE INDEX ix_memory_search_invalid_layout ON memory_entries(id)
WHERE folded_search IS NULL OR fold_version IS NULL OR fold_version <> 1 OR CASE WHEN json_valid(folded_search) THEN json_type(folded_search) <> 'array' OR json_array_length(folded_search) <> 5 OR coalesce(json_type(folded_search, '$[0]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[1]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[2]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[3]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[4]'), 'missing') <> 'text' ELSE 1 END;

INSERT INTO memory_search_index_ids(memory_id) SELECT id FROM memory_entries;
INSERT INTO memory_search_fts(rowid, f0, f1, f2, f3, f4)
SELECT m.index_id, json_extract(e.folded_search, '$[0]'), json_extract(e.folded_search, '$[1]'), json_extract(e.folded_search, '$[2]'), json_extract(e.folded_search, '$[3]'), json_extract(e.folded_search, '$[4]')
FROM memory_entries e JOIN memory_search_index_ids m ON m.memory_id = e.id
WHERE NOT (folded_search IS NULL OR fold_version IS NULL OR fold_version <> 1 OR CASE WHEN json_valid(folded_search) THEN json_type(folded_search) <> 'array' OR json_array_length(folded_search) <> 5 OR coalesce(json_type(folded_search, '$[0]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[1]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[2]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[3]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[4]'), 'missing') <> 'text' ELSE 1 END);

CREATE TRIGGER memory_search_index_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_search_index_ids(memory_id) VALUES (new.id);
  INSERT INTO memory_search_fts(rowid, f0, f1, f2, f3, f4)
  SELECT m.index_id, json_extract(e.folded_search, '$[0]'), json_extract(e.folded_search, '$[1]'), json_extract(e.folded_search, '$[2]'), json_extract(e.folded_search, '$[3]'), json_extract(e.folded_search, '$[4]')
  FROM memory_entries e JOIN memory_search_index_ids m ON m.memory_id = e.id
  WHERE e.id = new.id AND NOT (folded_search IS NULL OR fold_version IS NULL OR fold_version <> 1 OR CASE WHEN json_valid(folded_search) THEN json_type(folded_search) <> 'array' OR json_array_length(folded_search) <> 5 OR coalesce(json_type(folded_search, '$[0]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[1]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[2]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[3]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[4]'), 'missing') <> 'text' ELSE 1 END);
END;

CREATE TRIGGER memory_search_index_update AFTER UPDATE OF folded_search, fold_version ON memory_entries BEGIN
  DELETE FROM memory_search_fts WHERE rowid = (SELECT index_id FROM memory_search_index_ids WHERE memory_id = old.id);
  INSERT OR IGNORE INTO memory_search_index_ids(memory_id) VALUES (new.id);
  INSERT INTO memory_search_fts(rowid, f0, f1, f2, f3, f4)
  SELECT m.index_id, json_extract(e.folded_search, '$[0]'), json_extract(e.folded_search, '$[1]'), json_extract(e.folded_search, '$[2]'), json_extract(e.folded_search, '$[3]'), json_extract(e.folded_search, '$[4]')
  FROM memory_entries e JOIN memory_search_index_ids m ON m.memory_id = e.id
  WHERE e.id = new.id AND NOT (folded_search IS NULL OR fold_version IS NULL OR fold_version <> 1 OR CASE WHEN json_valid(folded_search) THEN json_type(folded_search) <> 'array' OR json_array_length(folded_search) <> 5 OR coalesce(json_type(folded_search, '$[0]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[1]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[2]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[3]'), 'missing') <> 'text' OR coalesce(json_type(folded_search, '$[4]'), 'missing') <> 'text' ELSE 1 END);
END;

CREATE TRIGGER memory_search_index_delete BEFORE DELETE ON memory_entries BEGIN
  DELETE FROM memory_search_fts WHERE rowid = (SELECT index_id FROM memory_search_index_ids WHERE memory_id = old.id);
  DELETE FROM memory_search_index_ids WHERE memory_id = old.id;
END;
