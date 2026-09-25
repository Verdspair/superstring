import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { readDesktopSettings, updateDesktopSettings } from "../../src/server/db/desktop-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";

class FakeGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen/qwen3-4b-2507", timeoutSeconds: 60 };
  async listModels(): Promise<string[]> {
    return [this.config.model];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(): Promise<string> {
    return "ok";
  }
  async *streamChat(): AsyncGenerator<string, void, never> {
    yield "ok";
  }
}

function json(body: unknown, method = "PUT"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("the desktop close preference", () => {
  it("starts at the behaviour the product already had, and never leaves that value implicit", () => {
    const business = openBusinessDb();
    try {
      // 'exit' is what happened before this row existed (last page closed -> the grace expired ->
      // the server stopped), so the migration must not change an untouched installation.
      expect(readDesktopSettings(business.orm)).toEqual({ close_action: "exit", revision: 1 });
    } finally {
      business.close();
    }
  });

  it("compares and swaps on the revision, and does not bump it for a no-op", () => {
    const business = openBusinessDb();
    try {
      expect(
        updateDesktopSettings(business.orm, { close_action: "background", expected_revision: 1 }),
      ).toEqual({ close_action: "background", revision: 2 });
      // Re-saving the same answer is not a change: bumping the revision would invalidate a dialog
      // the host may be holding open over a no-op.
      expect(
        updateDesktopSettings(business.orm, { close_action: "background", expected_revision: 2 }),
      ).toEqual({ close_action: "background", revision: 2 });
      expect(() =>
        updateDesktopSettings(business.orm, { close_action: "exit", expected_revision: 1 }),
      ).toThrow();
      expect(readDesktopSettings(business.orm).close_action).toBe("background");
    } finally {
      business.close();
    }
  });

  it("refuses a value the product cannot honour", () => {
    const business = openBusinessDb();
    try {
      // 'ask' needs the host dialog, which does not exist yet; the database refuses to store an
      // answer nothing implements, and so does the contract in front of it.
      expect(() =>
        business.db.run("UPDATE desktop_settings SET close_action = 'ask' WHERE id = 1"),
      ).toThrow();
    } finally {
      business.close();
    }
  });

  it("answers both verbs over HTTP and rejects a stale writer", async () => {
    const business = openBusinessDb();
    const app = createApp({ business, gateway: new FakeGateway() });
    try {
      const initial = await app.request("/desktop/settings");
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ close_action: "exit", revision: 1 });

      const updated = await app.request(
        "/desktop/settings",
        json({ close_action: "background", expected_revision: 1 }),
      );
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({ close_action: "background", revision: 2 });

      const stale = await app.request(
        "/desktop/settings",
        json({ close_action: "exit", expected_revision: 1 }),
      );
      expect(stale.status).toBe(409);
      expect((await stale.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "CONFIG_VERSION_CONFLICT" },
      });

      const invalid = await app.request(
        "/desktop/settings",
        json({ close_action: "ask", expected_revision: 2 }),
      );
      // The error handler maps a contract violation to 422 (§6.2), same as every other route.
      expect(invalid.status).toBe(422);
    } finally {
      business.close();
    }
  });
});
