import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { PersonaResponse } from "../../../shared/contracts";
import { translateNotice, useI18n } from "../../i18n";
import type { AgentDraft } from "../../state/types";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { SectionB } from "../memory/SectionB";
import { ModelUseHint } from "../models/ModelUseHint";
import { ChatModelFields } from "./ChatModelFields";
import { MemoryPageFields } from "./MemoryPageFields";
import { dirtyPages, type EditablePage } from "./page-drafts";

const GROUPS = {
  "long-memory": [
    ["memory-management", "记忆管理"],
    ["retrieval", "读取配置"],
    ["consolidation", "整理配置"],
    ["policy", "自动整理"],
  ],
  context: [
    ["budget", "容量与预算"],
    ["compression", "压缩与读取摘要策略"],
  ],
  basic: [["information", "基础信息"]],
  models: [
    ["chat-model", "对话模型"],
    ["memory-models", "记忆模型"],
    ["context-model", "上下文压缩模型"],
  ],
  identity: [
    ["identity", "身份与行为"],
    ["additional", "补充指令"],
  ],
  expression: [
    ["style", "沟通风格"],
    ["examples", "示例对话"],
    ["intensity", "性格强度"],
  ],
} as const;

export function SettingsPageEditor({
  page,
  compact = false,
  embedded = false,
  children,
  actions,
}: {
  page: EditablePage;
  compact?: boolean;
  embedded?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const t = useI18n();
  const editor = useSuperstringStore((s) => s.pageEditor);
  const loading = useSuperstringStore((s) => s.editorLoading);
  const saving = useSuperstringStore((s) => s.settingsSaving);
  const models = useSuperstringStore((s) => s.modelNames);
  const modelStatus = useSuperstringStore((s) => s.modelStatus);
  const feedback = useSuperstringStore((s) => s.feedback);
  const patchAgent = useSuperstringStore((s) => s.patchPageAgent);
  const patchPersona = useSuperstringStore((s) => s.patchPagePersona);
  const save = useSuperstringStore((s) => s.saveSettingsPage);
  const refreshModels = useSuperstringStore((s) => s.refreshModels);
  if (!editor)
    return (
      <p className="hint text-sm leading-relaxed text-muted-foreground">
        {t("选择已有助手，或前往助手管理新建。")}
      </p>
    );
  const draft = editor.draft;
  const dirty = dirtyPages(editor);
  const patch = (value: Partial<AgentDraft>) => patchAgent(page, value);
  const group = (id: string, title: string, children: ReactNode) =>
    embedded ? (
      <div className="space-y-5" id={`settings-${id}`}>
        {children}
      </div>
    ) : (
      <SettingsGroup
        id={`settings-${id}`}
        title={title}
        note={page === "basic" ? "名称、描述与启用状态。" : undefined}
      >
        {children}
      </SettingsGroup>
    );
  const personaField = (key: keyof PersonaResponse, label: string, info?: string) => (
    <Field label={t(label)} info={info ? t(info) : undefined}>
      <Textarea
        aria-label={t(label)}
        rows={5}
        value={editor.personaDraft[key]}
        onChange={(e) => patchPersona(page, { [key]: e.target.value })}
      />
    </Field>
  );
  const modelField = (
    key:
      | "model_name"
      | "memory_retrieval_model_name"
      | "memory_consolidation_model_name"
      | "context_compression_model_name",
    label: string,
  ) => {
    const value = draft[key];
    const options = [...new Set([...models, ...(value ? [value] : [])])];
    return (
      <Field
        label={t(label)}
        info={t(
          key === "memory_consolidation_model_name"
            ? "优先使用助手指定模型；未指定则继承共同默认。"
            : key === "model_name"
              ? "仅用于当前助手的对话；不会自动加载或重载模型。"
              : "跟随对话模型或另选模型；不会自动加载或重载。",
        )}
      >
        <NativeSelect
          className="w-full"
          aria-label={t(label)}
          value={value ?? "__follow__"}
          onChange={(e) =>
            patch({
              [key]: e.target.value === "__follow__" ? null : e.target.value,
            })
          }
        >
          {key !== "model_name" && (
            <option value="__follow__">
              {t(key === "memory_consolidation_model_name" ? "继承默认模型" : "跟随对话模型")}
            </option>
          )}
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
        <ModelUseHint
          purpose={
            key === "memory_consolidation_model_name"
              ? "memory_organization"
              : key === "memory_retrieval_model_name"
                ? "retrieval"
                : key === "context_compression_model_name"
                  ? "compression"
                  : "chat"
          }
          configured={value}
          saved={editor.agent[key]}
          chatModel={draft.model_name}
          savedChatModel={editor.agent.model_name}
        />
      </Field>
    );
  };
  const saveButton = (
    <Button
      variant="default"
      type="button"
      className="primary"
      disabled={!dirty.includes(page)}
      onClick={() => void save(page)}
    >
      {t(saving ? "正在保存页面…" : compact ? "保存当前助手模型" : "保存当前页")}
    </Button>
  );
  return (
    <div className="page-editor min-w-0 space-y-6">
      {!compact && !embedded && (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("仅影响当前助手；切页保留草稿，按页保存，下一新轮生效。")}
        </p>
      )}
      {!compact && !embedded && (
        <nav
          className="workspace-anchors flex flex-wrap gap-2 border-b pb-4 [&>a]:rounded-md [&>a]:px-3 [&>a]:py-2 [&>a]:text-xs [&>a]:text-muted-foreground [&>a:hover]:bg-accent [&>a:hover]:text-accent-foreground"
          aria-label={t("本页快捷跳转")}
        >
          {GROUPS[page].map(([id, title]) => (
            <a key={id} href={`#settings-${id}`}>
              {t(title)}
            </a>
          ))}
        </nav>
      )}
      {page === "long-memory" && <SectionB key={editor.agent.id} />}
      <fieldset className="min-w-0 space-y-5" disabled={loading || saving}>
        {(page === "long-memory" || page === "context") && <MemoryPageFields page={page} />}
        {page === "basic" &&
          group(
            "information",
            "基础信息",
            <>
              <Field label={t("助手名称")}>
                <Input
                  aria-label={t("助手名称")}
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label={t("描述")} info={t("仅供识别，不影响回复。")}>
                <Textarea
                  aria-label={t("描述")}
                  rows={3}
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </Field>
              <Label className="check flex items-start gap-3 text-sm [&>span]:grid [&>span]:gap-1 [&_small]:text-muted-foreground [&_small]:font-normal">
                <Checkbox
                  aria-label={t("启用当前 Agent")}
                  checked={draft.is_active}
                  onCheckedChange={(checkedValue) => patch({ is_active: checkedValue === true })}
                />
                <span>
                  <strong>{t("启用当前 Agent")}</strong>
                  <small>{t("停用并保存后，新会话不可选；已有会话不受影响。")}</small>
                </span>
              </Label>
            </>,
          )}
        {page === "models" && (
          <>
            <ChatModelFields
              draft={draft}
              models={models}
              patch={patch}
              disabled={loading || saving}
            />
            {!compact && !embedded && (
              <>
                <Button variant="outline" type="button" onClick={() => void refreshModels()}>
                  {t("刷新模型列表")}
                </Button>
                <p className="hint text-sm leading-relaxed text-muted-foreground">
                  {translateNotice(modelStatus)}
                </p>
              </>
            )}
            {group(
              "memory-models",
              "记忆模型",
              <>
                {modelField("memory_retrieval_model_name", "记忆读取模型")}
                {modelField("memory_consolidation_model_name", "记忆整理模型")}
              </>,
            )}
            {group(
              "context-model",
              "上下文压缩模型",
              modelField("context_compression_model_name", "上下文压缩模型"),
            )}
          </>
        )}
        {page === "identity" && (
          <>
            {group(
              "identity",
              "身份与行为",
              <>
                {personaField("core_identity", "核心身份", "助手的角色与目标，建议 100—400 字。")}
                {personaField(
                  "interaction_boundaries",
                  "互动边界",
                  "不能做的事、需拒绝的请求及回应方式。",
                )}
                {personaField("advanced_instructions", "高级指令", "对全部行为都生效的补充规则。")}
              </>,
            )}
            {group(
              "additional",
              "补充指令",
              <Field label={t("补充指令")} info={t("追加到人设与性格之后，影响该助手的回复。")}>
                <Textarea
                  aria-label={t("补充指令")}
                  rows={5}
                  value={draft.additional_instructions}
                  onChange={(e) => patch({ additional_instructions: e.target.value })}
                />
              </Field>,
            )}
          </>
        )}
        {page === "expression" && (
          <>
            {group(
              "style",
              "沟通风格",
              personaField("communication_style", "沟通风格", "语气、节奏、用词习惯、称呼方式。"),
            )}
            {group(
              "examples",
              "示例对话",
              personaField(
                "example_dialogues",
                "示例对话",
                "仅示范语气与节奏，不复用样例中的人名、事实和话题。",
              ),
            )}
            {group(
              "intensity",
              "性格强度",
              <Field
                label={t("性格强度")}
                info={t("0 不注入性格，100 完整注入；身份与边界不受影响。")}
              >
                <div className="range-row grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-4 [&>output]:text-center [&>output]:text-sm [&>output]:tabular-nums [&>output]:text-muted-foreground">
                  <Slider
                    aria-label={t("性格强度")}
                    disabled={loading || saving}
                    min={0}
                    max={100}
                    step={5}
                    value={[draft.persona_intensity]}
                    onValueChange={(values) => patch({ persona_intensity: Number(values[0]) })}
                  />
                  <output>{draft.persona_intensity}</output>
                </div>
              </Field>,
            )}
          </>
        )}
        {children}
        {embedded ? (
          <div className="scope-save-row flex flex-wrap items-center gap-3 border-t pt-4">
            {saveButton}
            {actions}
          </div>
        ) : (
          saveButton
        )}
      </fieldset>
      <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
        {t(dirty.includes(page) ? "当前页有未保存修改" : "当前页已保存")}
        {dirty.length > 0 && ` · ${t("共 {0} 个页面未保存", dirty.length)}`}
      </p>
      {!compact && !embedded && feedback && (
        <p role="status" className="hint text-sm leading-relaxed text-muted-foreground">
          {translateNotice(feedback)}
        </p>
      )}
    </div>
  );
}
