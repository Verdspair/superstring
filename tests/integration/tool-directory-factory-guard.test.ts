import { expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

it("keeps directory inspection read-only in the full application factory", async () => {
  const business = openBusinessDb();
  try {
    ensureDefaults(business.orm, "synthetic-model");
    const app = createApp({ business });
    const before = business.db.query("SELECT count(*) AS n FROM agents").get();
    expect(
      (
        await app.request("http://127.0.0.1/v2/tools", {
          headers: { origin: "http://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("http://127.0.0.1/v2/tools/memory.query", { method: "DELETE" })).status,
    ).toBe(404);
    expect(business.db.query("SELECT count(*) AS n FROM agents").get()).toEqual(before);
  } finally {
    business.close();
  }
});
