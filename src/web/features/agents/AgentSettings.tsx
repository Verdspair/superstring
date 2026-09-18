import { useEffect, useRef, useState } from "react";
import { NavigationConfirm } from "../../app/NavigationConfirm";
import { SettingsHeader } from "../../app/SettingsHeader";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { Chevron, Icon } from "../../ui/icons";
import { SectionB } from "../memory/SectionB";
import { SectionA } from "./SectionA";
import { SectionC } from "./SectionC";
import { SectionD } from "./SectionD";
import { SECTION_META } from "./sections";
import { UnavailableSection } from "./UnavailableSection";

export function AgentSettings() {
  const t = useI18n();
  const agents = useSuperstringStore((state) => state.agents);
  const editorAgentId = useSuperstringStore((state) => state.editorAgentId);
  const editorDraft = useSuperstringStore((state) => state.editorDraft);
  const activeSection = useSuperstringStore((state) => state.activeSection);
  const detailOpen = useSuperstringStore((state) => state.detailOpen);
  const modelNames = useSuperstringStore((state) => state.modelNames);
  const selectedNewSessionAgentId = useSuperstringStore((state) => state.selectedNewSessionAgentId);
  const setNewSessionAgent = useSuperstringStore((state) => state.setNewSessionAgent);
  const navigationConfirmOpen = useSuperstringStore((state) => state.navigationConfirmOpen);
  const feedback = useSuperstringStore((state) => state.feedback);
  const error = useSuperstringStore((state) => state.error);
  const closeAgentSettings = useSuperstringStore((state) => state.closeAgentSettings);
  const requestAgentNavigation = useSuperstringStore((state) => state.requestAgentNavigation);
  const requestSectionNavigation = useSuperstringStore((state) => state.requestSectionNavigation);
  const setDetailOpen = useSuperstringStore((state) => state.setDetailOpen);
  const patchDraft = useSuperstringStore((state) => state.patchDraft);
  const saveCurrentSection = useSuperstringStore((state) => state.saveCurrentSection);
  const deleteEditorAgent = useSuperstringStore((state) => state.deleteEditorAgent);
  const deleteAgents = useSuperstringStore((state) => state.deleteAgents);
  const setNotice = useSuperstringStore((state) => state.setNotice);
  const [selectedBatchAgents, setSelectedBatchAgents] = useState<string[]>([]);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const activeAgents = agents.filter((agent) => agent.is_active);
  const section = SECTION_META.find((item) => item.key === activeSection) ?? SECTION_META[0];
  const editorAgent = agents.find((agent) => agent.id === editorAgentId);
  const hasDraft = editorDraft !== null;
  const creating = editorAgentId === "__new__" && hasDraft;
  const editorAgentLabel = creating ? t("新建助手") : (editorAgent?.name ?? t("选择助手"));
  const selectorRef = useRef<HTMLDetailsElement>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (editorAgentId && hasDraft && selectorRef.current) selectorRef.current.open = false;
  }, [editorAgentId, hasDraft]);
  const chooseAgent = (id: string) => {
    if (id === editorAgentId && editorDraft && selectorRef.current)
      selectorRef.current.open = false;
    requestAgentNavigation(id);
  };
  const content = !editorDraft ? (
    <p className="empty-panel">{t("请选择已有助手，或点击“新建助手”。")}</p>
  ) : activeSection === "A" ? (
    <SectionA draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "B" ? (
    <SectionB draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "C" ? (
    <SectionC draft={editorDraft} patch={patchDraft} models={modelNames} />
  ) : activeSection === "D" ? (
    <SectionD draft={editorDraft} />
  ) : (
    <UnavailableSection section={activeSection as "E" | "F" | "G" | "H" | "knowledge"} />
  );
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={closeAgentSettings} />
      <div className="agent-settings">
        <div className="agent-settings-heading">
          <h2>{t("助手设置")}</h2>
          <button
            type="button"
            className="new-agent-button"
            disabled={creating || saving}
            onClick={() => chooseAgent("__new__")}
          >
            <Icon name="plus" />
            {t("新建助手")}
          </button>
        </div>
        <p className="settings-note">
          {t("各分区独立保存。新一轮使用已保存配置，失败重试沿用原轮配置。")}
        </p>
        <details className="agent-selector" ref={selectorRef}>
          <summary>
            <Icon name="agent" />
            <span className="selector-identity">
              <strong>{editorAgentLabel}</strong>
              <small>{creating ? t("正在创建 · 未保存") : t("当前助手")}</small>
            </span>
            <Chevron />
          </summary>
          <div className="agent-editor-list">
            {agents.length === 0 && (
              <p className="hint">{t("还没有助手，完成下方基础配置即可创建。")}</p>
            )}
            {agents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={editorAgentId === agent.id ? "active" : ""}
                aria-pressed={editorAgentId === agent.id}
                aria-controls="superstring-agent-workspace"
                onClick={() => chooseAgent(agent.id)}
              >
                <span>
                  {agent.name}
                  {agent.is_active ? "" : t("（停用）")}
                </span>
                <small>{editorAgentId === agent.id ? t("当前") : t("选择")}</small>
              </button>
            ))}
          </div>
          <div className="selector-extra">
            {activeAgents.length === 0 ? (
              <p className="hint">
                {t("当前没有启用的助手，新对话无法创建；请先启用或新建助手。")}
              </p>
            ) : (
              <Field
                label={t("新会话使用的助手")}
                info={t("只影响之后新建的对话；已有对话仍使用创建时绑定的助手。")}
              >
                <select
                  aria-label={t("新会话使用的助手")}
                  value={selectedNewSessionAgentId ?? ""}
                  onChange={(event) => setNewSessionAgent(event.target.value || null)}
                >
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          {editorAgentId !== "__new__" && (
            <button
              type="button"
              className="danger delete-agent"
              onClick={() => setConfirmSingleDelete(true)}
            >
              {t("删除当前 Agent")}
            </button>
          )}
        </details>
        <details
          className="detail-config"
          open={detailOpen}
          onToggle={(event) => setDetailOpen(event.currentTarget.open)}
        >
          <summary className="icon-summary">
            <Icon name="sliders" />
            <span className="settings-summary">
              <strong>{t("详细配置")}</strong>
              <small>{t("模型、记忆、上下文与性格人设")}</small>
            </span>
            <Chevron />
          </summary>
          <div className="detail-body" id="superstring-agent-workspace" aria-busy={saving}>
            {creating && (
              <p className="hint creation-note">
                {t("填写名称并选择模型，点击“创建助手”。创建后可继续设置记忆、上下文与人设。")}
              </p>
            )}
            <details className="section-selector">
              <summary>
                <span className="section-selector-label">
                  <Icon name={section.icon} />
                  <span>
                    {t("配置分区 · 当前：")}
                    {section.letter} · {t(section.title)}
                  </span>
                </span>
                <span className="section-selector-action">
                  <span className="section-selector-closed">{t("展开 A—I")}</span>
                  <span className="section-selector-open">{t("收起")}</span>
                  <Chevron />
                </span>
              </summary>
              <nav className="section-nav" aria-label={t("配置分区（A—I）")}>
                {SECTION_META.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={item.key === activeSection ? "active" : ""}
                    aria-pressed={item.key === activeSection}
                    disabled={creating && item.key !== "A"}
                    title={creating && item.key !== "A" ? t("创建助手后可配置") : undefined}
                    onClick={() => requestSectionNavigation(item.key)}
                  >
                    <span className="section-row-head">
                      <Icon name={item.icon} />
                      <strong>
                        {item.letter} · {t(item.title)}
                      </strong>
                    </span>
                    {item.note && <small>{t(item.note)}</small>}
                  </button>
                ))}
              </nav>
            </details>
            <div className="section-content">{content}</div>
            {["A", "B", "C"].includes(activeSection) && (
              <button
                type="button"
                className="primary save-section"
                disabled={!editorDraft || saving}
                onClick={async () => {
                  if (saving) return;
                  setSaving(true);
                  try {
                    await saveCurrentSection();
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving
                  ? creating
                    ? t("创建中…")
                    : t("保存中…")
                  : creating
                    ? t("创建助手")
                    : t("保存当前分区配置")}
              </button>
            )}
          </div>
        </details>
        <Accordion title={t("批量管理")} note={t("选择多个助手，批量删除。")} icon="users">
          <p className="hint">
            {t("选择多个 Agent 后可统一删除；不能删除的项目会保留并反馈原因。")}
          </p>
          <Field label={t("选择 Agent")}>
            <select
              multiple
              value={selectedBatchAgents}
              onChange={(event) =>
                setSelectedBatchAgents(
                  Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                )
              }
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.is_active ? "" : t("（停用）")}
                </option>
              ))}
            </select>
          </Field>
          <div className="memory-toolbar">
            <button
              type="button"
              onClick={() =>
                setSelectedBatchAgents((selected) => {
                  if (selected.length === agents.length) {
                    setNotice({ feedback: t("已取消全选") });
                    return [];
                  }
                  setNotice({
                    feedback: t("已选择 {0} 个 Agent", agents.length),
                  });
                  return agents.map((agent) => agent.id);
                })
              }
            >
              {t("全选 / 取消全选")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                selectedBatchAgents.length
                  ? setConfirmBatchDelete(true)
                  : setNotice({
                      feedback: t("请至少选择一个 Agent。"),
                    })
              }
            >
              {t("删除所选")}
            </button>
          </div>
        </Accordion>
        {confirmSingleDelete && (
          <ConfirmDialog
            message={t("确认删除当前 Agent？已被历史会话使用或属于内置默认配置时不会删除。")}
            confirmLabel={t("删除 Agent")}
            onCancel={() => setConfirmSingleDelete(false)}
            onConfirm={() => {
              setConfirmSingleDelete(false);
              void deleteEditorAgent();
            }}
          />
        )}
        {confirmBatchDelete && (
          <ConfirmDialog
            message={t(
              "确认删除选中的 {0} 个 Agent？已被历史会话使用或属于内置默认配置的项目会保留并反馈原因。",
              selectedBatchAgents.length,
            )}
            confirmLabel={t("删除所选")}
            onCancel={() => setConfirmBatchDelete(false)}
            onConfirm={() => {
              const ids = selectedBatchAgents;
              setConfirmBatchDelete(false);
              setSelectedBatchAgents([]);
              void deleteAgents(ids);
            }}
          />
        )}
        {navigationConfirmOpen && <NavigationConfirm />}
        {(feedback || error) && (
          <div className={error ? "status error" : "status"}>
            {translateNotice(error ?? feedback)}
          </div>
        )}
      </div>
    </section>
  );
}
