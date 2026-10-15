import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { FileLocalModelEncodingStore } from "../../src/server/llm/local-model-encodings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "local-encoding-test-"));
  dirs.push(dir);
  const file = path.join(dir, "encodings.json");
  return { dir, file, store: new FileLocalModelEncodingStore(file) };
}
it("saves exact local declarations with file CAS and clears without changing capacity", () => {
  const f = fixture();
  expect(f.store.read()).toEqual({ revision: "", models: [] });
  const models = [{ name: "local-a", tokenizer_encoding: "o200k_base" as const }];
  const saved = f.store.replace("", models);
  expect(saved.models).toEqual(models);
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  const bytes = readFileSync(f.file, "utf8");
  expect(() => f.store.replace("", [])).toThrow();
  try {
    f.store.replace("", []);
  } catch (error) {
    expect(error).toMatchObject({ code: "CONFIG_VERSION_CONFLICT" });
  }
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
  expect(f.store.replace(saved.revision, []).models).toEqual([]);
});
it("rejects malformed or duplicate stored declarations rather than guessing", () => {
  const f = fixture();
  writeFileSync(f.file, "bad json");
  expect(() => f.store.read()).toThrow();
  expect(() => f.store.replace("", [])).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe("bad json");
  writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      models: [
        { name: "same", tokenizer_encoding: "cl100k_base" },
        { name: "same", tokenizer_encoding: "o200k_base" },
      ],
    }),
  );
  expect(() => f.store.read()).toThrow();
});
it("serves metadata without model calls; refuses stale and external-name updates", async () => {
  const f = fixture();
  const business = openBusinessDb();
  ensureDefaults(business.orm, "local-a");
  const app = createApp({
    business,
    localModelEncodings: f.store,
    modelProviderKeyPath: path.join(f.dir, "key"),
  });
  const put = (body: unknown) =>
    app.request("/models/local/encodings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect(await (await app.request("/models/local/encodings")).json()).toEqual({
      revision: "",
      models: [],
    });
    const save = await put({
      expected_revision: "",
      models: [{ name: "local-a", tokenizer_encoding: "cl100k_base" }],
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { revision: string; models: unknown[] };
    const stale = await put({ expected_revision: "", models: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "CONFIG_VERSION_CONFLICT" } });
    const duplicate = await put({
      expected_revision: saved.revision,
      models: [
        { name: "local-a", tokenizer_encoding: "cl100k_base" },
        { name: "local-a", tokenizer_encoding: "o200k_base" },
      ],
    });
    expect(duplicate.status).toBe(422);
    const external = await app.request("/models/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "synthetic",
        base_url: "https://provider.invalid/v1",
        models: [{ name: "external-a", context_window: 8192 }],
      }),
    });
    expect(external.status).toBe(201);
    expect(
      (
        await put({
          expected_revision: saved.revision,
          models: [{ name: "external-a", tokenizer_encoding: "o200k_base" }],
        })
      ).status,
    ).toBe(422);
    expect((await put({ expected_revision: saved.revision, models: [] })).status).toBe(200);
  } finally {
    business.close();
  }
});
