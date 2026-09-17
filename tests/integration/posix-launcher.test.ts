import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const launcher = path.join(root, "start.sh");

describe.skipIf(process.platform === "win32")("POSIX source launcher", () => {
  function fixture() {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "ss-posix-launcher-"));
    const bun = path.join(dir, "fake-bun");
    const log = path.join(dir, "calls.log");
    writeFileSync(
      bun,
      `#!/bin/sh
printf '%s|port=%s|db=%s|web=%s\\n' "$*" "\${SUPERSTRING_DEV_PORT-}" "\${SUPERSTRING_DB_PATH-}" "\${SUPERSTRING_SERVE_WEB-}" >> "$SUPERSTRING_TEST_LOG"
if [ "\${SUPERSTRING_TEST_FAIL_PREPARE-}" = 1 ] && [ "$1" = tools/ops/start.ts ]; then exit 17; fi
`,
    );
    chmodSync(bun, 0o755);
    return {
      dir,
      log,
      run(args: string[], extraEnv: Record<string, string> = {}) {
        return spawnSync("sh", [launcher, ...args], {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            SUPERSTRING_BUN_EXE: bun,
            SUPERSTRING_DEV_PORT: "",
            SUPERSTRING_DB_PATH: "",
            SUPERSTRING_TEST_LOG: log,
            ...extraEnv,
          },
        });
      },
      calls() {
        try {
          return readFileSync(log, "utf8").trim().split("\n");
        } catch {
          return [];
        }
      },
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("keeps --check preflight-only even when --no-build follows it", () => {
    const fx = fixture();
    try {
      const result = fx.run(["--check", "--no-build", "--port", "17866", "--db", ":memory:"]);
      expect(result.status).toBe(0);
      expect(fx.calls()).toEqual(["tools/ops/start.ts --check|port=17866|db=:memory:|web=1"]);
    } finally {
      fx.cleanup();
    }
  });

  it("skips building and browser opening while handing port and DB to the server", () => {
    const fx = fixture();
    try {
      const result = fx.run(["--no-build", "--no-open", "--port", "17867", "--db", "other.sqlite"]);
      expect(result.status).toBe(0);
      expect(fx.calls()).toEqual([
        "tools/ops/start.ts --no-build|port=17867|db=other.sqlite|web=1",
        "run src/server/index.ts|port=17867|db=other.sqlite|web=1",
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("runs preparation, the browser opener, and the server by default", async () => {
    const fx = fixture();
    try {
      const result = fx.run([]);
      expect(result.status).toBe(0);
      for (let attempt = 0; attempt < 50 && fx.calls().length < 3; attempt++) {
        await Bun.sleep(10);
      }
      expect(fx.calls().sort()).toEqual(
        [
          "tools/ops/start.ts|port=|db=|web=1",
          "tools/ops/open-when-ready.ts --port 17861 --timeout 30000|port=|db=|web=1",
          "run src/server/index.ts|port=|db=|web=1",
        ].sort(),
      );
    } finally {
      fx.cleanup();
    }
  });

  it("stops before opening the browser or server when preparation fails", () => {
    const fx = fixture();
    try {
      const result = fx.run([], { SUPERSTRING_TEST_FAIL_PREPARE: "1" });
      expect(result.status).toBe(17);
      expect(fx.calls()).toEqual(["tools/ops/start.ts|port=|db=|web=1"]);
    } finally {
      fx.cleanup();
    }
  });
});
