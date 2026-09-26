-- Presentation belongs to the stable history anchor, never to an execution epoch.
-- Storing the small original image in the same row makes replace/reset atomic.
CREATE TABLE conversation_avatars (
  conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('generated','uploaded')),
  style TEXT,
  seed TEXT,
  image_bytes BLOB,
  media_type TEXT,
  width INTEGER,
  height INTEGER,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind='generated' AND style IS NOT NULL AND seed IS NOT NULL AND image_bytes IS NULL
      AND media_type IS NULL AND width IS NULL AND height IS NULL)
    OR (kind='uploaded' AND style IS NULL AND seed IS NULL AND image_bytes IS NOT NULL
      AND media_type IS NOT NULL AND width>0 AND height>0)
  )
);

-- Unbinding removes presentation bytes without deleting retained chat history.
CREATE TRIGGER delete_unbound_conversation_avatar AFTER DELETE ON qq_bindings BEGIN
  DELETE FROM conversation_avatars WHERE conversation_id IN (
    SELECT id FROM conversations WHERE channel='onebot11' AND source_id=OLD.id
  );
END;
