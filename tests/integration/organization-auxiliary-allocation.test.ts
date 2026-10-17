// 统一上下文分配（0068 批次）：组织设置全局辅助任务分配的持久化红绿测试。
//
// 只用既有公开入口（PUT /organization/settings、readOrganizationSettings、原始 SQL 列读）
// 做行为判据：不 import 新模块、不用本地绝对路径。列（0068）已由 Root 的迁移就绪；
// 首批用例在仓储尚未写辅助列时为 RED（保存被静默丢弃）。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { GlobalAuxiliaryAllocation } from "../../src/shared/contracts/context-allocation";

let h: BusinessDbHandle;
beforeEach(() => {
  h = openBusinessDb();
  ensureDefaults(h.orm, "chat-model");
});
afterEach(() => h.close());

const makeApp = () => createApp({ business: h });
const put = (body: unknown) =>
  makeApp().request("/organization/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = () => makeApp().request("/organization/settings");
const storedColumn = (): string | null =>
  (
    h.db.query("SELECT auxiliary_allocation FROM organization_settings WHERE id = 1").get() as {
      auxiliary_allocation: string | null;
    }
  ).auxiliary_allocation;
const revision = () => readOrganizationSettings(h.orm).revision;

describe("organization auxiliary allocation persistence (0068)", () => {
  it("fresh row has no auxiliary_allocation on the wire and nothing in the column", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("auxiliary_allocation" in body).toBe(false);
    expect(storedColumn()).toBeNull();
    expect(body).toEqual({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      revision: 1,
    });
  });

  it("persists an allocation-only PUT and preserves all three models", async () => {
    // 先用既有入口设默认模型，再做只带分配的部分补丁。
    const r1 = await put({ model_name: "helper", expected_revision: 1 });
    expect(r1.status).toBe(200);
    const aux: GlobalAuxiliaryAllocation = {
      knowledge_organize: { mode: "auto", input_limit: 4096, output_reserved: null },
      qq_sticker_annotate: { mode: "fixed" },
    };
    const current = (await (await get()).json()) as { revision: number };
    const r2 = await put({ auxiliary_allocation: aux, expected_revision: current.revision });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as Record<string, unknown>;
    expect(body.model_name).toBe("helper");
    expect(body.vision_model_name).toBeNull();
    expect(body.transcription_model_name).toBeNull();
    expect(body.auxiliary_allocation).toEqual(aux);
    expect(body.revision).toBe(current.revision + 1);
    expect(JSON.parse(storedColumn() ?? "null")).toEqual(aux);
    // 再读一致：数据库是唯一真源。
    expect(readOrganizationSettings(h.orm).auxiliary_allocation).toEqual(aux);
  });

  it("an identical allocation PUT is a no-op and does not bump the revision", async () => {
    const aux: GlobalAuxiliaryAllocation = {
      knowledge_organize: { mode: "fixed", output_reserved: 512 },
    };
    const first = (await (
      await put({ auxiliary_allocation: aux, expected_revision: 1 })
    ).json()) as {
      revision: number;
    };
    const before = revision();
    const again = await put({ auxiliary_allocation: aux, expected_revision: first.revision });
    expect(again.status).toBe(200);
    expect(revision()).toBe(before);
    expect(storedColumn()).toBe(JSON.stringify(aux));
  });

  it("replaces the whole role map and honours the existing revision CAS", async () => {
    const first = (await (
      await put({
        auxiliary_allocation: { knowledge_organize: { mode: "fixed" } },
        expected_revision: 1,
      })
    ).json()) as { revision: number };
    const stale = await put({
      auxiliary_allocation: { qq_media_describe: { mode: "auto" } },
      expected_revision: 1,
    });
    expect(stale.status).toBe(409);
    const replaced = (await (
      await put({
        auxiliary_allocation: { qq_media_describe: { mode: "auto" } },
        expected_revision: first.revision,
      })
    ).json()) as Record<string, unknown>;
    expect(replaced.auxiliary_allocation).toEqual({ qq_media_describe: { mode: "auto" } });
    expect(replaced.revision).toBe(first.revision + 1);
  });

  it("clears the role map with an empty object and keeps the models untouched", async () => {
    const first = (await (
      await put({
        model_name: "helper",
        vision_model_name: "eyes",
        transcription_model_name: "ears",
        auxiliary_allocation: { knowledge_organize: { mode: "fixed", input_limit: 100 } },
        expected_revision: 1,
      })
    ).json()) as { revision: number };
    const cleared = (await (
      await put({ auxiliary_allocation: {}, expected_revision: first.revision })
    ).json()) as Record<string, unknown>;
    expect(cleared.auxiliary_allocation).toEqual({});
    expect(cleared.model_name).toBe("helper");
    expect(cleared.vision_model_name).toBe("eyes");
    expect(cleared.transcription_model_name).toBe("ears");
    expect(JSON.parse(storedColumn() ?? "null")).toEqual({});
  });

  it("rejects malformed and unknown-key allocations strictly without writing", async () => {
    const before = revision();
    for (const aux of [
      { knowledge_organize: { mode: "bogus" } },
      { unknown_role: { mode: "auto" } },
      { knowledge_organize: { mode: "auto", input_limit: 0 } },
      { knowledge_organize: { mode: "auto", extra: 1 } },
    ]) {
      const res = await put({ auxiliary_allocation: aux, expected_revision: before });
      expect(res.status).toBe(422);
    }
    expect(revision()).toBe(before);
    expect(storedColumn()).toBeNull();
  });

  it("the repository itself rejects an invalid allocation before any write (direct caller boundary)", () => {
    const rev = () => readOrganizationSettings(h.orm).revision;
    const before = rev();
    for (const aux of [
      { knowledge_organize: { mode: "bogus" } },
      { unknown_role: { mode: "auto" } },
      { knowledge_organize: { mode: "auto", input_limit: -5 } },
    ]) {
      expect(() =>
        updateOrganizationSettings(h.orm, {
          auxiliary_allocation: aux as GlobalAuxiliaryAllocation,
          expected_revision: before,
        }),
      ).toThrow(TypeError);
    }
    expect(rev()).toBe(before);
    expect(storedColumn()).toBeNull();
  });

  it("a corrupt stored column throws on read instead of silently degrading", () => {
    h.db
      .query("UPDATE organization_settings SET auxiliary_allocation = ? WHERE id = 1")
      .run('{"knowledge_organize":{"mode":"bogus"}}');
    expect(() => readOrganizationSettings(h.orm)).toThrow(TypeError);
  });
});
