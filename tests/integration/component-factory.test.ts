import { expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { PermissionService, type PermissionStore } from "../../src/server/permissions/service";

it("exposes system tools and document skills in the normal factory without an external skill root", async () => {
  const business = openBusinessDb();
  try {
    ensureDefaults(business.orm, "synthetic-model");
    const app = createApp({ business });
    const response = await app.request("http://127.0.0.1/v2/tools");
    expect(response.status).toBe(200);
    const directory = await response.json();
    expect(directory.tools.some((tool: { name: string }) => tool.name === "memory.query")).toBe(
      true,
    );
    expect(directory.tools.some((tool: { name: string }) => tool.name === "web.search")).toBe(true);
    const skills = await (await app.request("http://127.0.0.1/v2/skills")).json();
    expect(
      skills.skills.some(
        (skill: { name: string; origin: string }) =>
          skill.name === "system-evidence-reading" && skill.origin === "system",
      ),
    ).toBe(true);
  } finally {
    business.close();
  }
});

it("does not add system read tools to the permission grant projection", async () => {
  const business = openBusinessDb();
  try {
    ensureDefaults(business.orm, "synthetic-model");
    const store: PermissionStore = {
      read: () => ({ revision: "test", policy: { version: 1, grants: [] } }),
      replace: () => {
        throw new Error("No writes in directory test");
      },
    };
    const app = createApp({ business, permissions: new PermissionService(store) });
    const grants = await (await app.request("http://127.0.0.1/v2/permissions")).json();
    expect(grants.policy.grants).toEqual([]);
    expect(
      grants.resources.some((resource: { name: string }) => resource.name === "memory.query"),
    ).toBe(false);
    expect(
      grants.resources.filter((resource: { resource: string }) => resource.resource === "web"),
    ).toHaveLength(1);
  } finally {
    business.close();
  }
});

it("keeps the same system skill entries when the global skills module is disabled", async () => {
  const business = openBusinessDb();
  try {
    ensureDefaults(business.orm, "synthetic-model");
    const store: PermissionStore = {
      read: () => ({ revision: "test", policy: { version: 1, grants: [] } }),
      replace: () => {
        throw new Error("No writes in directory test");
      },
    };
    const app = createApp({
      business,
      permissions: new PermissionService(store),
      skillsEnabled: () => false,
    });
    const catalog = await (await app.request("http://127.0.0.1/v2/skills")).json();
    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(
      catalog.skills.every((skill: { globalEnabled: boolean }) => skill.globalEnabled === false),
    ).toBe(true);
  } finally {
    business.close();
  }
});
