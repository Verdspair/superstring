import { Database } from "bun:sqlite";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import { openBusinessDb } from "../../src/server/db/schema-gate";

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
