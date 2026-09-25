-- Sticker authorization and sticker history (ADR0018 P4g, §9.1/§9.3). Additive; historical
-- migrations stay frozen.
--
-- Two changes, both of which the sticker library needed before it could be used at all:
--
--   * WHICH collections a scheme authorizes. §9.1 says "方案授权其中任一集合即可候选", so the
--     relation is many-to-many and belongs in a join table rather than a column. Until this
--     existed, `resolveQqStickerLibrary` took the authorized collection ids as a caller input and
--     nothing in the project could produce them — a rule with no source of truth. The user chose
--     multi-select over a single column (2026-09-23).
--   * WHICH asset a sent sticker part was. §9.3's repetition rules are "历史按群独立", and the
--     send ledger recorded that a sticker went out without recording which one — so the per
--     conversation history those rules compare against could not be computed.
--
-- Neither table decides deletion policy on its own, but the foreign keys here ARE enforced: the
-- runtime (bun:sqlite) opens every connection with `foreign_keys = ON`, so a reference that names a
-- missing row is refused rather than being documentation. That is deliberate for both tables —
-- an authorization naming a collection that is not there would be a scheme whose stickers silently
-- disappear, and a ledger row naming an asset that is not there would put a sticker in a
-- conversation's history that the library never had.
--
-- The consequence for §9.1's undecided asset/collection deletion (U11) is that history blocks it
-- rather than being silently rewritten: an asset that was sent cannot be removed while the send
-- ledger still mentions it, and the ledger's own retention window (two weeks, qq-retention.ts) is
-- what eventually releases it. Since neither deletion path is implemented, nothing is blocked today;
-- the point is that whoever implements U11 has to answer the question instead of erasing the answer.

-- A scheme's authorized collections. The pair is the key: authorizing the same collection twice is
-- the same fact, and §9.1's "同一素材只算一个候选" depends on a set, not a list.
CREATE TABLE qq_scheme_sticker_collections (
  scheme_id TEXT NOT NULL REFERENCES qq_schemes(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES qq_sticker_collections(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (scheme_id, collection_id)
);
-- The reverse direction is what §9.2's "展示影响的方案和群" asks for: a collection is the unit of
-- authorization, so enabling an asset means asking which schemes authorize the collections it sits
-- in. Without this index that walk is a full scan of the authorization table.
CREATE INDEX ix_qq_scheme_sticker_collection ON qq_scheme_sticker_collections(collection_id);

-- Which asset a sticker part carried.
--
-- Nullable because the column is added to a table that may already hold sticker parts from before
-- this migration; those rows keep the weaker fact they really have ("a sticker went out") instead
-- of being given an invented id. The CHECK states the one direction that is always true and never
-- depends on backfill: a part that carries words can never name a sticker. It is written this way
-- round on purpose — the opposite direction (`sticker_id IS NOT NULL` for every sticker part) would
-- retroactively reject existing rows.
ALTER TABLE qq_send_part ADD COLUMN sticker_id TEXT REFERENCES qq_sticker_assets(id)
  CHECK (sticker_id IS NULL OR part_kind = 'sticker');
