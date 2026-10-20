import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Trans } from "react-i18next";
import type {
  AgentAuxiliaryAllocation,
  AuxiliaryAllocationProfile,
  GlobalAuxiliaryAllocation,
} from "../../../shared/contracts/context-allocation";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../../components/ui/native-select";

export interface ContextAllocationAuxiliaryProps {
  scope?: "agent" | "global" | "all";
  agentProfiles?: AgentAuxiliaryAllocation;
  globalProfiles?: GlobalAuxiliaryAllocation;
  onAgentChange?: (next: AgentAuxiliaryAllocation) => void;
  onGlobalChange?: (next: GlobalAuxiliaryAllocation) => void;
  onSaveAgent?: () => Promise<void> | void;
  onSaveGlobal?: () => Promise<void> | void;
  /** 主机提供时在全局分配卡片内提供放弃入口；范围由主机自己决定（如仅 QQ 两个角色）。 */
  onDiscardGlobal?: () => void;
  canDiscardGlobal?: boolean;
  onValidityChange?: (validity: { agentValid: boolean; globalValid: boolean }) => void;
  invalidInputs?: Record<string, string>;
  onInvalidInput?: (key: string, raw: string | undefined) => void;
  savingAgent?: boolean;
  savingGlobal?: boolean;
  canSaveAgent?: boolean;
  canSaveGlobal?: boolean;
  roleDetails?: Record<string, ReactNode>;
  agentName?: string;
  readOnly?: boolean;
  labels?: Partial<Record<string, string>>;
  /** 只渲染/校验所选的全局辅助角色；缺省渲染全部三个（Agent3 不受影响）。 */
  globalRoles?: readonly (keyof GlobalAuxiliaryAllocation)[];
}

type AgentRoleKey = keyof AgentAuxiliaryAllocation;
type GlobalRoleKey = keyof GlobalAuxiliaryAllocation;

interface RoleMeta {
  key: string;
  name: string;
  description: string;
  inputUnitDesc: string;
  outputDesc: string;
}

const AGENT_ROLES: RoleMeta[] = [
  {
    key: "memory_consolidate",
    name: "记忆整理 (memory_consolidate)",
    description: "后台归纳与压缩对话事实记忆，包含提炼与去重判断。",
    inputUnitDesc: "估算消息与 Schema 字节/字符量 (非截断，超限报错)",
    outputDesc: "模型硬上限 max_tokens (Consolidation & Suppression 共用)",
  },
  {
    key: "memory_retrieval_select",
    name: "记忆检索选材 (memory_retrieval_select)",
    description: "多候选记忆条目的相关性过滤与排序任务。",
    inputUnitDesc: "候选批次估算输入上限 (字节)",
    outputDesc: "单次决策输出 max_tokens",
  },
  {
    key: "research",
    name: "研究子任务 (research)",
    description: "深度探索与外部资料汇总分析的子代理调用。",
    inputUnitDesc: "问题材料预处理上限",
    outputDesc: "最终结论生成的硬预留 max_tokens",
  },
];

const GLOBAL_ROLES: RoleMeta[] = [
  {
    key: "knowledge_organize",
    name: "知识库整理 (knowledge_organize)",
    description: "知识分段、语义清洗及结构化提炼。",
    inputUnitDesc: "分段文本估算字节数 (固定时硬顶，自动时跟随容量)",
    outputDesc: "整理结果硬上限 max_tokens (默认 min(2048, cap/4))",
  },
  {
    key: "qq_sticker_annotate",
    name: "表情标注 (qq_sticker_annotate)",
    description: "QQ 动图/静态表情视觉理解与文本标注任务。",
    inputUnitDesc: "仅提示词文本估算 (视觉图片原生开销未知)",
    outputDesc: "标注生成硬预留 max_tokens",
  },
  {
    key: "qq_media_describe",
    name: "媒体描述 (qq_media_describe)",
    description: "QQ 传入图片或视频抽帧的多模态描述生成。",
    inputUnitDesc: "采样帧与提示词文本估算 (图片开销未知)",
    outputDesc: "描述生成硬预留 max_tokens",
  },
];

