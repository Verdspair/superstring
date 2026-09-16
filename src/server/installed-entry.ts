import path from "node:path";

// Installed service lives at <selected root>/app/superstring-server.exe.
// No source-root discovery, working-directory fallback, or developer DB override.
const root = path.dirname(path.dirname(process.execPath));
if (process.env.SUPERSTRING_DB_PATH?.trim()) throw new Error("INSTALLED_REJECTS_DATABASE_OVERRIDE");
if (process.env.SUPERSTRING_APP_ROOT && path.resolve(process.env.SUPERSTRING_APP_ROOT) !== root) {
  throw new Error("INSTALLED_ROOT_MISMATCH");
}
process.env.SUPERSTRING_APP_MODE = "installed";
process.env.SUPERSTRING_APP_ROOT = root;
process.env.SUPERSTRING_SERVE_WEB = "1";
await import("./index");
