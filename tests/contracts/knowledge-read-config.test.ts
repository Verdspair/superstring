import { describe, expect, test } from "bun:test";
import {
  AgentKnowledgeReadSettingsSchema,
  AgentKnowledgeReadUpdateSchema,
  AgentKnowledgeReadConfigSchema as Config,
} from "../../src/shared/contracts/knowledge";
import {
  filterKnowledgeReadScope,
  resolveKnowledgeReadBudget,
} from "../../src/shared/knowledge-read-config";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const rows = [
  { id: A, name: "A" },
  { id: B, name: "B" },
];
describe("S3 assistant knowledge read contract", () => {
  test("defaults preserve enabled, inherited budget and all authorized documents", () => {
    expect(Config.parse({})).toEqual({
      enabled: true,
      context_budget: null,
      scope: "all",
      document_ids: [],
    });
  });
  test("budget inherits latest global default when resolved", () => {
    const config = Config.parse({});
    expect(resolveKnowledgeReadBudget(config, 4096)).toEqual({
      enabled: true,
      budget: 4096,
      source: "global",
    });
    expect(resolveKnowledgeReadBudget(config, 8192).budget).toBe(8192);
  });
  test("assistant override is not capped by the global default", () => {
    const config = Config.parse({ context_budget: 8192 });
    expect(resolveKnowledgeReadBudget(config, 4096)).toEqual({
      enabled: true,
      budget: 8192,
      source: "assistant",
    });
  });
  test("disabled preserves configured budget but returns no documents", () => {
    const config = Config.parse({ enabled: false, context_budget: 8192 });
    expect(resolveKnowledgeReadBudget(config, 4096).budget).toBe(8192);
    expect(filterKnowledgeReadScope(rows, config)).toEqual([]);
  });
  test.each([0, -1, 1.5, Infinity, "4096"])("rejects invalid override %s", (context_budget) => {
    expect(Config.safeParse({ context_budget }).success).toBe(false);
  });
  test("all includes future grants without mutating the original list", () => {
    const config = Config.parse({});
    expect(filterKnowledgeReadScope([...rows, { id: C, name: "C" }], config)).toHaveLength(3);
    expect(filterKnowledgeReadScope(rows, config)).not.toBe(rows);
    expect(rows).toHaveLength(2);
  });
  test("selected only intersects grants, preserving authorized order", () => {
    const config = Config.parse({ scope: "selected", document_ids: [C, B] });
    expect(filterKnowledgeReadScope(rows, config)).toEqual([rows[1]]);
    expect(config.document_ids).toEqual([C, B]);
  });
  test("selected empty never falls back to all", () => {
    expect(filterKnowledgeReadScope(rows, Config.parse({ scope: "selected" }))).toEqual([]);
  });
  test("revoked selection cannot grant access", () => {
    const config = Config.parse({ scope: "selected", document_ids: [A] });
    expect(filterKnowledgeReadScope([rows[1]], config)).toEqual([]);
  });
  test("all rejects hidden selected IDs", () => {
    expect(Config.safeParse({ document_ids: [A] }).success).toBe(false);
  });
  test("duplicate IDs are rejected after UUID normalization", () => {
    expect(
      Config.safeParse({ scope: "selected", document_ids: [A, A.replaceAll("-", "")] }).success,
    ).toBe(false);
  });
  test("unsupported preferences and malformed IDs are rejected", () => {
    expect(Config.safeParse({ preference: "original" }).success).toBe(false);
    expect(Config.safeParse({ scope: "selected", document_ids: ["bad"] }).success).toBe(false);
    expect(Config.safeParse({ scope: "category" }).success).toBe(false);
  });
  test("settings and full replacement update have distinct revision fields", () => {
    const config = Config.parse({});
    expect(AgentKnowledgeReadSettingsSchema.parse({ revision: 1, config }).revision).toBe(1);
    expect(AgentKnowledgeReadUpdateSchema.parse({ expected_revision: 1, config }).config).toEqual(
      config,
    );
    expect(AgentKnowledgeReadUpdateSchema.safeParse({ revision: 1, config }).success).toBe(false);
    expect(AgentKnowledgeReadUpdateSchema.safeParse({ expected_revision: 0, config }).success).toBe(
      false,
    );
  });
});
