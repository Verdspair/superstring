import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ChatModelFields } from "../features/agents/ChatModelFields";
import { isEditablePage, newPageEditor } from "../features/agents/page-drafts";
import { SettingsPageEditor } from "../features/agents/SettingsPageEditor";
import { KnowledgeModelPage } from "../features/knowledge/KnowledgeModelPage";
import { KnowledgeReadPage } from "../features/knowledge/KnowledgeReadPage";
import { KnowledgeSettings } from "../features/knowledge/KnowledgeSettings";
import { OrganizationModelPage } from "../features/knowledge/OrganizationModelPage";
import { ExternalApiSettings } from "../features/models/ExternalApiSettings";
import { QqJudgementModelPage } from "../features/qq/QqJudgementModelPage";
import { QqStorageSettings } from "../features/qq/QqStorageSettings";
import { SchemeSettings } from "../features/qq/SchemeSettings";
import { StickerLibrary } from "../features/qq/StickerLibrary";
import { translateNotice, useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { SettingsGroup } from "../ui/Accordion";
import { Field } from "../ui/Field";
import { Icon } from "../ui/icons";
import { NavigationConfirm } from "./NavigationConfirm";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsBody } from "./SettingsSidebar";
import { settingsRoute } from "./settings-routes";

export function SettingsWorkspace() {
  const t = useI18n();
  const routeId = useSuperstringStore((s) => s.settingsRoute);
  const agents = useSuperstringStore((s) => s.agents);
  const editorId = useSuperstringStore((s) => s.editorAgentId);
  const draft = useSuperstringStore((s) => s.editorDraft);
  const loading = useSuperstringStore(
    (s) => s.editorLoading || s.settingsSaving || s.knowledgeReadLoading,
  );
  const pageEditor = useSuperstringStore((s) => s.pageEditor);
  const persona = useSuperstringStore((s) => s.persona);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const confirm = useSuperstringStore((s) => s.navigationConfirmOpen);
  const requestAgent = useSuperstringStore((s) => s.requestAgentNavigation);
  const navigate = useSuperstringStore((s) => s.requestPageNavigation);
  const refreshModels = useSuperstringStore((s) => s.refreshModels);
  const modelStatus = useSuperstringStore((s) => s.modelStatus);
  const models = useSuperstringStore((s) => s.modelNames);
  const patchDraft = useSuperstringStore((s) => s.patchDraft);
  const meta = settingsRoute(routeId);
  const management =
    routeId === "management" || routeId === "models" || routeId === "knowledge-model";
  const knowledge = routeId === "knowledge-config";
  // The QQ pages (sticker library, chat schemes) are QQ-global: they have no assistant to
  // configure, and they report their own errors and notices inside their own flow (§3.3's
  // document-flow rule) rather than at the bottom of the workspace.
  // 外部模型 API 是应用级资源：它不随助手切换，所以和 QQ 各页一样不渲染助手选择器（0032）。
  const externalApi = routeId === "external-api";
  const stickers = routeId === "qq-stickers";
  const schemes = routeId === "qq-scheme-config";
  const storage = routeId === "qq-storage";
  // The QQ surfaces are global too: no assistant to switch, and the selector above them would
  // suggest otherwise. 运行模式 is its own view (App.tsx), so it is not part of this list.
  const globalQq = stickers || schemes || storage || externalApi;
  useEffect(() => {
    const state = useSuperstringStore.getState();
    if (!pageEditor && !state.dirty && persona && editorId !== "__new__") {
      const agent = state.agents.find((a) => a.id === editorId);
      if (agent)
        useSuperstringStore.setState({
          pageEditor: newPageEditor(agent, persona, state.policy),
        });
    }
  }, [editorId, pageEditor, persona]);
  useEffect(() => {
    const state = useSuperstringStore.getState();
    if (state.editorDraft || state.editorLoading || state.error) return;
    const target =
      state.agents.find((a) => a.id === state.selectedNewSessionAgentId)?.id ?? state.agents[0]?.id;
    if (target) void state.editAgent(target);
  }, []);
  const openOverview = () => useSuperstringStore.getState().openAgentSettings();
  const selector = (
    <div className="shared-agent-selector agent-selector mb-6 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-4 [&>svg]:size-5 [&>label]:min-w-48 [&>label]:flex-1">
      <Icon name="agent" />
      <Field label={t("正在配置的助手")} info={t("仅切换设置对象，不改变当前对话或新会话助手。")}>
        <NativeSelect
          className="w-full"
          aria-label={t("正在配置的助手")}
          value={draft ? editorId : ""}
          disabled={loading}
          onChange={(e) => requestAgent(e.target.value)}
        >
          <option value="" disabled>
            {t("选择助手")}
          </option>
          {editorId === "__new__" && draft && (
            <option value="__new__">{t("正在创建 · 未保存")}</option>
          )}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {agent.is_active ? "" : t("（停用）")}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {!agents.length && (
        <Button variant="outline" type="button" onClick={() => openOverview()}>
          {t("新建助手")}
        </Button>
      )}
      {loading && <p role="status">{t("正在读取助手配置…")}</p>}
      {error && !draft && agents.length > 0 && (
        <Button
          variant="outline"
          type="button"
          disabled={loading}
          onClick={() => requestAgent(agents[0].id)}
        >
          {t("重试读取助手")}
        </Button>
      )}
    </div>
  );
  return (
    <section className="page settings-page flex h-full min-h-0 flex-col">
      <SettingsHeader onBack={() => navigate("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content settings-workspace agent-settings space-y-6">
          {!globalQq && selector}
          <div className="detail-config workspace-detail min-w-0">
            <div className="detail-body min-w-0">
              <div className="config-section workspace-config space-y-6">
                {management ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t("统一管理全部用途模型；全局默认、知识库与当前助手分别保存。")}
                    </p>
                    <div className="model-page-toolbar flex flex-wrap items-center gap-3">
                      <Button
                        variant="outline"
                        type="button"
                        disabled={loading}
                        onClick={() => void refreshModels()}
                      >
                        {t("刷新模型列表")}
                      </Button>
                      <span className="hint text-sm text-muted-foreground">
                        {translateNotice(modelStatus)}
                      </span>
                    </div>
                    <nav
                      className="workspace-anchors flex flex-wrap gap-x-5 gap-y-2 border-b pb-4 text-sm text-primary [&_a]:underline-offset-4 [&_a:hover]:underline"
                      aria-label={t("模型分区跳转")}
                    >
                      <a href="#organization-default">{t("共同整理默认值")}</a>
                      <a href="#qq-judgement-model">{t("QQ 判断模型")}</a>
                      <a href="#assistant-models">{t("当前助手模型")}</a>
                      <a href="#knowledge-model">{t("知识库整理模型")}</a>
                    </nav>
                    <OrganizationModelPage />
                    <QqJudgementModelPage />
                    <section
                      id="assistant-models"
                      className="assistant-model-section space-y-4 rounded-xl border p-4 [&>h3]:font-medium"
                      aria-label={t("当前助手模型")}
                    >
                      <h3>{t("当前助手模型")}</h3>
                      {editorId === "__new__" && draft ? (
                        <fieldset disabled={loading}>
                          <p className="hint text-sm text-muted-foreground">
                            {t("新助手模型暂存为草稿，创建时一并保存。")}
                          </p>
                          <ChatModelFields
                            draft={draft}
                            models={models}
                            patch={patchDraft}
                            disabled={loading}
                          />
                          <Button variant="outline" type="button" onClick={openOverview}>
                            {t("返回助手管理继续创建")}
                          </Button>
                        </fieldset>
                      ) : (
                        <SettingsPageEditor page="models" compact />
                      )}
                    </section>
                    <KnowledgeModelPage scope="model" />
                  </>
                ) : knowledge ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t("助手读取、全局整理、资料授权分别配置与保存。")}
                    </p>
                    <nav
                      className="workspace-anchors flex flex-wrap gap-x-5 gap-y-2 border-b pb-4 text-sm text-primary [&_a]:underline-offset-4 [&_a:hover]:underline"
                      aria-label={t("知识库分区跳转")}
                    >
                      <a href="#knowledge-assistant">{t("当前助手读取配置")}</a>
                      <a href="#knowledge-global">{t("全局整理与预算")}</a>
                      <a href="#knowledge-library">{t("资料与分类管理")}</a>
                    </nav>
                    <SettingsGroup
                      id="knowledge-assistant"
                      title="当前助手读取配置"
                      note="仅影响所选助手；读取范围不会授予新权限。"
                    >
                      <KnowledgeReadPage />
                    </SettingsGroup>
                    <KnowledgeModelPage />
                    <SettingsGroup
                      id="knowledge-library"
                      title="资料与分类管理"
                      note="全局资料、分类与授权，不随当前助手切换。"
                    >
                      <KnowledgeSettings embedded />
                    </SettingsGroup>
                  </>
                ) : externalApi ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t(meta?.note ?? "")}
                    </p>
                    <ExternalApiSettings />
                  </>
                ) : stickers ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t(meta?.note ?? "")}
                    </p>
                    <StickerLibrary />
                  </>
                ) : schemes ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t(meta?.note ?? "")}
                    </p>
                    <SchemeSettings />
                  </>
                ) : storage ? (
                  <>
                    <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                      {t(meta?.note ?? "")}
                    </p>
                    <QqStorageSettings />
                  </>
                ) : (
                  meta && (
                    <>
                      <p className="settings-note text-sm leading-relaxed text-muted-foreground">
                        {t(meta.note)}
                      </p>
                      {isEditablePage(routeId) ? (
                        <SettingsPageEditor page={routeId} />
                      ) : meta.state === "unavailable" ? (
                        <p className="hint text-sm text-muted-foreground">{t("状态：暂未开放")}</p>
                      ) : (
                        <Button
                          variant="outline"
                          type="button"
                          disabled={loading}
                          onClick={() => openOverview()}
                        >
                          {t("打开原配置")}
                        </Button>
                      )}
                    </>
                  )
                )}
                {(management || knowledge) && feedback && (
                  <p
                    className="hint workspace-feedback text-sm text-muted-foreground"
                    role="status"
                  >
                    {translateNotice(feedback)}
                  </p>
                )}
                {error && !globalQq && (
                  <p role="alert" className="error text-sm text-destructive">
                    {translateNotice(error)}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </SettingsBody>
      {confirm && <NavigationConfirm />}
    </section>
  );
}
