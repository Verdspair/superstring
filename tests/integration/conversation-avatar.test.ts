import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import upstream from "omggif";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { BUSINESS_MIGRATION_FILES, openBusinessDb } from "../../src/server/db/schema-gate";
import {
  ConversationListSchema,
  ConversationSummarySchema,
} from "../../src/shared/contracts/conversation";
import {
  AVATAR_UPLOAD_MAX_BYTES,
  ConversationAvatarSchema,
} from "../../src/shared/contracts/conversation-avatar";

const handles: ReturnType<typeof openBusinessDb>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});
/** Windows can hold the SQLite -wal/-shm files for a moment after close(); retry briefly. */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
}
const generated = { kind: "generated", style: "rings", seed: "one shared identity" } as const;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvX8AAAAASUVORK5CYII=",
  "base64",
);
// A valid tiny GIF remains byte-identical; avatar storage does not flatten animation containers.
const gif = (() => {
  const bytes = new Uint8Array(4096);
  const writer = new upstream.GifWriter(bytes, 2, 2, { palette: [0xff0000, 0x00ff00], loop: 0 });
  writer.addFrame(0, 0, 2, 2, [0, 0, 0, 0], { delay: 10 });
  writer.addFrame(0, 0, 2, 2, [1, 1, 1, 1], { delay: 10 });
  return bytes.slice(0, writer.end());
})();
const appFor = (db: Database, includeShared = true) =>
  new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(db, { includeShared }));
function setup(filename?: string) {
  const h = openBusinessDb(filename ? { path: filename } : undefined);
  handles.push(h);
  const session = createSession(h.orm, "avatar scope", { modelName: "fixture" });
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureWeb(session.id);
  assert(conversation);
  return { ...h, app: appFor(h.db), journal, session, conversation };
}
const write = (app: Hono, id: string, value: unknown) =>
  app.request(`/v2/conversations/${id}/avatar`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
const upload = (
  app: Hono,
  id: string,
  bytes: Uint8Array,
  name = "arbitrary-name.txt",
  type = "text/plain",
) => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  return app.request(`/v2/conversations/${id}/avatar`, { method: "PUT", body: form });
};

