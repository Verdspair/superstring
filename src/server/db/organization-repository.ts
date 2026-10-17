import { eq } from "drizzle-orm";
import {
  type GlobalAuxiliaryAllocation,
  GlobalAuxiliaryAllocationSchema,
} from "../../shared/contracts/context-allocation";
import type {
  OrganizationSettings,
  OrganizationSettingsUpdate,
} from "../../shared/contracts/organization";
import { fail } from "../errors";
import { stableStringify } from "./json-text";
import type { Orm } from "./repositories";
import { organizationSettings } from "./schema";

/** 列里的 JSON 过不了契约时抛错，而不是被“修复”成无覆盖（与群配置列同一纪律）。 */
function parseJsonColumn(text: string, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`Invalid organization ${what}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Invalid organization ${what}: not a JSON object`);
  }
  return parsed;
}

function parseAuxiliaryAllocation(input: unknown): GlobalAuxiliaryAllocation {
  const result = GlobalAuxiliaryAllocationSchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid organization auxiliary allocation");
  return Object.freeze(result.data);
}

function view(row: {
  modelName: string | null;
  visionModelName: string | null;
  transcriptionModelName: string | null;
  auxiliaryAllocation?: string | null;
  revision: number;
}): OrganizationSettings {
  const settings: OrganizationSettings = {
    model_name: row.modelName,
    vision_model_name: row.visionModelName,
    transcription_model_name: row.transcriptionModelName,
    revision: row.revision,
  };
  // 0068：NULL 列与缺席同义（受保护的缺席语义，wire 上不伪造空对象）；有值则严格过契约，
  // 不过（坏 JSON / 未知用途 / 未知字段 / 非法限额）一律抛 TypeError，绝不静默落回无覆盖。
  if (row.auxiliaryAllocation !== null && row.auxiliaryAllocation !== undefined) {
    settings.auxiliary_allocation = parseAuxiliaryAllocation(
      parseJsonColumn(row.auxiliaryAllocation, "auxiliary_allocation"),
    );
  }
  return settings;
}

export function readOrganizationSettings(orm: Orm): OrganizationSettings {
  const row = orm.select().from(organizationSettings).where(eq(organizationSettings.id, 1)).get();
  if (!row) throw new Error("Missing organization settings");
  // Older known migration fixtures predate this column. SQLite treats a quoted
  // unknown column as a string literal, so do not parse that synthetic value.
  if (row.auxiliaryAllocation === "auxiliary_allocation") {
    return view({ ...row, auxiliaryAllocation: undefined });
  }
  return view(row);
}

export function updateOrganizationSettings(
  orm: Orm,
  input: OrganizationSettingsUpdate,
): OrganizationSettings {
  return orm.transaction(
    (tx) => {
      const old = readOrganizationSettings(tx);
      if (old.revision !== input.expected_revision)
        fail("CONFIG_VERSION_CONFLICT", "默认整理模型已被修改，请刷新后重试");
      // Three-state per purpose (§7.1): absent leaves it alone, null clears it, a name sets it.
      const modelName = input.model_name === undefined ? old.model_name : input.model_name;
      const vision =
        input.vision_model_name === undefined ? old.vision_model_name : input.vision_model_name;
      const transcription =
        input.transcription_model_name === undefined
          ? old.transcription_model_name
          : input.transcription_model_name;
      // 分配组（0068）整组来或整组不动：缺席＝保持现值，对象（含空）＝整体替换；
      // 写入边界先过契约（直接调用者也不绕开），CHECK 只是第二道防线。
      const auxiliary =
        input.auxiliary_allocation === undefined
          ? old.auxiliary_allocation
          : parseAuxiliaryAllocation(input.auxiliary_allocation);
      // 键序无关的相等判定（存储是 canonical JSON，比较也用它，避免等值 PUT 假性升版）。
      const sameAuxiliary =
        stableStringify(old.auxiliary_allocation ?? null) === stableStringify(auxiliary ?? null);
      if (
        old.model_name === modelName &&
        old.vision_model_name === vision &&
        old.transcription_model_name === transcription &&
        sameAuxiliary
      ) {
        return old;
      }
      tx.update(organizationSettings)
        .set({
          modelName,
          visionModelName: vision,
          transcriptionModelName: transcription,
          ...(auxiliary === undefined ? {} : { auxiliaryAllocation: stableStringify(auxiliary) }),
          revision: old.revision + 1,
        })
        .where(eq(organizationSettings.id, 1))
        .run();
      return readOrganizationSettings(tx);
    },
    { behavior: "immediate" },
  );
}