function parsePositiveIntOrNull(raw: string): { valid: boolean; value: number | null | undefined } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { valid: true, value: undefined }; // unconfigured/inherit
  }
  if (trimmed === "null" || trimmed === "-") {
    return { valid: true, value: null };
  }
  const num = Number(trimmed);
  if (Number.isInteger(num) && num > 0) {
    return { valid: true, value: num };
  }
  return { valid: false, value: undefined };
}

// The host screen owns the raw text of invalid inputs in its own map. A key present there wins over
// the panel-local draft, so an invalid value survives re-render and remount, and validity cannot be
// hidden by switching scope.
const invalidRawFor = (invalidInputs: Record<string, string> | undefined, key: string) =>
  invalidInputs?.[key];

interface RawDraftState {
  [roleAndField: string]: string;
}

const renderFallback = (val: number | null | undefined): string => {
  if (val === null) return "null";
  if (val === undefined) return "";
  return String(val);
};

export function ContextAllocationAuxiliary({
  scope = "all",
  agentProfiles = {},
  globalProfiles = {},
  onAgentChange,
  onGlobalChange,
  onSaveAgent,
  onSaveGlobal,
  onDiscardGlobal,
  canDiscardGlobal = false,
  onValidityChange,
  invalidInputs,
  onInvalidInput,
  savingAgent = false,
  savingGlobal = false,
  canSaveAgent = true,
  canSaveGlobal = true,
  roleDetails,
  agentName,
  readOnly = false,
  labels = {},
  globalRoles,
}: ContextAllocationAuxiliaryProps) {
  // Track raw drafts for inputs to allow temporary invalid/typing states without clobbering
  const [rawDrafts, setRawDrafts] = useState<RawDraftState>({});

  const getRawValue = (
    role: string,
    field: "input_limit" | "output_reserved",
    profile?: AuxiliaryAllocationProfile,
  ) => {
    const key = `${role}_${field}`;
    return (
      invalidRawFor(invalidInputs, key) ??
      (key in rawDrafts ? rawDrafts[key] : renderFallback(profile?.[field]))
    );
  };

  const validateRoleDrafts = (
    roles: RoleMeta[],
    profiles: Record<string, AuxiliaryAllocationProfile | undefined>,
  ) => {
    let isValid = true;
    for (const r of roles) {
      const prof = profiles[r.key];
      if (!prof) continue; // inherited/disabled is valid
      const rawIn = getRawValue(r.key, "input_limit", prof);
      if (!parsePositiveIntOrNull(rawIn).valid) {
        isValid = false;
        break;
      }
      const rawOut = getRawValue(r.key, "output_reserved", prof);
      if (!parsePositiveIntOrNull(rawOut).valid) {
        isValid = false;
        break;
      }
    }
    return isValid;
  };

  const rawAgentValid = validateRoleDrafts(
    AGENT_ROLES,
    agentProfiles as Record<string, AuxiliaryAllocationProfile | undefined>,
  );
  const visibleGlobalRoles = useMemo(
    () =>
      globalRoles
        ? GLOBAL_ROLES.filter((r) => globalRoles.includes(r.key as GlobalRoleKey))
        : GLOBAL_ROLES,
    [globalRoles],
  );
  const rawGlobalValid = validateRoleDrafts(
    visibleGlobalRoles,
    globalProfiles as Record<string, AuxiliaryAllocationProfile | undefined>,
  );

  const agentValid = scope === "global" ? true : rawAgentValid;
  const globalValid = scope === "agent" ? true : rawGlobalValid;

  useEffect(() => {
    onValidityChange?.({ agentValid, globalValid });
  }, [agentValid, globalValid, onValidityChange]);

  const handleModeChange = (scope: "agent" | "global", roleKey: string, mode: "fixed" | "auto") => {
    if (readOnly) return;
    if (scope === "agent") {
      const current = agentProfiles[roleKey as AgentRoleKey] ?? { mode: "fixed" };
      const next: AgentAuxiliaryAllocation = {
        ...agentProfiles,
        [roleKey]: {
          ...current,
          mode,
        },
      };
      onAgentChange?.(next);
    } else {
      const current = globalProfiles[roleKey as GlobalRoleKey] ?? { mode: "fixed" };
      const next: GlobalAuxiliaryAllocation = {
        ...globalProfiles,
        [roleKey]: {
          ...current,
          mode,
        },
      };
      onGlobalChange?.(next);
    }
  };

  const handleInheritToggle = (
    scope: "agent" | "global",
    roleKey: string,
    enableCustom: boolean,
  ) => {
    if (readOnly) return;
    if (scope === "agent") {
      const next: AgentAuxiliaryAllocation = { ...agentProfiles };
      if (!enableCustom) {
        delete next[roleKey as AgentRoleKey];
      } else {
        next[roleKey as AgentRoleKey] = { mode: "fixed" };
      }
      // Drop this role's invalid raw from the host store alongside the local drafts.
      onInvalidInput?.(`${roleKey}_input_limit`, undefined);
      onInvalidInput?.(`${roleKey}_output_reserved`, undefined);
      setRawDrafts((prev) => {
        const copy = { ...prev };
        delete copy[`${roleKey}_input_limit`];
        delete copy[`${roleKey}_output_reserved`];
        return copy;
      });
      onAgentChange?.(next);
    } else {
      const next: GlobalAuxiliaryAllocation = { ...globalProfiles };
      if (!enableCustom) {
        delete next[roleKey as GlobalRoleKey];
      } else {
        next[roleKey as GlobalRoleKey] = { mode: "fixed" };
      }
      onInvalidInput?.(`${roleKey}_input_limit`, undefined);
      onInvalidInput?.(`${roleKey}_output_reserved`, undefined);
      setRawDrafts((prev) => {
        const copy = { ...prev };
        delete copy[`${roleKey}_input_limit`];
        delete copy[`${roleKey}_output_reserved`];
        return copy;
      });
      onGlobalChange?.(next);
    }
  };

  const handleFieldChange = (
    scope: "agent" | "global",
    roleKey: string,
    field: "input_limit" | "output_reserved",
    rawStr: string,
  ) => {
    if (readOnly) return;
    setRawDrafts((prev) => ({
      ...prev,
      [`${roleKey}_${field}`]: rawStr,
    }));

    const parsed = parsePositiveIntOrNull(rawStr);
    if (!parsed.valid) {
      // Invalid raw is owned by the host store; a valid raw clears the entry.
      onInvalidInput?.(`${roleKey}_${field}`, rawStr);
      return;
    }
    onInvalidInput?.(`${roleKey}_${field}`, undefined);

    if (scope === "agent") {
      const current = agentProfiles[roleKey as AgentRoleKey] ?? { mode: "fixed" };
      const next: AgentAuxiliaryAllocation = {
        ...agentProfiles,
        [roleKey]: {
          ...current,
          [field]: parsed.value,
        },
      };
      onAgentChange?.(next);
    } else {
      const current = globalProfiles[roleKey as GlobalRoleKey] ?? { mode: "fixed" };
      const next: GlobalAuxiliaryAllocation = {
        ...globalProfiles,
        [roleKey]: {
          ...current,
          [field]: parsed.value,
        },
      };
      onGlobalChange?.(next);
    }
  };

  const renderRoleCard = (
    meta: RoleMeta,
    scope: "agent" | "global",
    profile?: AuxiliaryAllocationProfile,
  ) => {
    const isConfigured = profile !== undefined;
    const mode = profile?.mode ?? "fixed";
    const rawInput = getRawValue(meta.key, "input_limit", profile);
    const parsedInput = parsePositiveIntOrNull(rawInput);
    const rawOutput = getRawValue(meta.key, "output_reserved", profile);
    const parsedOutput = parsePositiveIntOrNull(rawOutput);

    const rawName = labels[`role.${meta.key}.name`] ?? meta.name;
    const cleanPrimaryName = rawName.replace(/\s*\([^)]*\)\s*$/, "").trim();

    return (
      <div
        key={meta.key}
        data-testid={`aux-card-${meta.key}`}
        className="rounded-lg border bg-card/60 p-4 transition-colors space-y-3"
      >
        <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{cleanPrimaryName}</span>
            <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground border border-border/40">
              {meta.key}
            </code>
          </div>
          <label
            htmlFor={`aux-custom-${meta.key}`}
            className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer select-none shrink-0"
          >
            <Checkbox
              id={`aux-custom-${meta.key}`}
              data-testid={`aux-custom-toggle-${meta.key}`}
              checked={isConfigured}
              disabled={readOnly}
              onCheckedChange={(checked) => handleInheritToggle(scope, meta.key, Boolean(checked))}
            />
            <span
              className={isConfigured ? "font-medium text-foreground" : "text-muted-foreground"}
            >
              {isConfigured
                ? labels["customized"] || "Customized"
                : labels["inherit"] || "Follow Default"}
            </span>
          </label>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          {labels[`role.${meta.key}.desc`] ?? meta.description}
        </p>

        {roleDetails?.[meta.key]}

        {isConfigured ? (
          <div className="ml-1 pl-3.5 sm:pl-4 border-l-2 border-primary/25 pt-2 space-y-3">
            <div className="grid gap-4 sm:grid-cols-3">
              {/* Mode Select */}
              <div className="space-y-2">
                <label
                  htmlFor={`aux-mode-${meta.key}`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {labels["mode"] || "Allocation Mode"}
                </label>
                <NativeSelect
                  id={`aux-mode-${meta.key}`}
                  data-testid={`aux-mode-select-${meta.key}`}
                  value={mode}
                  disabled={readOnly}
                  onChange={(e) =>
                    handleModeChange(scope, meta.key, e.target.value as "fixed" | "auto")
                  }
                  size="sm"
                  className="w-full"
                >
                  <NativeSelectOption value="fixed">
                    {labels["modeFixed"] || "Fixed"}
                  </NativeSelectOption>
                  <NativeSelectOption value="auto">
                    {labels["modeAuto"] || "Automatic"}
                  </NativeSelectOption>
                </NativeSelect>
              </div>

              {/* Input Limit */}
              <div className="space-y-2">
                <label
                  htmlFor={`aux-input-${meta.key}`}
                  className="text-xs font-medium text-muted-foreground flex justify-between"
                >
                  <span>{labels["inputLimit"] || "Input Limit"}</span>
                  <span className="text-[10px] text-muted-foreground/75 font-mono">
                    {labels["unit"] || "Blank / null"}
                  </span>
                </label>
                <Input
                  id={`aux-input-${meta.key}`}
                  data-testid={`aux-input-limit-${meta.key}`}
                  type="text"
                  placeholder={labels["inheritPlaceholder"] || "Default (follows caller default)"}
                  value={rawInput}
                  disabled={readOnly}
                  onChange={(e) =>
                    handleFieldChange(scope, meta.key, "input_limit", e.target.value)
                  }
                  className={`h-8 text-xs font-mono ${!parsedInput.valid ? "border-destructive ring-destructive" : ""}`}
                />
                {!parsedInput.valid && (
                  <p className="text-[10px] text-destructive">
                    {labels["invalidPositiveInt"] || "Must be a positive integer, null, or blank"}
                  </p>
                )}
              </div>

              {/* Output Reserved */}
              <div className="space-y-2">
                <label
                  htmlFor={`aux-output-${meta.key}`}
                  className="text-xs font-medium text-muted-foreground flex justify-between"
                >
                  <span>{labels["outputReserved"] || "Output Reserve (max_tokens)"}</span>
                  <span className="text-[10px] text-muted-foreground/75 font-mono">
                    {labels["hardContract"] || "Hard contract"}
                  </span>
                </label>
                <Input
                  id={`aux-output-${meta.key}`}
                  data-testid={`aux-output-reserved-${meta.key}`}
                  type="text"
                  placeholder={labels["inheritPlaceholder"] || "Default (follows caller default)"}
                  value={rawOutput}
                  disabled={readOnly}
                  onChange={(e) =>
                    handleFieldChange(scope, meta.key, "output_reserved", e.target.value)
                  }
                  className={`h-8 text-xs font-mono ${!parsedOutput.valid ? "border-destructive ring-destructive" : ""}`}
                />
                {!parsedOutput.valid && (
                  <p className="text-[10px] text-destructive">
                    {labels["invalidPositiveInt"] || "Must be a positive integer, null, or blank"}
                  </p>
                )}
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground/80 space-y-1 bg-muted/30 border border-border/40 p-2.5 rounded">
              <p className="leading-relaxed">
                •{" "}
                <span className="font-medium text-foreground/80">
                  {labels["inputLimitDesc"] || "Input limit:"}
                </span>{" "}
                {labels[`role.${meta.key}.inputDesc`] ?? meta.inputUnitDesc}
              </p>
              <p className="leading-relaxed">
                •{" "}
                <span className="font-medium text-foreground/80">
                  {labels["outputReservedDesc"] || "Output reserve:"}
                </span>{" "}
                {labels[`role.${meta.key}.outputDesc`] ?? meta.outputDesc}
              </p>
            </div>
          </div>
        ) : (
          <div className="ml-1 pl-3.5 sm:pl-4 border-l-2 border-border/40 py-1 text-xs text-muted-foreground">
            {labels["unconfiguredNote"] ||
              "No separate allocation configured; caller defaults stay in effect. Use the toggle above to set a custom cap or mode."}
          </div>
        )}
      </div>
    );
  };

  const showAgent = scope !== "global";
  const showGlobal = scope !== "agent";

  return (
    <div data-testid="context-allocation-auxiliary-root" className="space-y-6">
      {/* SCOPE 1: AGENT AUXILIARY TASKS */}
      {showAgent && (
        <Card data-testid="aux-section-agent" className="border">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="space-y-1">
                <CardTitle className="text-base font-semibold text-foreground flex items-center justify-between">
                  <span>
                    {labels["agentSectionTitle"] || "Assistant Auxiliary Tasks (P5)"}
                    {agentName ? ` - ${agentName}` : ""}
                  </span>
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  {labels["agentSectionDesc"] ||
                    "Per-request budgets for this assistant's background memory consolidation, selection, and research tasks. The main chat window is unaffected."}
                </CardDescription>
              </div>
              <span className="inline-flex items-center rounded border border-border/60 bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground self-start sm:self-auto shrink-0">
                {labels?.scopeAgent || "Agent Scope"}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              {AGENT_ROLES.map((role) =>
                renderRoleCard(role, "agent", agentProfiles[role.key as AgentRoleKey]),
              )}
            </div>
          </CardContent>
          <CardFooter className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t pt-4">
            <span className="text-xs text-muted-foreground leading-relaxed">
              {labels["agentScopeNotice"] ||
                "Saving updates only this assistant's P5 configuration, not other assistants or global settings."}
            </span>
            <Button
              tooltip={<Trans i18nKey="hints.complete.auxAgentSave" />}
              data-testid="aux-save-agent-btn"
              size="sm"
              disabled={readOnly || !canSaveAgent || !agentValid || savingAgent}
              onClick={() => onSaveAgent?.()}
              className="shrink-0"
            >
              {savingAgent
                ? labels["saving"] || "Saving..."
                : labels["saveAgent"] || "Save Assistant Aux Allocation"}
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* SCOPE 2: GLOBAL AUXILIARY TASKS */}
      {showGlobal && (
        <Card data-testid="aux-section-global" className="border">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="space-y-1">
                <CardTitle className="text-base font-semibold text-foreground">
                  {labels["globalSectionTitle"] || "Global Auxiliary Tasks (Organization)"}
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground">
                  {labels["globalSectionDesc"] ||
                    "Per-request limits for global knowledge organization and QQ visual annotation/description tasks. Shared by all conversations."}
                </CardDescription>
              </div>
              <span className="inline-flex items-center rounded border border-border/60 bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground self-start sm:self-auto shrink-0">
                {labels?.scopeGlobal || "Global Scope"}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3">
              {visibleGlobalRoles.map((role) =>
                renderRoleCard(role, "global", globalProfiles[role.key as GlobalRoleKey]),
              )}
            </div>
          </CardContent>
          <CardFooter className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t pt-4">
            <span className="text-xs text-muted-foreground leading-relaxed">
              {labels["globalScopeNotice"] ||
                "Saving updates organization settings for every feature using global vision/knowledge organization."}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {onDiscardGlobal && (
                <Button
                  tooltip={<Trans i18nKey="hints.complete.auxDiscard" />}
                  data-testid="aux-discard-global-btn"
                  variant="outline"
                  size="sm"
                  disabled={readOnly || !canDiscardGlobal}
                  onClick={() => onDiscardGlobal()}
                >
                  {labels["discardGlobal"] || "Discard"}
                </Button>
              )}
              <Button
                tooltip={<Trans i18nKey="hints.complete.auxGlobalSave" />}
                data-testid="aux-save-global-btn"
                size="sm"
                disabled={readOnly || !canSaveGlobal || !globalValid || savingGlobal}
                onClick={() => onSaveGlobal?.()}
              >
                {savingGlobal
                  ? labels["saving"] || "Saving..."
                  : labels["saveGlobal"] || "Save Global Aux Allocation"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