describe("server-shared conversation avatars", () => {
  it("shares generated metadata through list/get, isolates conversations and resets without journal mutation", async () => {
    const h = setup();
    const other = h.journal.ensureWeb(createSession(h.orm, "other", { modelName: "fixture" }).id);
    assert(other);
    h.journal.append({
      conversationId: h.conversation.id,
      eventKey: "retained",
      kind: "inbound",
      source: { kind: "fixture", id: "source", revision: "1" },
      occurredAt: nowIso(),
    });
    const before = h.db
      .query("SELECT id,binding_epoch,consumed_seq,next_seq FROM conversations ORDER BY id")
      .all();
    const events = h.db.query("SELECT * FROM conversation_events").all();
    expect(await (await write(h.app, h.conversation.id, generated)).json()).toEqual(generated);
    const summary = ConversationSummarySchema.parse(
      await (await h.app.request(`/v2/conversations/${h.conversation.id}`)).json(),
    );
    expect(summary.avatar).toEqual(generated);
    const list = ConversationListSchema.parse(
      await (await h.app.request("/v2/conversations")).json(),
    );
    expect(list.items.find((c) => c.id === other.id)?.avatar).toBeNull();
    expect(list.items.find((c) => c.id === summary.id)?.avatar).toEqual(generated);
    expect(await (await write(h.app, summary.id, null)).json()).toBeNull();
    // List discovery may refresh activity from the same source, but avatar writes do not.
    expect(h.db.query("SELECT * FROM conversation_events").all()).toEqual(events);
    expect(
      h.db
        .query("SELECT id,binding_epoch,consumed_seq,next_seq FROM conversations ORDER BY id")
        .all(),
    ).toEqual(before);
    expect(h.db.query("SELECT COUNT(*) AS n FROM conversation_avatars").get()).toEqual({ n: 0 });
  });

  it("persists uploaded bytes across close/reopen, sniffs actual MIME and invalidates replaced URLs", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "conversation-avatar-"));
    dirs.push(directory);
    const filename = path.join(directory, "business.sqlite");
    const h = setup(filename);
    const value = ConversationAvatarSchema.parse(
      await (await upload(h.app, h.conversation.id, png)).json(),
    );
    expect(value?.kind).toBe("uploaded");
    if (value?.kind !== "uploaded") throw Error("fixture");
    const fetched = await h.app.request(value.url);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(fetched.headers.get("cache-control")).toContain("no-store");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(new Uint8Array(png));
    // Close the actual database handle once, then use a separate app/repository instance.
    const original = handles.find((item) => item.db === h.db);
    if (original) {
      handles.splice(handles.indexOf(original), 1);
      original.close();
    } else h.close();
    const reopened = openBusinessDb({ path: filename });
    handles.push(reopened);
    const app = appFor(reopened.db);
    expect(new Uint8Array(await (await app.request(value.url)).arrayBuffer())).toEqual(
      new Uint8Array(png),
    );
    expect(new upstream.GifReader(gif).numFrames()).toBe(2);
    const next = ConversationAvatarSchema.parse(
      await (await upload(app, h.conversation.id, gif, "animation.gif")).json(),
    );
    if (next?.kind !== "uploaded") throw Error("fixture");
    expect((await app.request(value.url)).status).toBe(404);
    expect(new Uint8Array(await (await app.request(next.url)).arrayBuffer())).toEqual(
      new Uint8Array(gif),
    );
    await write(app, h.conversation.id, generated);
    expect((await app.request(next.url)).status).toBe(404);
    expect(reopened.db.query("SELECT image_bytes FROM conversation_avatars").get()).toEqual({
      image_bytes: null,
    });
  });

  it("rejects malformed/oversized/active-content images and unknown styles without replacing the value", async () => {
    const h = setup();
    await write(h.app, h.conversation.id, generated);
    for (const value of [
      { ...generated, style: "untrusted" },
      { ...generated, seed: "" },
      { kind: "uploaded", url: "https://outside.example/image" },
    ])
      expect((await write(h.app, h.conversation.id, value)).status).toBe(422);
    for (const bytes of [
      new Uint8Array(),
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      Buffer.from("not an image"),
      new Uint8Array(AVATAR_UPLOAD_MAX_BYTES + 1),
    ])
      expect((await upload(h.app, h.conversation.id, bytes)).status).toBe(422);
    const hugeDimension = Buffer.from(png);
    hugeDimension.writeUInt32BE(9000, 16);
    expect((await upload(h.app, h.conversation.id, hugeDimension)).status).toBe(422);
    expect(
      (await (await h.app.request(`/v2/conversations/${h.conversation.id}`)).json()).avatar,
    ).toEqual(generated);
  });

  it("restores A's avatar on A→B→A, rejects retired binding reads/writes, and aliases new activation IDs to the stable anchor", async () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "avatar fixture" });
    const bindingId = crypto.randomUUID(),
      bId = crypto.randomUUID();
    const agent = h.orm.select().from(schema.agents).get();
    assert(agent);
    h.orm
      .insert(schema.agents)
      .values({ ...agent, id: bId })
      .run();
    h.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "100",
        conversationKind: "group",
        peerId: "200",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const bind = (agent: string) => {
      h.db.query("UPDATE qq_bindings SET agent_id=? WHERE id=?").run(agent, bindingId);
      const conversation = h.journal.ensureOneBot(bindingId);
      assert(conversation);
      return conversation;
    };
    const a = bind(DEFAULT_AGENT_ID);
    const image = ConversationAvatarSchema.parse(await (await upload(h.app, a.id, png)).json());
    if (image?.kind !== "uploaded") throw Error("fixture");
    const b = bind(bId);
    expect((await h.app.request(image.url)).status).toBe(404);
    expect((await write(h.app, a.id, generated)).status).toBe(404);
    expect((await (await h.app.request(`/v2/conversations/${b.id}`)).json()).avatar).toBeNull();
    await write(h.app, b.id, generated);
    const a2 = bind(DEFAULT_AGENT_ID);
    expect(a2.id).not.toBe(a.id);
    expect((await (await h.app.request(`/v2/conversations/${a2.id}`)).json()).avatar).toEqual(
      image,
    );
    expect((await h.app.request(image.url)).status).toBe(200);
    expect(await (await write(h.app, a2.id, generated)).json()).toEqual(generated);
    expect(
      h.db.query("SELECT conversation_id FROM conversation_avatars ORDER BY conversation_id").all(),
    ).toEqual(
      [{ conversation_id: a.id }, { conversation_id: b.id }].sort((a, b) =>
        a.conversation_id.localeCompare(b.conversation_id),
      ),
    );
    h.db.query("DELETE FROM qq_bindings WHERE id=?").run(bindingId);
    expect(h.db.query("SELECT COUNT(*) AS n FROM conversation_avatars").get()).toEqual({ n: 0 });
    expect(h.journal.row(a.id)).not.toBeNull();
  });

  it("enforces owner visibility and cascades source deletion without touching another conversation", async () => {
    const h = setup();
    const value = ConversationAvatarSchema.parse(
      await (await upload(h.app, h.conversation.id, png)).json(),
    );
    if (value?.kind !== "uploaded") throw Error("fixture");
    h.db.query("INSERT INTO users(id,name,created_at) VALUES('other','other',?)").run(nowIso());
    h.db.query("UPDATE conversations SET user_id='other' WHERE id=?").run(h.conversation.id);
    expect((await h.app.request(value.url)).status).toBe(404);
    expect((await write(h.app, h.conversation.id, generated)).status).toBe(404);
    h.db
      .query("UPDATE conversations SET user_id=? WHERE id=?")
      .run(DEFAULT_USER_ID, h.conversation.id);
    const other = h.journal.ensureWeb(
      createSession(h.orm, "retained", { modelName: "fixture" }).id,
    );
    assert(other);
    await write(h.app, other.id, generated);
    h.db.query("DELETE FROM sessions WHERE id=?").run(h.session.id);
    expect((await h.app.request(value.url)).status).toBe(404);
    expect(h.db.query("SELECT conversation_id FROM conversation_avatars").all()).toEqual([
      { conversation_id: other.id },
    ]);
  });

  it("upgrades an existing v43 database without changing existing conversation rows", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "conversation-avatar-upgrade-"));
    dirs.push(directory);
    const filename = path.join(directory, "business.sqlite");
    const old = new Database(filename);
    for (const file of BUSINESS_MIGRATION_FILES.slice(0, 43))
      old.exec(readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"));
    old.exec("PRAGMA user_version=43");
    const oldOrm = drizzle(old, { schema });
    const oldSession = createSession(oldOrm, "preserved before avatar migration", {
      modelName: "fixture",
    });
    new ConversationEventRepository(old).ensureWeb(oldSession.id);
    const prior = old.query("SELECT * FROM conversations").all();
    old.close();
    const h = openBusinessDb({ path: filename });
    handles.push(h);
    expect(h.db.query("PRAGMA user_version").get()).toEqual({ user_version: 47 });
    expect(h.db.query("SELECT * FROM conversations").all()).toEqual(prior);
    expect(h.db.query("SELECT COUNT(*) AS n FROM conversation_avatars").get()).toEqual({ n: 0 });
  });
});
