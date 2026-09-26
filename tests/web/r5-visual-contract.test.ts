import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = readFileSync(resolve(projectRoot, "src/web/styles.css"), "utf8");
const css = entry;

// The redesign intentionally replaces R5 pixel values. Keep behavior and access contracts;
// responsive geometry, theme contrast and readable layout are checked in the browser.
describe("Shared frontend contracts", () => {
  it("uses the official shadcn theme and Tailwind toolchain", () => {
    const config = JSON.parse(readFileSync(resolve(projectRoot, "components.json"), "utf8"));
    expect(config.style).toBe("radix-nova");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain('@import "shadcn/tailwind.css"');
    expect(css).toContain("motion-reduce:animate-none");
    expect(existsSync(resolve(projectRoot, "src/web/styles"))).toBe(false);
  });
  it("旧配置只保留新建和管理，不再渲染重复上下文与人设字段", () => {
    const read = (file: string) =>
      readFileSync(resolve(projectRoot, "src/web/features", file), "utf8");
    const legacy = read("agents/AgentSettings.tsx");
    expect(legacy).toContain("creating && editorDraft");
    expect(legacy).not.toContain("activeSection");
    expect(legacy).not.toContain("详细配置");
    for (const file of [
      "SectionC.tsx",
      "SectionD.tsx",
      "UnavailableSection.tsx",
      "ModelSelect.tsx",
    ]) {
      expect(existsSync(resolve(projectRoot, "src/web/features/agents", file))).toBe(false);
    }
    const workspace = readFileSync(
      resolve(projectRoot, "src/web/app/SettingsWorkspace.tsx"),
      "utf8",
    );
    expect(workspace).toContain("<SettingsPageEditor");
    expect(workspace).not.toMatch(/<Section[CD]|<UnavailableSection/);
    for (const selector of ["agent-editor-list", "selector-extra", "selector-identity"]) {
      expect(css).not.toContain(`.${selector}`);
    }
    const memory = read("memory/SectionB.tsx");
    expect(memory).toContain("<MemoryCorrection />");
    expect(memory).toContain("manualConsolidate");
    expect(memory).toContain("governMemories");
    expect(memory).not.toContain("updatePolicy");
    expect(memory).not.toContain("ModelSelect");
    expect(memory).not.toContain("patchP5");
  });
  it("新配置页平铺且使用顶部锚点、独立保存及真实控件", () => {
    const page = readFileSync(
      resolve(projectRoot, "src/web/features/agents/SettingsPageEditor.tsx"),
      "utf8",
    );
    expect(page).not.toContain("<Accordion");
    expect(page).not.toContain("<details");
    expect(page).toContain("workspace-anchors");
    expect(page).toContain("保存当前页");
    expect(page).toContain("fieldset disabled={loading || saving}");
  });
  it("设置工作区使用直接二级导航、独立作用域且不恢复多层折叠", () => {
    const sidebar = readFileSync(resolve(projectRoot, "src/web/app/SettingsSidebar.tsx"), "utf8");
    const workspace = readFileSync(
      resolve(projectRoot, "src/web/app/SettingsWorkspace.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("sectionDestinations(section).map");
    expect(sidebar).not.toContain("SETTINGS_GROUPS.map");
    expect(sidebar).toContain("aria-current");
    expect(sidebar).not.toContain("<details");
    expect(workspace).not.toContain("<details");
    expect(workspace).toContain('aria-label={t("正在配置的助手")}');
    expect(workspace).toContain("仅影响所选助手；读取范围不会授予新权限。");
    expect(workspace).toContain('<KnowledgeModelPage scope="model" />');
    expect(workspace).toContain('<SettingsPageEditor page="models" compact />');
    expect(workspace).toContain("<KnowledgeSettings embedded />");
    expect(workspace).toContain("<OrganizationModelPage />");
    expect(workspace).toContain("<KnowledgeReadPage />");
    const reading = readFileSync(
      resolve(projectRoot, "src/web/features/knowledge/KnowledgeReadPage.tsx"),
      "utf8",
    );
    expect(reading).not.toContain("<details");
    expect(reading).not.toContain("<Accordion");
    expect(reading).not.toContain("workspace-anchors");
    expect(reading).toContain("knowledge-rule-grid");
    expect(workspace).toContain('aria-label={t("知识库分区跳转")}');
    expect(reading).toContain("尚未开放的读取策略");
    expect(reading).toContain("保存助手读取配置");
    const chatSidebar = readFileSync(resolve(projectRoot, "src/web/app/Sidebar.tsx"), "utf8");
    expect(chatSidebar).toContain("<ConversationList />");
    expect(chatSidebar).toContain("<SettingsNavigation />");
    const header = readFileSync(resolve(projectRoot, "src/web/app/SettingsHeader.tsx"), "utf8");
    expect(header).not.toContain("<SettingsNavigation />");
    expect(header).toContain("page-header settings-header");
  });

  it("keeps document text inert and the scheme save action reachable", () => {
    const knowledge = readFileSync(
      resolve(projectRoot, "src/web/features/knowledge/KnowledgeSettings.tsx"),
      "utf8",
    );
    const editor = readFileSync(
      resolve(projectRoot, "src/web/features/knowledge/KnowledgeEditor.tsx"),
      "utf8",
    );
    expect(knowledge + editor).not.toContain("dangerouslySetInnerHTML");
    const scheme = readFileSync(
      resolve(projectRoot, "src/web/features/qq/SchemeSettings.tsx"),
      "utf8",
    );
    expect(scheme).toContain("sticky");
  });
});
