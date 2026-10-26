import { Database } from "bun:sqlite";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { P5ConfigSchema } from "../../src/shared/contracts/models";

/**
 * A migrated in-memory image, cloned per case by `cloneBusinessDb`.
 *
 * Every QQ integration case needs a fully migrated database, and replaying the business
 * migration chain per case would dominate those files. Cloning the image of one migrated
 * database keeps the same schema, the same constraints and the same enforcement while skipping
 * the replay.
 *
 * `PRAGMA foreign_keys` is per CONNECTION and is NOT carried by the image, so it is re-applied
 * on every clone exactly as `connection.ts` does — the ordering guarantees in these tests rely
 * on it being ON.
 */
const migratedImage = (() => {
  const h = openBusinessDb();
  const image = h.db.serialize();
  h.close();
  return image;
})();

export function cloneBusinessDb(): BusinessDbHandle {
  const db = Database.deserialize(migratedImage);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return toOrmHandle(db);
}

/** Existing-runtime fixtures use the saved configuration predating creation-default changes. */
export function runtimeFixtureBusiness(
  handle: BusinessDbHandle = cloneBusinessDb(),
  model = "synthetic-model",
): BusinessDbHandle {
  const existing = handle.db.query("SELECT id FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID);
  if (!existing) {
    ensureDefaults(handle.orm, model);
    handle.db
      .query(
        "UPDATE agents SET temperature = 0.7, persona_intensity = 60, p5_config = ? WHERE id = ?",
      )
      .run(JSON.stringify(P5ConfigSchema.parse({})), DEFAULT_AGENT_ID);
  }
  return handle;
}
