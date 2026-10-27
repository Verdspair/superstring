import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  schemeResponse,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { BUSINESS_MIGRATION_FILES, ensureBusinessSchema } from "../../src/server/db/schema-gate";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QqSchemeRhythmSchema } from "../../src/shared/contracts/qq";
import { QqTaskExecutionSnapshotSchema } from "../../src/shared/contracts/qq-task";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
function setup() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "timing-config-model");
  return h;
}

describe("participation timing configuration", () => {
  it("upgrades a schema-66 scheme without changing its saved timing or revision", () => {
    const db = new Database(":memory:");
    try {
      for (const file of BUSINESS_MIGRATION_FILES.slice(0, 66)) {
        db.exec(
          readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
        );
      }
      db.exec("PRAGMA user_version=66");
      db.query(
        "INSERT INTO qq_schemes(id,name,revision,created_at,updated_at,merge_window_seconds,initiative_time_target_seconds,initiative_time_jitter_seconds) VALUES('old','saved',7,'then','then',15,120,100)",
      ).run();
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 75 });
      expect(
        db
          .query(
            "SELECT participation_timing,revision,merge_window_seconds,initiative_time_target_seconds,initiative_time_jitter_seconds FROM qq_schemes WHERE id='old'",
          )
          .get(),
      ).toEqual({
        participation_timing: "resource_window",
        revision: 7,
        merge_window_seconds: 15,
        initiative_time_target_seconds: 120,
        initiative_time_jitter_seconds: 100,
      });
      expect(() =>
        db.query("UPDATE qq_schemes SET participation_timing='invalid' WHERE id='old'").run(),
      ).toThrow();
      ensureBusinessSchema(db);
      expect(
        db.query("SELECT revision,participation_timing FROM qq_schemes WHERE id='old'").get(),
      ).toEqual({ revision: 7, participation_timing: "resource_window" });
    } finally {
      db.close();
    }
  });

  it("creates quiet-preferred schemes and saves either mode with compare-and-swap", () => {
    const h = setup();
    const created = createQqScheme(h.orm, { name: "new" });
    expect(schemeRhythm(created).participation_timing).toBe("quiet_preferred");
    const updated = updateQqScheme(h.orm, created.id, {
      name: created.name,
      expectedRevision: created.revision,
      rhythm: { ...schemeRhythm(created), participation_timing: "resource_window" },
    });
    expect(schemeRhythm(updated).participation_timing).toBe("resource_window");
    expect(updated.revision).toBe(created.revision + 1);
    const same = updateQqScheme(h.orm, updated.id, {
      name: updated.name,
      expectedRevision: updated.revision,
      rhythm: schemeRhythm(updated),
    });
    expect(same.revision).toBe(updated.revision);
    expect(() =>
      updateQqScheme(h.orm, updated.id, {
        name: updated.name,
        expectedRevision: created.revision,
        rhythm: schemeRhythm(updated),
      }),
    ).toThrow();
    expect(
      QqSchemeRhythmSchema.safeParse({ ...schemeRhythm(updated), participation_timing: "invalid" })
        .success,
    ).toBe(false);
  });

  it("inherits a scheme mode and saves a sparse group override without changing other values", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "group" });
    const seed = createQqBinding({
      id: crypto.randomUUID(),
      accountId: "10001",
      kind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      paused: false,
      shareWebMemory: false,
    });
    if (seed.kind !== "saved") throw new Error("BINDING_SEED_FAILED");
    insertQqBinding(h.orm, seed.binding);
    const before = readQqGroupConfig(h.orm, seed.binding.id);
    expect(before.effective_scheme.rhythm.participation_timing).toBe("quiet_preferred");
    const save = (current: typeof before, overrides: unknown) =>
      updateQqGroupConfig(h.orm, {
        bindingId: seed.binding.id,
        payload: {
          agent_id: DEFAULT_AGENT_ID,
          expected_binding_revision: current.binding.revision,
          expected_scheme_revision: current.base_scheme.revision,
          expected_revision: current.revision,
          overrides,
          disabled_capabilities: [],
        } as Parameters<typeof updateQqGroupConfig>[1]["payload"],
      });
    const custom = save(before, { rhythm: { participation_timing: "resource_window" } });
    expect(custom.overrides).toEqual({ rhythm: { participation_timing: "resource_window" } });
    expect(custom.effective_scheme.rhythm).toEqual({
      ...before.effective_scheme.rhythm,
      participation_timing: "resource_window",
    });
    const same = save(custom, custom.overrides);
    expect(same.revision).toBe(custom.revision);
    expect(() => save(before, {})).toThrow();
    const followed = save(same, {});
    expect(followed.effective_scheme.rhythm).toEqual(before.effective_scheme.rhythm);
  });

  it("reads an older frozen scheme with the original resource-window behavior", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "snapshot" });
    const response = schemeResponse(h.orm, scheme);
    const { participation_timing: _mode, ...oldRhythm } = response.rhythm;
    const snapshot = QqTaskExecutionSnapshotSchema.parse({
      accountId: "10001",
      conversationId: crypto.randomUUID(),
      bindingId: crypto.randomUUID(),
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      bindingRevision: 1,
      authorityRevision: 1,
      schemeRevision: scheme.revision,
      schemeConfig: { ...response, rhythm: oldRhythm },
      agentConfigVersion: 1,
      taskClass: "mention",
      cause: "direct_reply",
      stickerFrequency: "high",
      sourceFromSeq: 1,
      sourceThroughSeq: 1,
      sourceExpiresAt: null,
      taskKey: "snapshot-key",
      authorizedTargets: ["20002"],
      targetParticipants: [{ targetId: "20002", speakerId: "20002" }],
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      mentionTaskLimit: 4,
      ordinaryTaskLimit: 1,
    });
    expect(snapshot.schemeConfig?.rhythm.participation_timing).toBe("resource_window");
    expect(snapshot.schemeConfig?.rhythm.merge_window_seconds).toBe(
      response.rhythm.merge_window_seconds,
    );
  });
});
