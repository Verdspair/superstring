-- Sticker library storage (ADR0018 P4e, §9.1/§9.2). Additive; historical migrations stay frozen.
--
-- Three tables rather than one, because the plan treats them as three separable things:
--   * a COLLECTION is what a scheme authorizes (§9.1 "方案授权其中任一集合即可候选");
--   * an ASSET is the file plus its shared description, and §9.1 lets one asset sit in
--     several collections without duplicating the file or the description;
--   * MEMBERSHIP is the join, so "移出集合只移除该归类" is a row deletion and never touches
--     the asset itself.
--
-- Two facts are load-bearing in the DDL rather than in application code:
--   * `enabled` defaults to 0, because §9.1's lifecycle is 导入 → 保存副本 → 默认停用 →
--     用户审核 → 用户启用. A default of 1 would make every import immediately selectable,
--     which is the opposite of what the plan decided;
--   * membership is keyed by (collection_id, asset_id), which is what stops the same asset
--     from being counted twice inside one collection — the other half of "同一素材去重".
--
-- §9.1 leaves asset deletion, duplicate-file import, file replacement, collection deletion and
-- orphan handling undecided and says not to add automatic deletion by default. So this
-- migration has no trigger, no cascade that reaches an asset row, and no `deleted_at`: nothing
-- here can delete a copy as a side effect of something else. Membership rows do cascade with
-- their collection because a membership is not the asset — but collection deletion is not
-- implemented either, so that path is currently unreachable.
CREATE TABLE qq_sticker_collections (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  CHECK (description IS NULL OR length(description) <= 2000),
  CHECK (revision >= 1)
);
CREATE UNIQUE INDEX uq_qq_sticker_collection_name ON qq_sticker_collections(name);

CREATE TABLE qq_sticker_assets (
  id TEXT NOT NULL PRIMARY KEY,
  -- Defaults to the original file name and stays editable (§9.2).
  name TEXT NOT NULL,
  -- The shared content description; edited by the user, optionally seeded by a model draft.
  description TEXT,
  -- The model-assisted draft of §9.2, kept apart from `description` so an unreviewed draft can
  -- never be read as if the user had approved it ("模型只生成草稿，用户修改/审核后保存").
  description_draft TEXT,
  -- JSON array of tag strings; NULL means no tags rather than an empty list.
  tags TEXT,
  usage_note TEXT,
  -- The app-internal copy: a generated file name inside the sticker directory, never a path.
  -- Storing a bare name is what keeps the copy relocatable when the app's layout changes.
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  -- §9.1: an import saves a copy and leaves it DISABLED until the user enables it.
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  CHECK (description IS NULL OR length(description) <= 2000),
  CHECK (description_draft IS NULL OR length(description_draft) <= 2000),
  CHECK (usage_note IS NULL OR length(usage_note) <= 2000),
  CHECK (length(file_name) > 0 AND length(file_name) <= 120),
  CHECK (media_type IN ('image', 'animation')),
  CHECK (byte_size > 0),
  CHECK (width IS NULL OR width > 0),
  CHECK (height IS NULL OR height > 0),
  -- A size with only one dimension is a half-read header; refuse it rather than showing
  -- "400 × ?" in a management surface.
  CHECK ((width IS NULL) = (height IS NULL)),
  CHECK (enabled IN (0, 1))
);

CREATE TABLE qq_sticker_collection_items (
  collection_id TEXT NOT NULL REFERENCES qq_sticker_collections(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES qq_sticker_assets(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, asset_id)
);
CREATE INDEX ix_qq_sticker_item_asset ON qq_sticker_collection_items(asset_id);
