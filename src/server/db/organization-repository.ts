import { eq } from "drizzle-orm";
import type {
  OrganizationSettings,
  OrganizationSettingsUpdate,
} from "../../shared/contracts/organization";
import { fail } from "../errors";
import type { Orm } from "./repositories";
import { organizationSettings } from "./schema";

export function readOrganizationSettings(orm: Orm): OrganizationSettings {
  const row = orm.select().from(organizationSettings).where(eq(organizationSettings.id, 1)).get();
  if (!row) throw new Error("Missing organization settings");
  return { model_name: row.modelName, revision: row.revision };
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
      if (old.model_name === input.model_name) return old;
      tx.update(organizationSettings)
        .set({ modelName: input.model_name, revision: old.revision + 1 })
        .where(eq(organizationSettings.id, 1))
        .run();
      return readOrganizationSettings(tx);
    },
    { behavior: "immediate" },
  );
}
