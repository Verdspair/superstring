import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createQqScheme,
  readQqScheme,
  schemeAllocation,
  schemeContext,
  schemeMediaInput,
  schemeOutputReserve,
  schemePrompts,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { qqSchemes } from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { QQ_ALLOCATION_DEFAULT } from "../../src/shared/contracts/context-allocation";
import {
  newQqSchemeDefaults,
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
} from "../../src/shared/contracts/qq";

describe("new QQ scheme defaults", () => {
  it("persists the approved creation groups without persona or resource identities", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic");
      const d = newQqSchemeDefaults();
      const row = createQqScheme(h.orm, { name: "new synthetic scheme" });
      expect(schemeRhythm(row)).toEqual(d.rhythm);
      expect(schemeContext(row)).toEqual(d.context);
      expect(schemeOutputReserve(row)).toEqual({
        judgement_output_reserved: 32768,
        reply_output_reserved: 32768,
      });
      expect(schemeAllocation(row)).toEqual({
        judgement: { mode: "auto" },
        reply: { mode: "auto" },
      });
      expect(schemeMediaInput(row)).toEqual(d.mediaInput);
      expect(schemePrompts(row)).toEqual(QQ_PROMPT_DEFAULTS);
      expect(d.taskLimits).toEqual({ mention_task_limit: 5, ordinary_task_limit: 5 });
      expect(row.mentionTaskLimit).toBe(5);
      expect(row.ordinaryTaskLimit).toBe(5);
      expect(row.revision).toBe(1);
      expect(row.judgementMessageLimit).toBe(400);
      expect(row.replyMessageLimit).toBe(300);
      expect(JSON.stringify(d)).not.toMatch(/prompt|agentId|accountId|peerId|collection_ids/);
      const copy = newQqSchemeDefaults();
      copy.mediaInput.stages.generation = true;
      expect(newQqSchemeDefaults().mediaInput.stages.generation).toBe(false);
    } finally {
      h.close();
    }
  });
  it("keeps explicit creation groups and existing stored values on unrelated saves", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic");
      const d = newQqSchemeDefaults();
      const custom = { ...d.rhythm, merge_window_seconds: 7 };
      const row = createQqScheme(h.orm, {
        name: "explicit synthetic scheme",
        rhythm: custom,
        allocation: QQ_ALLOCATION_DEFAULT,
        outputReserve: QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
      });
      expect(schemeRhythm(row).merge_window_seconds).toBe(7);
      expect(schemeAllocation(row)).toEqual(QQ_ALLOCATION_DEFAULT);
      expect(schemeOutputReserve(row)).toEqual(QQ_MODEL_OUTPUT_RESERVE_DEFAULT);
      const old = h.orm.select().from(qqSchemes).where(eq(qqSchemes.id, row.id)).get();
      expect(old).toBeDefined();
      const saved = updateQqScheme(h.orm, row.id, {
        name: row.name,
        description: "changed",
        expectedRevision: row.revision,
      });
      expect(schemeRhythm(saved)).toEqual(custom);
      expect(schemeAllocation(saved)).toEqual(QQ_ALLOCATION_DEFAULT);
      expect(schemeOutputReserve(saved)).toEqual(QQ_MODEL_OUTPUT_RESERVE_DEFAULT);
      expect(readQqScheme(h.orm, row.id)?.revision).toBe(row.revision + 1);
    } finally {
      h.close();
    }
  });
});
