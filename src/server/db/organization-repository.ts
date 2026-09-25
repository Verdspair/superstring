import { eq } from "drizzle-orm";
import type {
  OrganizationSettings,
  OrganizationSettingsUpdate,
} from "../../shared/contracts/organization";
import { fail } from "../errors";
import type { Orm } from "./repositories";
import { organizationSettings } from "./schema";

function view(row: {
  modelName: string | null;
  visionModelName: string | null;
  transcriptionModelName: string | null;
  revision: number;
}): OrganizationSettings {
  return {
    model_name: row.modelName,
    vision_model_name: row.visionModelName,
    transcription_model_name: row.transcriptionModelName,
    revision: row.revision,
  };
}

export function readOrganizationSettings(orm: Orm): OrganizationSettings {
  const row = orm.select().from(organizationSettings).where(eq(organizationSettings.id, 1)).get();
  if (!row) throw new Error("Missing organization settings");
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
      const vision =
        input.vision_model_name === undefined ? old.vision_model_name : input.vision_model_name;
      const transcription =
        input.transcription_model_name === undefined
          ? old.transcription_model_name
          : input.transcription_model_name;
      if (
        old.model_name === input.model_name &&
        old.vision_model_name === vision &&
        old.transcription_model_name === transcription
      ) {
        return old;
      }
      tx.update(organizationSettings)
        .set({
          modelName: input.model_name,
          visionModelName: vision,
          transcriptionModelName: transcription,
          revision: old.revision + 1,
        })
        .where(eq(organizationSettings.id, 1))
        .run();
      return readOrganizationSettings(tx);
    },
    { behavior: "immediate" },
  );
}
