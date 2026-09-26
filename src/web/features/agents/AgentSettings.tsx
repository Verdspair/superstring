import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { NavigationConfirm } from "../../app/NavigationConfirm";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { Icon } from "../../ui/icons";
import { newPageEditor } from "./page-drafts";
import { SectionA } from "./SectionA";
import { SettingsPageEditor } from "./SettingsPageEditor";

export function AgentSettings() {
  const t = useI18n();
  const agents = useSuperstringStore((state) => state.agents);
  const editorAgentId = useSuperstringStore((state) => state.editorAgentId);
  const editorDraft = useSuperstringStore((state) => state.editorDraft);
  const selectedNewSessionAgentId = useSuperstringStore((state) => state.selectedNewSessionAgentId);
  const setNewSessionAgent = useSuperstringStore((state) => state.setNewSessionAgent);
  const navigationConfirmOpen = useSuperstringStore((state) => state.navigationConfirmOpen);
  const feedback = useSuperstringStore((state) => state.feedback);
  const error = useSuperstringStore((state) => state.error);
  const closeAgentSettings = useSuperstringStore((state) => state.closeAgentSettings);
  const requestAgentNavigation = useSuperstringStore((state) => state.requestAgentNavigation);
  const openSettingsRoute = useSuperstringStore((state) => state.openSettingsRoute);
  const patchDraft = useSuperstringStore((state) => state.patchDraft);
  const saveCurrentSection = useSuperstringStore((state) => state.saveCurrentSection);
  const deleteEditorAgent = useSuperstringStore((state) => state.deleteEditorAgent);
  const deleteAgents = useSuperstringStore((state) => state.deleteAgents);
  const [selectedBatchAgents, setSelectedBatchAgents] = useState<string[]>([]);
  const [confirmSingleDelete, setConfirmSingleDelete] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const activeAgents = agents.filter((agent) => agent.is_active);
  const editorAgent = agents.find((agent) => agent.id === editorAgentId);
  const creating = editorAgentId === "__new__" && editorDraft !== null;
  const pageEditor = useSuperstringStore((state) => state.pageEditor);
  const persona = useSuperstringStore((state) => state.persona);
  const loading = useSuperstringStore((state) => state.editorLoading || state.settingsSaving);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const busy = loading || saving || deleting;
  const selectedAgents = agents.filter((agent) => selectedBatchAgents.includes(agent.id));
  const selectedIds = selectedAgents.map((agent) => agent.id);
  const allSelected = agents.length > 0 && selectedIds.length === agents.length;
  useEffect(() => {
    const state = useSuperstringStore.getState();
    if (!pageEditor && !state.dirty && persona && editorAgent && !creating) {
      useSuperstringStore.setState({
        pageEditor: newPageEditor(editorAgent, persona, state.policy),
      });
    }
  }, [pageEditor, persona, editorAgent, creating]);
  useEffect(() => {
    const state = useSuperstringStore.getState();
    if (!state.editorDraft && !state.editorLoading && !state.error) {
      const target =
        state.agents.find((agent) => agent.id === state.selectedNewSessionAgentId)?.id ??
        state.agents[0]?.id ??
        "__new__";
      void state.editAgent(target);
    }
  }, []);
  const chooseAgent = (id: string) => requestAgentNavigation(id);
  const newSessionControl = (
    <div className="agent-session-choice min-w-0">
      {activeAgents.length === 0 ? (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("当前没有启用的助手，新对话无法创建；请先启用或新建助手。")}
        </p>
      ) : (
        <Field label={t("新会话使用的助手")} info={t("仅用于新会话；已有会话绑定不变。")}>
          <NativeSelect
            className="w-full"
            aria-label={t("新会话使用的助手")}
            value={selectedNewSessionAgentId ?? ""}
            disabled={busy}
            onChange={(event) => setNewSessionAgent(event.target.value || null)}
          >
            {activeAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
    </div>
  );
  return (
    <section className="page settings-page flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <SettingsHeader onBack={closeAgentSettings} />
      <SettingsBody>
        <div className="agent-settings min-w-0 space-y-6">
          <div className="shared-agent-selector agent-selector flex flex-wrap items-start gap-4 rounded-xl border bg-card p-5 [&>svg]:mt-1 [&>svg]:size-5 [&>svg]:text-muted-foreground [&>.field]:min-w-0 [&>.field]:flex-1">
            <Icon name="agent" />
            <Field
              label={t("正在配置的助手")}
              info={t("仅切换设置对象，不改变当前对话或新会话助手。")}
            >
              <NativeSelect
                className="w-full"
                aria-label={t("正在配置的助手")}
                aria-controls="superstring-agent-workspace"
                value={editorDraft ? editorAgentId : ""}
                disabled={busy}
                onChange={(event) => chooseAgent(event.target.value)}
              >
                <option value="" disabled>
                  {t("选择助手")}
                </option>
                {creating && <option value="__new__">{t("正在创建 · 未保存")}</option>}
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.is_active ? "" : t("（停用）")}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {error && !editorDraft && agents.length > 0 && (
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => chooseAgent(agents[0].id)}
              >
                {t("重试读取助手")}
              </Button>
            )}
          </div>
          <div className="agent-settings-heading flex flex-wrap items-start justify-between gap-4">
            <Button
              variant="outline"
              type="button"
              className="new-agent-button gap-2"
              disabled={creating || busy}
              onClick={() => chooseAgent("__new__")}
            >
              <Icon name="plus" />
              {t("新建助手")}
            </Button>
          </div>
          <p className="settings-note text-sm leading-relaxed text-muted-foreground">
            {t("用下拉框或列表切换编辑对象。")}
          </p>
          <SettingsGroup id="current-assistant" title="当前助手" note="名称、描述与启用状态。">
            {loading && (
              <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
                {t("正在读取助手配置…")}
              </p>
            )}
            <fieldset className="agent-operation-fields min-w-0 space-y-6" disabled={busy}>
              <div id="superstring-agent-workspace" aria-busy={busy}>
                {creating && editorDraft ? (
                  <>
                    <p className="hint creation-note text-sm leading-relaxed text-muted-foreground">
                      {t("填写名称、选择模型后创建；记忆、上下文与人设可在创建后设置。")}
                    </p>
                    <SectionA draft={editorDraft} patch={patchDraft} />
                    {newSessionControl}
                    <Button
                      variant="default"
                      type="button"
                      className="primary save-section mt-6"
                      disabled={busy}
                      onClick={async () => {
                        if (busy) return;
                        setSaving(true);
                        try {
                          await saveCurrentSection();
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {t(saving ? "创建中…" : "创建助手")}
                    </Button>
                  </>
                ) : !editorDraft || !pageEditor ? (
                  <>
                    <p className="empty-panel rounded-xl border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
                      {t("请选择已有助手，或点击“新建助手”。")}
                    </p>
                    {newSessionControl}
                  </>
                ) : (
                  <SettingsPageEditor
                    page="basic"
                    embedded
                    actions={
                      <Button
                        variant="destructive"
                        type="button"
                        className="danger delete-agent mt-4"
                        disabled={!editorAgent || busy}
                        onClick={() => setConfirmSingleDelete(true)}
                      >
                        {t("删除当前 Agent")}
                      </Button>
                    }
                  >
                    <div className="agent-usage-grid grid gap-6 lg:grid-cols-2">
                      <div className="agent-model-summary flex min-w-0 flex-col items-start gap-2">
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => openSettingsRoute("models")}
                        >
                          <Icon name="chip" />
                          {t("设置使用模型")}
                        </Button>
                        <small className="hint text-sm leading-relaxed text-muted-foreground">
                          {t("前往默认模型页设置；本页草稿保留。")}
                        </small>
                      </div>
                      {newSessionControl}
                    </div>
                  </SettingsPageEditor>
                )}
              </div>
            </fieldset>
          </SettingsGroup>
          <SettingsGroup
            id="all-assistants"
            title="所有助手"
            note="点击助手查看并编辑；勾选框仅用于批量删除。"
          >
            <ul
              className="agent-management-list divide-y rounded-xl border bg-card"
              aria-label={t("助手列表")}
            >
              {agents.map((agent) => (
                <li
                  key={agent.id}
                  className={`flex items-center gap-3 p-3 ${editorAgentId === agent.id ? "is-current bg-accent/50" : ""}`}
                >
                  <Checkbox
                    aria-label={t("选择助手：{0}", agent.name)}
                    checked={selectedIds.includes(agent.id)}
                    disabled={busy}
                    onCheckedChange={(checkedValue) => {
                      const checked = checkedValue === true;
                      setSelectedBatchAgents((ids) =>
                        checked
                          ? [...ids.filter((id) => id !== agent.id), agent.id]
                          : ids.filter((id) => id !== agent.id),
                      );
                    }}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    className="agent-management-choice h-auto min-w-0 flex-1 flex-col items-start justify-start whitespace-normal px-2 py-3 text-left"
                    aria-label={t("编辑助手：{0}", agent.name)}
                    aria-pressed={editorAgentId === agent.id}
                    aria-controls="superstring-agent-workspace"
                    disabled={busy}
                    onClick={() => chooseAgent(agent.id)}
                  >
                    <span className="agent-row-heading flex flex-wrap items-baseline gap-x-3 gap-y-1 [&>strong]:font-semibold">
                      <strong>{agent.name}</strong>
                      <span className="agent-state text-xs font-normal text-muted-foreground">
                        {t(agent.is_active ? "启用" : "停用")}
                      </span>
                      {editorAgentId === agent.id && (
                        <span className="agent-state text-xs font-normal text-muted-foreground">
                          {t("当前选中")}
                        </span>
                      )}
                      {selectedNewSessionAgentId === agent.id && (
                        <span className="agent-state text-xs font-normal text-muted-foreground">
                          {t("新会话助手")}
                        </span>
                      )}
                    </span>
                    <span className="agent-row-description mt-1 block whitespace-pre-wrap text-sm font-normal text-muted-foreground">
                      {agent.description || t("暂无描述")}
                    </span>
                    <small>
                      {t("对话模型")}：{agent.model_name}
                    </small>
                  </Button>
                </li>
              ))}
            </ul>
            {agents.length === 0 && (
              <p className="hint text-sm leading-relaxed text-muted-foreground">
                {t("暂无助手，请先新建助手。")}
              </p>
            )}
            <div className="agent-batch-toolbar flex flex-wrap items-center gap-2 [&>.hint]:mr-auto">
              <span className="hint text-sm leading-relaxed text-muted-foreground" role="status">
                {t("已选 {0} / {1} 个助手", selectedIds.length, agents.length)}
              </span>
              <Button
                variant="outline"
                type="button"
                disabled={busy || agents.length === 0}
                onClick={() =>
                  setSelectedBatchAgents(allSelected ? [] : agents.map((agent) => agent.id))
                }
              >
                {t(allSelected ? "取消全选" : "全选")}
              </Button>
              <Button
                variant="destructive"
                type="button"
                className="danger"
                disabled={busy || selectedIds.length === 0}
                onClick={() => setConfirmBatchDelete(true)}
              >
                {t("删除所选")}
              </Button>
            </div>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("无法删除的助手会保留，并显示原因。")}
            </p>
          </SettingsGroup>
          {confirmSingleDelete && editorAgent && (
            <ConfirmDialog
              message={t(
                "确认删除助手「{0}」？已被历史会话使用或属于内置默认配置时不会删除。",
                editorAgent.name,
              )}
              confirmLabel={t("删除 Agent")}
              onCancel={() => setConfirmSingleDelete(false)}
              onConfirm={async () => {
                if (busy) return;
                setConfirmSingleDelete(false);
                setDeleting(true);
                try {
                  await deleteEditorAgent();
                } finally {
                  setDeleting(false);
                }
              }}
            />
          )}
          {confirmBatchDelete && (
            <ConfirmDialog
              message={`${t("确认删除选中的 {0} 个 Agent？已被历史会话使用或属于内置默认配置的项目会保留并反馈原因。", selectedIds.length)} ${t("删除对象：{0}", selectedAgents.map((agent) => agent.name).join(" / "))}`}
              confirmLabel={t("删除所选")}
              onCancel={() => setConfirmBatchDelete(false)}
              onConfirm={async () => {
                if (busy || selectedIds.length === 0) return;
                setConfirmBatchDelete(false);
                setDeleting(true);
                try {
                  await deleteAgents(selectedIds);
                } finally {
                  setSelectedBatchAgents([]);
                  setDeleting(false);
                }
              }}
            />
          )}
          {navigationConfirmOpen && <NavigationConfirm />}
          {(feedback || error) && (
            <Alert variant={error ? "destructive" : "default"} role={error ? "alert" : "status"}>
              <AlertDescription>{translateNotice(error ?? feedback)}</AlertDescription>
            </Alert>
          )}
        </div>
      </SettingsBody>
    </section>
  );
}
