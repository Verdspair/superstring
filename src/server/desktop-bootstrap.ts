import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveAppPaths } from "./app-paths";
import { isDesktopToken } from "./desktop-lifecycle";

/** Validate the packaged entry before importing any database/runtime module. */
export function prepareDesktopEnvironment(
  env: Record<string, string | undefined>,
  executable: string,
): void {
  if (env.SUPERSTRING_APP_MODE !== "desktop" || env.SUPERSTRING_DESKTOP_MANAGED !== "1") {
    throw new Error("DESKTOP_ENTRY_REQUIRES_MANAGED_HOST");
  }
  if (!isDesktopToken(env.SUPERSTRING_DESKTOP_TOKEN)) {
    throw new Error("DESKTOP_ENTRY_REQUIRES_CONTROL_TOKEN");
  }
  if (env.SUPERSTRING_DB_PATH?.trim()) throw new Error("LAYOUT_REJECTS_DATABASE_OVERRIDE");
  const profile = env.SUPERSTRING_APP_ROOT ?? "";
  if (!path.isAbsolute(profile)) throw new Error("APP_ROOT_MUST_BE_ABSOLUTE");
  if (realpathSync(profile) !== profile || !statSync(profile).isDirectory()) {
    throw new Error("DESKTOP_PROFILE_MUST_BE_CANONICAL_DIRECTORY");
  }
  const adjacent = path.join(path.dirname(realpathSync(executable)), "resources");
  const resources = realpathSync(adjacent);
  if (resources !== adjacent || !statSync(resources).isDirectory()) {
    throw new Error("DESKTOP_RESOURCES_MUST_BE_CANONICAL_DIRECTORY");
  }
  if (env.SUPERSTRING_RESOURCE_ROOT !== undefined && env.SUPERSTRING_RESOURCE_ROOT !== resources) {
    throw new Error("DESKTOP_RESOURCE_ROOT_MISMATCH");
  }
  // Also reject profile/resource nesting. No writable path may land in a bundle.
  resolveAppPaths({ mode: "desktop", root: profile, resourceRoot: resources });
  env.SUPERSTRING_RESOURCE_ROOT = resources;
  env.SUPERSTRING_SERVE_WEB = "1";
  env.SUPERSTRING_DESKTOP_AUTO_PORT = "1";
}
