import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(resolve(projectRoot, "src/web/styles.css"), "utf8");
// Explicit module list preserves the pre-extraction positive/negative source contracts after extraction.
const app = [
  "App.tsx",
  "ui/icons.tsx",
  "ui/Accordion.tsx",
  "ui/Field.tsx",
  "ui/ConfirmDialog.tsx",
  "ui/ProcessingStatus.tsx",
  "app/Sidebar.tsx",
  "app/SettingsHeader.tsx",
  "app/SettingsHub.tsx",
  "app/NavigationConfirm.tsx",
  "features/chat/ChatPage.tsx",
  "features/agents/AgentSettings.tsx",
  "features/agents/SectionA.tsx",
  "features/agents/sections.ts",
  "features/memory/SectionB.tsx",
  "features/appearance/AppearanceSettings.tsx",
]
  .map((file) => readFileSync(resolve(projectRoot, "src/web", file), "utf8"))
  .join("\n");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

describe("R5 视觉契约", () => {
  it("紧凑一级导航不拉伸行高，统一36px单行高度与3px间隔", () => {
    expect(css).toContain("--ac-nav-height: 36px");
    expect(css).toContain("--ac-nav-gap: 3px");
    expect(rule(".settings-primary-nav")).toContain("align-content: start");
    expect(rule(".settings-primary-nav")).toContain("gap: var(--ac-nav-gap)");
    expect(rule(".settings-navigation")).toContain("border: 0");
    expect(rule(".settings-navigation")).toContain("padding: 0");
    expect(rule(".settings-navigation button")).toContain("padding: 5px 10px");
    expect(rule(".settings-navigation button")).not.toMatch(/(?:^|;)\s*height:\s*\d/);
    expect(rule(".settings-navigation .icon")).toContain("width: 16px");
    expect(rule(".settings-body")).toContain("width: 100%");
    expect(rule(".settings-body")).toContain("margin: 0;");
    expect(rule(".settings-body")).not.toContain("880px");
    expect(rule(".settings-body")).not.toContain("1064px");
    expect(css).toContain("grid-template-columns: 96px minmax(0, 1fr)");
  });
  it("正文取消重复外框，公共分组和弹窗保留中性内容面板", () => {
    expect(rule(".workspace-detail")).toContain("border: 0");
    expect(rule(".workspace-detail > .detail-body")).toContain("padding: 0");
    for (const selector of [".group", ".detail-config", ".knowledge-category", ".confirm-dialog"]) {
      expect(rule(selector)).toContain("background: var(--ac-surface)");
    }
    expect(css).toContain("background: var(--ac-heading-bg)");
    expect(css).not.toContain("inset 3px 0");
    expect(rule(".settings-secondary-nav")).toContain("border: 0");
    expect(rule(".settings-secondary-nav")).toContain("border-bottom: 1px solid");
  });
  it("选中态只用统一内侧标记且悬停不丢失状态", () => {
    expect(css).toContain("--ac-selection-marker: inset 2px 0 var(--ac-accent)");
    for (const selector of [
      ".settings-navigation button[aria-current]",
      ".settings-secondary-nav button.active",
      ".session-list button.active",
    ]) {
      expect(rule(selector)).toContain("background: var(--ac-accent-soft)");
      expect(rule(selector)).toContain("box-shadow: var(--ac-selection-marker)");
      expect(rule(selector)).not.toContain("border-left-color");
    }
    // 旧助手列表选中态已随组件退役，不得重新引入。
    expect(css).not.toContain(".agent-editor-list button.active");
    expect(css).toContain(".settings-navigation button[aria-current]:hover:not(:disabled)");
    expect(css).toContain('button.mode-option[aria-pressed="true"]:hover:not(:disabled)');
    expect(css).toContain(".memory-row:has(input:checked)");
  });
  it("常规操作控件共用32px基准，保留键盘焦点和危险失败色", () => {
    expect(css).toContain("--ac-control-height: 32px");
    expect(rule("button")).toContain("min-height: var(--ac-control-height)");
    expect(css).toMatch(/(?:^|\})\s*input,\s*textarea,\s*select\s*\{[^}]*padding: 5px 10px/);
    expect(rule(".confirm-dialog > strong")).toContain("font-size: 16px");
    expect(rule(".confirm-dialog > strong")).toContain("font-weight: 600");
    expect(rule(":is(button, summary, input, textarea, select, a):focus-visible")).toContain(
      "outline: 2px solid var(--ac-accent)",
    );
    expect(rule("button.danger")).toContain("color: var(--ac-danger)");
    expect(rule(".message.failed .bubble")).toContain("background: var(--ac-danger-soft)");
  });
  it("一级导航在独立设置栏纵向排列，二级在右侧顶部并带主题选中底色", () => {
    const navigation = readFileSync(
      resolve(projectRoot, "src/web/app/SettingsSidebar.tsx"),
      "utf8",
    );
    const workspace = readFileSync(
      resolve(projectRoot, "src/web/app/SettingsWorkspace.tsx"),
      "utf8",
    );
    expect(navigation).toContain("<SettingsNavigation />");
    expect(navigation).toContain('className="settings-secondary-nav"');
    expect(rule(".settings-primary-nav")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(".settings-secondary-nav")).toContain("flex-wrap: wrap");
    expect(navigation.indexOf('t("快捷管理")')).toBeLessThan(
      navigation.indexOf("SETTINGS_GROUPS.map"),
    );
    expect(rule(".settings-body")).toContain("grid-template-columns: 120px minmax(0, 1fr)");
    expect(rule(".settings-secondary-nav button.active")).toContain(
      "background: var(--ac-accent-soft)",
    );
    expect(rule(".settings-navigation button[aria-current]")).toContain(
      "box-shadow: var(--ac-selection-marker)",
    );
    expect(workspace).toContain("<SettingsBody>");
    expect(workspace).toContain('className="detail-config workspace-detail"');
    expect(workspace).toContain('className="detail-body"');
    expect(rule(".workspace-config > h2")).toContain("font-size: 16px");
    expect(rule(".workspace-group-heading small")).toContain("font-size: 11px");
  });
  it("新平铺分组复用旧group外观与功能图标，不以横线代替", () => {
    const group = readFileSync(resolve(projectRoot, "src/web/ui/Accordion.tsx"), "utf8");
    expect(group).toContain('className="group workspace-group"');
    expect(group).toContain('className="group-body"');
    expect(rule(".group")).toContain("border-radius: var(--ac-radius)");
    expect(rule(".group")).toContain("background: var(--ac-surface)");
    expect(rule(".workspace-group h3")).toContain("font-size: 13px");
    expect(rule(".workspace-group h3")).toContain("min-height: 48px");
    expect(rule(".workspace-group")).not.toContain("border-top");
    expect(rule(".workspace-group-heading .config-list-icon")).toContain("flex: 0 0 18px");
  });
  it("新工作区沿用600标题字重和已定义的主题正文色", () => {
    expect(rule(".workspace-group h3")).toContain("font-weight: 600");
    expect(rule(".workspace-anchors a")).toContain("color: var(--ac-text)");
    expect(rule(".workspace-anchors a")).not.toContain("var(--text)");
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
    expect(rule(".page-editor fieldset")).toContain("min-width: 0");
  });
  it("设置工作区使用直接二级导航、独立作用域且不恢复多层折叠", () => {
    const sidebar = readFileSync(resolve(projectRoot, "src/web/app/SettingsSidebar.tsx"), "utf8");
    const workspace = readFileSync(
      resolve(projectRoot, "src/web/app/SettingsWorkspace.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("SETTINGS_GROUPS.map");
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
    expect(rule(".settings-navigation button")).toContain("background: transparent");
    expect(rule(".settings-navigation button")).toContain("min-height: var(--ac-nav-height)");
    const chatSidebar = readFileSync(resolve(projectRoot, "src/web/app/Sidebar.tsx"), "utf8");
    expect(chatSidebar).toContain("<SessionList />");
    expect(chatSidebar).not.toContain("SettingsSidebar");
    const header = readFileSync(resolve(projectRoot, "src/web/app/SettingsHeader.tsx"), "utf8");
    expect(header).not.toContain("<SettingsNavigation />");
    expect(header).toContain('<header className="page-header settings-header">');
  });
  it("知识库铺满设置正文并沿用纯图标返回及58px资料行，不执行资料HTML", () => {
    const knowledge = readFileSync(
      resolve(projectRoot, "src/web/features/knowledge/KnowledgeSettings.tsx"),
      "utf8",
    );
    const editor = readFileSync(
      resolve(projectRoot, "src/web/features/knowledge/KnowledgeEditor.tsx"),
      "utf8",
    );
    expect(knowledge).toContain("<SettingsHeader onBack={back} />");
    expect(knowledge).toContain("s.openSettings");
    expect(knowledge).toContain("onContextMenu");
    expect(knowledge).toContain('e.key === "ContextMenu"');
    expect(knowledge + editor).not.toContain("dangerouslySetInnerHTML");
    expect(rule(".knowledge-settings")).toContain("max-width: none");
    expect(rule(".knowledge-row")).toContain("min-height: 58px");
    expect(rule(".knowledge-open")).toContain("background: transparent");
    expect(rule(".knowledge-original")).toContain("white-space: pre-wrap");
  });
  it("返回为纯图标方形触区，运行模式沿用中性纵向设置行", () => {
    const header = readFileSync(resolve(projectRoot, "src/web/app/SettingsHeader.tsx"), "utf8");
    const back = header.split('className="settings-back"')[1]?.split("</button>")[0] ?? "";
    expect(back).toContain('title={t("返回设置中心")}');
    expect(back).toContain('aria-label={t("返回设置中心")}');
    expect(back).not.toContain("<span>");
    expect(rule("button.settings-back")).toContain("width: 32px");
    expect(rule("button.settings-back")).toContain("height: 32px");
    expect(rule(".operating-modes")).toContain("display: grid");
    expect(rule(".operating-modes")).toContain("gap: 12px");
    const mode = rule("button.operating-mode-row");
    expect(mode).toContain("min-height: 58px");
    expect(mode).toContain("padding: 9px 12px");
    expect(mode).toContain("border-radius: var(--ac-radius)");
    expect(mode).toContain("background: var(--superstring-tone-soft)");
    expect(mode).not.toContain("background: var(--superstring-tone-deep)");
    expect(rule("button.operating-mode-row:disabled")).toContain("opacity: 1");
  });
  it("冻结9版高位双引号、延展弦端与实心节点，不恢复R1", () => {
    const brand = app.split("    brand: (")[1]?.split("    settings: (")[0] ?? "";
    expect(brand.match(/<path\b/g)).toHaveLength(6);
    expect(brand.match(/<circle\b/g)).toHaveLength(2);
    expect(brand).toContain('strokeWidth="1.7"');
    expect(brand).toContain('<g strokeWidth="1.3">');
    expect(brand).toContain('strokeWidth="1.4"');
    expect(brand).toContain("M7.6 10h8.8a1.6");
    expect(brand).toContain("M1.85 3.55");
    expect(brand).toContain("M3.7025 3.55");
    expect(brand).toContain("M20.2975 5.4025");
    expect(brand).toContain("M22.15 5.4025");
    expect(brand).not.toContain("M1.85 2.55");
    expect(brand).not.toContain("M22.15 4.4025");
    expect(brand).toContain(
      "M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75",
    );
    expect(brand).toContain('cx="10.065" cy="13.1" r="1.6" fill="currentColor" stroke="none"');
    expect(brand).toContain('cx="13.935" cy="15.5" r="1.6" fill="currentColor" stroke="none"');
    expect(brand).not.toContain("M7.2 8.2");
    expect(brand).not.toContain('r="0.85"');
    expect(brand).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const svg = readFileSync(resolve(projectRoot, "tools/desktop/assets/superstring.svg"), "utf8");
    const native = readFileSync(resolve(projectRoot, "tools/desktop/src/GlyphRenderer.cs"), "utf8");
    const paths = [...brand.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
    expect([...svg.matchAll(/d="([^"]+)"/g)].map((match) => match[1])).toEqual(paths);
    for (const path of paths) expect(native).toContain(`"${path}"`);
  });

  it("冻结原版浅色、暗色和语义颜色令牌", () => {
    for (const token of [
      "--superstring-tone-deep: #26364a",
      "--superstring-tone-light: #edf2f7",
      "--superstring-tone-line: #dce2e9",
      "--superstring-tone-soft: #f7f8fa",
      "--ac-accent: #4266b0",
      "--ac-surface: #232b36",
      "--ac-text: #e7ebf2",
      "--ac-muted: #b0bac9",
      "--ac-accent: #a1bcff",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain("#ef7d35");
    expect(css).not.toContain("#e8712d");
    expect(css).not.toContain("#df6e29");
  });

  it("冻结桌面侧栏、聊天列、气泡和 composer 尺寸", () => {
    expect(css).toContain("--superstring-sidebar-width: clamp(210px, 16vw, 236px)");
    expect(rule("#superstring-shell")).toContain(
      "grid-template-columns: var(--superstring-sidebar-width) minmax(0, 1fr)",
    );
    expect(rule(".settings-button")).toMatch(/width:\s*34px/);
    expect(rule(".settings-button")).toMatch(/right:\s*10px/);
    expect(rule(".settings-button")).toMatch(/bottom:\s*10px/);
    expect(rule(".messages")).toContain("width: min(1080px, 100%)");
    expect(rule(".bubble")).toContain("max-width: min(72%, 760px)");
    expect(rule(".bubble")).toContain("padding: 8px 11px");
    expect(rule(".composer-wrap")).toContain("left: 50%");
    expect(rule(".composer-wrap")).toContain("width: min(880px, calc(100% - 32px))");
    expect(rule(".composer-wrap")).toContain("bottom: 16px");
    // 2026-09-20：设置正文铺满可用区域，聊天区仍保持原有居中宽度。
    expect(rule(".settings-content,\n.agent-settings")).toContain("width: 100%");
    expect(rule(".settings-content,\n.agent-settings")).toContain("min-width: 0");
    expect(rule(".settings-content,\n.agent-settings")).toContain("margin: 0;");
    expect(rule(".settings-content,\n.agent-settings")).toContain("padding: 16px 0 80px");
    expect(app).not.toContain('className="settings-back-slot"');
    expect(app).toContain("<SettingsHeader onBack={closeAgentSettings} />");
    expect(rule(".settings-back .icon")).toContain("width: 16px");
  });

  it("冻结 1100/760/600/480 四级响应式合同", () => {
    for (const breakpoint of [1100, 760, 600, 480]) {
      expect(css).toContain(`@media (max-width: ${breakpoint}px)`);
    }
    expect(css).toContain("--superstring-sidebar-width: clamp(196px, 20vw, 216px)");
    expect(css).toContain("max-height: 31vh");
    expect(rule("#superstring-shell")).toContain("grid-template-rows: minmax(0, 1fr) auto");
    expect(css).not.toContain("min-height: 600px");
    expect(rule(".app-statusbar")).toContain("grid-column: 1 / -1");
    expect(css).toContain("max-width: 88%");
    expect(css).not.toContain("@media (max-width: 640px)");
    expect(css).not.toContain("@media (max-width: 980px)");
  });

  it("冻结暗色自动适配、reduced-motion 与加载圆环", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(rule(".superstring-loading-ring")).toContain(
      "animation: superstring-loading-turn 760ms linear infinite",
    );
    expect(css).toMatch(/\.superstring-loading-ring\s*\{\s*animation:\s*none;/);
    expect(rule(".processing-status")).toContain("right: 12px");
    expect(rule(".processing-status")).toContain("bottom: 12px");
  });

  it("保留 heading host 和分区图标，助手按确认方案改为人形", () => {
    expect(rule(".heading-icon-host")).toContain("width: 21px");
    expect(rule(".heading-icon-host")).toContain("height: 21px");
    expect(rule(".heading-icon-host")).toContain("color: var(--superstring-tone-deep)");
    for (const path of [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18",
      'circle cx="12" cy="8" r="3.5"',
      "M5 20v-1a7 7 0 0 1 14 0v1",
      "M5 6c0-2 3.1-3 7-3s7 1 7 3",
      "M4 5h16v12H9l-5 3V5Z",
      "M12 12a4 4 0 1 0 0-8",
      "M12 21a9 9 0 1 0 0-18",
      "M8 3v5M16 3v5M6 8h12",
      "M5 12h.01M12 12h.01M19 12h.01",
    ]) {
      expect(app).toContain(path);
    }
  });

  it("冻结 Agent 与分区折叠的可访问选择语义和紧凑密度", () => {
    expect(app).toContain('aria-label={t("正在配置的助手")}');
    expect(app).toContain("requestAgentNavigation(id)");
    expect(app).not.toContain("aria-pressed={item.key === activeSection}");
    expect(app).not.toContain("requestSectionNavigation(item.key)");
    expect(css).not.toContain(".section-nav");
    expect(css).not.toContain(".section-selector");
  });

  it("保留主按钮主题填充与 1px 主题描边", () => {
    expect(rule("button")).toContain("border: 1px solid var(--superstring-tone-line)");
    for (const selector of ["button.primary", "button.primary:hover:not(:disabled)"]) {
      expect(rule(selector)).toContain("background: var(--superstring-tone-deep)");
      expect(rule(selector)).toContain("border-color: var(--superstring-tone-deep)");
    }
  });

  it("保留内容图标主题色，列表选中使用统一浅主题底色", () => {
    // 2026-09-20授权：内容图标18px、导航16px、线宽1.7；选中浅底与2px内侧色条。
    const rowIcons = rule(
      ".agent-settings > details > summary > .icon:not(.chevron),\n.appearance-settings > details > summary > .icon:not(.chevron),\nbutton.settings-entry > .icon",
    );
    expect(rowIcons).toContain("width: 18px");
    expect(rowIcons).toContain("stroke-width: 1.7");
    expect(rowIcons).toContain("color: var(--superstring-tone-deep)");
    const rowChevrons = rule(
      ".agent-settings > details > summary > .chevron,\n.appearance-settings > details > summary > .chevron",
    );
    expect(rowChevrons).toContain("width: 16px");
    expect(rowChevrons).toContain("stroke-width: 1.7");
    expect(css).not.toContain(".section-nav .icon");
    expect(rule(".settings-entry > .icon")).toContain("color: var(--superstring-tone-deep)");
    expect(rule(".session-list button.active")).toContain("background: var(--ac-accent-soft)");
    expect(css).not.toContain(".agent-editor-list button.active");
    expect(css).not.toContain(".group > summary:hover");
    expect(css).not.toContain(".agent-selector > summary:hover");
  });

  it("冻结加宽后仍居中的内容区与简洁聊天空态", () => {
    for (const selector of [".chat-content", ".composer-wrap"]) {
      expect(rule(selector)).toContain("left: 50%");
      expect(rule(selector)).toContain("transform: translateX(-50%)");
    }
    expect(rule(".messages")).toContain("margin: 0 auto");
    expect(rule(".empty-chat")).toContain("margin: 0 auto");
    expect(rule(".empty-chat")).toContain("align-items: center");
    expect(rule(".empty-chat")).toContain("text-align: center");
    expect(rule(".empty-chat h2")).toContain("font-size: 18px");
    expect(rule(".empty-chat h2")).toContain("font-weight: 500");
    expect(rule(".empty-chat p")).toContain("font-size: 12px");
    expect(app).not.toContain("<span>↗</span>");
    expect(app).not.toContain("从左侧新建会话，选择要对话的助手。");
    expect(app).toContain("点击“新建任务”，开启与助手的对话。");
  });

  it("冻结「统一行规格」：三级设置页的折叠行共用同一套几何与字体", () => {
    // 修复前实测：同一页三行高 55.5 / 56.5 / 73.8px，字号 13/13/14px，内边距 8/8/7px，
    // 说明行字号 12/12/11px。统一后 8 个行全部为 58px / 9px 12px / 10px / 13px / 11px。
    const rows = rule(
      ".agent-settings > details > summary,\n.appearance-settings > details > summary",
    );
    expect(rows).toContain("min-height: 58px");
    expect(rows).toContain("padding: 9px 12px");
    expect(rows).toContain("gap: 10px");
    expect(rows).toContain("font-size: 13px");
    const smalls = rule(
      ".agent-settings > details > summary small,\n.appearance-settings > details > summary small",
    );
    expect(smalls).toContain("font-size: 11px");
    expect(smalls).toContain("margin-top: 2px");
    // 设置中心的入口行必须与折叠行同高同内边距，否则两级页面一进一出会跳一下。
    expect(rule("button.settings-entry")).toContain("min-height: 58px");
    expect(rule("button.settings-entry")).toContain("padding: 9px 12px");
    // 分组标题规则不得再顺手改折叠行（曾把「批量管理」撑到 14px + 16px 上边距）。
    expect(rule(".config-group-heading")).toContain("font-size: 14px");
    expect(css).not.toContain(".agent-settings > .group > summary strong");
    // 返回按钮里的图标必须在 32px 方框内居中，不能被行的 flex-start 顶到顶部。
    expect(rule(".back-link.icon-button .icon")).toContain("align-self: center");
    // 说明段落不带列表描边（外观页曾多出 1px 边框，比助手设置页高 2px）。
    expect(rule(".appearance-settings > p")).toContain("border: 0");
    // 小控件 / 消息气泡此前各写各的圆角（6/7/9/10px），全部回到 --ac-radius；
    // 圆形（50%）保留。
    for (const raw of [
      "border-radius: 6px",
      "border-radius: 7px",
      "border-radius: 9px",
      "border-radius: 10px",
    ]) {
      expect(css).not.toContain(raw);
    }
    // 字重只用标准档位：按钮基准 550、标题 650 都已归入 500 / 600。
    expect(css).not.toContain("font-weight: 550");
    expect(css).not.toContain("font-weight: 650");
  });

  it("内层配置分行，顶层块与设置中心统一 12px 间距", () => {
    expect(rule(".group > summary")).toContain("display: flex");
    expect(rule(".group > summary")).toContain("padding: 8px 12px");
    expect(rule(".group > summary strong")).toContain("display: block");
    expect(rule(".group > summary small")).toContain("font-weight: 400");
    expect(rule(".group > summary > .chevron")).toContain("flex: 0 0 16px");
    expect(rule(".agent-settings > details,\n.appearance-settings > details")).toContain(
      "margin: 0",
    );
    expect(
      rule(".agent-settings > details + details,\n.appearance-settings > details + details"),
    ).toContain("margin-top: 12px");
    expect(rule(".settings-list")).toContain("gap: 12px");
    expect(rule("button.settings-entry")).toContain("border-radius: var(--ac-radius)");
    expect(css).not.toContain("padding: 9px 10px");
  });

  it("分列表使用单色功能图标替代编号，不移动说明行", () => {
    for (const name of [
      "profile",
      "instructions",
      "chip",
      "plug",
      "search",
      "shield",
      "scope",
      "archive",
      "clock",
      "hand",
      "memory",
      "compress",
      "sliders",
      "chat",
    ]) {
      expect(app).toContain(`"${name}"`);
    }
    expect(app).toContain("const CONFIG_LIST_ICONS = {");
    expect(app).toContain("{t(listIcon ? label : title)}");
    expect(rule(".config-list-icon")).toContain("display: inline-flex");
    const icon = rule(".config-list-icon .icon");
    expect(icon).toContain("width: 18px");
    expect(icon).toContain("height: 18px");
    expect(icon).toContain("stroke-width: 1.7");
    expect(icon).toContain("fill: none");
    expect(icon).toContain("stroke-linecap: round");
    expect(rule(".config-list-icon")).not.toContain("background");
  });

  it("冻结上方当前助手与下方独立选择列表，基础信息复用白名单编辑器", () => {
    expect(app).toContain('id="current-assistant"');
    expect(app).toContain('className="shared-agent-selector agent-selector"');
    expect(app).toContain("onChange={(event) => chooseAgent(event.target.value)}");
    expect(app).not.toContain('className="agent-current-identity"');
    expect(app).toContain('className="agent-management-list"');
    expect(app).toContain("aria-pressed={editorAgentId === agent.id}");
    expect(app).toContain('aria-controls="superstring-agent-workspace"');
    expect(app).toMatch(/<SettingsPageEditor\s+page="basic"\s+embedded/);
    expect(rule(".agent-operation-fields")).toContain("border: 0");
    expect(
      rule(
        ".agent-management-list > li.is-current:has(.agent-management-choice:hover:not(:disabled))",
      ),
    ).toContain("box-shadow: var(--ac-selection-marker)");
    expect(app).not.toMatch(/className="agent-editor-list"[\s\S]{0,80}?role=/);
    expect(app).not.toContain('<details className="section-selector">');
    // The section rows must go through the dirty guard, never `setActiveSection`.
    expect(app).not.toContain("onClick={() => setActiveSection(item.key)}");
  });
});
