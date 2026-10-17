import { useEffect, useState } from "react";
import type { RetrievalPresets } from "../../../shared/contracts/models";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";

export type RetrievalModeKey = "conservative" | "standard" | "broad";

export interface ContextAllocationReadingProps {
  presets?: RetrievalPresets;
  knowledgeGlobalBudget?: number | null;
  knowledgeAgentBudget?: number | null;
  agentName?: string;
  onPresetBudget?: (mode: RetrievalModeKey, value: number) => void;
  onKnowledgeGlobalBudget?: (value: number) => void;
  onKnowledgeAgentBudget?: (value: number | null) => void;
  onSaveMemory?: () => Promise<void> | void;
  onSaveKnowledgeGlobal?: () => Promise<void> | void;
  onSaveKnowledgeAgent?: () => Promise<void> | void;
  savingMemory?: boolean;
  savingKnowledgeGlobal?: boolean;
  savingKnowledgeAgent?: boolean;
  canSaveMemory?: boolean;
  canSaveKnowledgeGlobal?: boolean;
  canSaveKnowledgeAgent?: boolean;
  onValidityChange?: (validity: {
    memoryValid: boolean;
    knowledgeGlobalValid: boolean;
    knowledgeAgentValid: boolean;
  }) => void;
  invalidInputs?: Record<string, string>;
  onInvalidInput?: (key: string, raw: string | undefined) => void;
  onRefreshMemory?: () => void;
  onRefreshKnowledgeGlobal?: () => void;
  onRefreshKnowledgeAgent?: () => void;
  onDiscardMemory?: () => void;
  onDiscardKnowledgeGlobal?: () => void;
  onDiscardKnowledgeAgent?: () => void;
  labels?: Partial<Record<string, string>>;
  readOnly?: boolean;
}

const MODES: { key: RetrievalModeKey; label: string; desc: string }[] = [
  {
    key: "conservative",
    label: "Conservative",
    desc: "Compact retrieval matching strictly high-relevance entries.",
  },
  {
    key: "standard",
    label: "Standard",
    desc: "Default retrieval budget balancing recall and context usage.",
  },
  {
    key: "broad",
    label: "Broad",
    desc: "Expanded retrieval budget for deep background and many entries.",
  },
];

// Locale keys under `schemes.allocation.reading.*`; the host screen passes their translated values
// through `labels`, falling back to the inline defaults above when a label is absent.
const MODE_LABEL_KEYS: Record<RetrievalModeKey, { label: string; desc: string }> = {
  conservative: { label: "modeConservative", desc: "modeConservativeDesc" },
  standard: { label: "modeStandard", desc: "modeStandardDesc" },
  broad: { label: "modeBroad", desc: "modeBroadDesc" },
};

export function ContextAllocationReading({
  presets,
  knowledgeGlobalBudget,
  knowledgeAgentBudget,
  agentName,
  onPresetBudget,
  onKnowledgeGlobalBudget,
  onKnowledgeAgentBudget,
  onSaveMemory,
  onSaveKnowledgeGlobal,
  onSaveKnowledgeAgent,
  savingMemory = false,
  savingKnowledgeGlobal = false,
  savingKnowledgeAgent = false,
  canSaveMemory = true,
  canSaveKnowledgeGlobal = true,
  canSaveKnowledgeAgent = true,
  onValidityChange,
  invalidInputs,
  onInvalidInput,
  onRefreshMemory,
  onRefreshKnowledgeGlobal,
  onRefreshKnowledgeAgent,
  onDiscardMemory,
  onDiscardKnowledgeGlobal,
  onDiscardKnowledgeAgent,
  labels,
  readOnly = false,
}: ContextAllocationReadingProps) {
  // Raw draft string states for presets (1..1048576)
  const [memoryDrafts, setMemoryDrafts] = useState<Record<RetrievalModeKey, string>>({
    conservative:
      presets?.conservative?.max_tokens != null ? String(presets.conservative.max_tokens) : "",
    standard: presets?.standard?.max_tokens != null ? String(presets.standard.max_tokens) : "",
    broad: presets?.broad?.max_tokens != null ? String(presets.broad.max_tokens) : "",
  });

  // Raw draft string state for global knowledge budget
  const [knowledgeGlobalDraft, setKnowledgeGlobalDraft] = useState<string>(
    knowledgeGlobalBudget != null ? String(knowledgeGlobalBudget) : "",
  );

  // Raw draft string state for agent knowledge budget
  const [knowledgeAgentDraft, setKnowledgeAgentDraft] = useState<string>(
    knowledgeAgentBudget != null ? String(knowledgeAgentBudget) : "",
  );

  // Keep drafts in sync when incoming props change externally
  useEffect(() => {
    setMemoryDrafts({
      conservative:
        presets?.conservative?.max_tokens != null ? String(presets.conservative.max_tokens) : "",
      standard: presets?.standard?.max_tokens != null ? String(presets.standard.max_tokens) : "",
      broad: presets?.broad?.max_tokens != null ? String(presets.broad.max_tokens) : "",
    });
  }, [
    presets?.conservative?.max_tokens,
    presets?.standard?.max_tokens,
    presets?.broad?.max_tokens,
  ]);

  useEffect(() => {
    setKnowledgeGlobalDraft(knowledgeGlobalBudget != null ? String(knowledgeGlobalBudget) : "");
  }, [knowledgeGlobalBudget]);

  useEffect(() => {
    setKnowledgeAgentDraft(knowledgeAgentBudget != null ? String(knowledgeAgentBudget) : "");
  }, [knowledgeAgentBudget]);

  // The host screen owns the raw text of invalid inputs in its own map. A key present there wins
  // over the panel-local draft, so an invalid value survives re-render and remount instead of being
  // lost, and validity cannot be hidden by switching scope.
  const invalidFor = (key: string): string | undefined => invalidInputs?.[key];

  const presetRaw = (mode: RetrievalModeKey): string =>
    invalidFor(`memory:${mode}`) ?? memoryDrafts[mode];

  // Validation: byte quotas are integers in 1..1048576.
  const isByteValid = (val: string): boolean => {
    if (!val || val.trim() === "") return false;
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 1048576;
  };

  const isMemoryValid = MODES.every(
    ({ key }) => invalidFor(`memory:${key}`) === undefined && isByteValid(memoryDrafts[key]),
  );

  // Knowledge Global: integer positive in byte units
  const isKnowledgeGlobalValid =
    invalidFor("knowledgeGlobal") === undefined && isByteValid(knowledgeGlobalDraft);

  // Knowledge Agent: inheriting (budget null) is valid; an override must be a positive byte integer.
  const isAgentInheriting =
    knowledgeAgentBudget === null && invalidFor("knowledgeAgent") === undefined;
  const isKnowledgeAgentValid =
    invalidFor("knowledgeAgent") === undefined &&
    (isAgentInheriting || isByteValid(knowledgeAgentDraft));

  useEffect(() => {
    onValidityChange?.({
      memoryValid: isMemoryValid,
      knowledgeGlobalValid: isKnowledgeGlobalValid,
      knowledgeAgentValid: isKnowledgeAgentValid,
    });
  }, [isMemoryValid, isKnowledgeGlobalValid, isKnowledgeAgentValid, onValidityChange]);

  // Every edit reports its raw text to the host: invalid raw is stored there, a valid raw clears it.
  const handlePresetChange = (mode: RetrievalModeKey, raw: string) => {
    setMemoryDrafts((prev) => ({ ...prev, [mode]: raw }));
    if (isByteValid(raw)) {
      onInvalidInput?.(`memory:${mode}`, undefined);
      onPresetBudget?.(mode, Number(raw));
    } else {
      onInvalidInput?.(`memory:${mode}`, raw);
    }
  };

  const handleGlobalKnowledgeChange = (raw: string) => {
    setKnowledgeGlobalDraft(raw);
    if (isByteValid(raw)) {
      onInvalidInput?.("knowledgeGlobal", undefined);
      onKnowledgeGlobalBudget?.(Number(raw));
    } else {
      onInvalidInput?.("knowledgeGlobal", raw);
    }
  };

  const handleAgentKnowledgeChange = (raw: string) => {
    setKnowledgeAgentDraft(raw);
    if (isByteValid(raw)) {
      onInvalidInput?.("knowledgeAgent", undefined);
      onKnowledgeAgentBudget?.(Number(raw));
    } else {
      onInvalidInput?.("knowledgeAgent", raw);
    }
  };

  const handleToggleAgentInherit = (inherit: boolean) => {
    // Switching scope drops the invalid raw of this field; never invent a fallback quota.
    onInvalidInput?.("knowledgeAgent", undefined);
    if (inherit) {
      if (invalidFor("knowledgeAgent") !== undefined || !isByteValid(knowledgeAgentDraft)) {
        setKnowledgeAgentDraft("");
      }
      onKnowledgeAgentBudget?.(null);
    } else {
      // An override starts from the known global default; with no known global it stays empty and
      // invalid until a positive quota is entered.
      const inherited = knowledgeGlobalBudget != null ? knowledgeGlobalBudget : null;
      if (inherited != null) {
        setKnowledgeAgentDraft(String(inherited));
        onKnowledgeAgentBudget?.(inherited);
      } else {
        setKnowledgeAgentDraft("");
        onInvalidInput?.("knowledgeAgent", "");
      }
    }
  };

  return (
    <div data-testid="reading-allocation-panel" className="space-y-6">
      {/* 1. MEMORY PRESETS (AGENT SCOPE) */}
      <Card data-testid="reading-section-memory">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                {labels?.memoryTitle || "Long-Term Memory Retrieval Budgets"}
              </CardTitle>
              <CardDescription>
                {labels?.memoryDesc ||
                  `Maximum read bytes per retrieval tier${agentName ? ` for ${agentName}` : ""}. Applies to Web and QQ alike.`}
              </CardDescription>
            </div>
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {labels?.scopeAgent || "Agent Scope"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {MODES.map(({ key, label, desc }) => {
              const draftVal = presetRaw(key);
              const valid = isByteValid(draftVal) && invalidFor(`memory:${key}`) === undefined;
              const preset = presets?.[key];

              return (
                <div
                  key={key}
                  className="rounded-lg border bg-background p-3.5 shadow-sm space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {labels?.[MODE_LABEL_KEYS[key].label] || label}
                    </span>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      {preset?.max_entries != null
                        ? String(preset.max_entries)
                        : labels?.entriesKeep || "Entry limit preserved"}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed min-h-[32px]">
                    {labels?.[MODE_LABEL_KEYS[key].desc] || desc}
                  </p>
                  <div>
                    <label
                      htmlFor={`reading-memory-${key}`}
                      className="text-[11px] font-medium text-muted-foreground block mb-1"
                    >
                      {labels?.maxBytesLabel || "Maximum Read Bytes (1..1,048,576)"}
                    </label>
                    <Input
                      id={`reading-memory-${key}`}
                      data-testid={`reading-preset-max-tokens-${key}`}
                      type="text"
                      inputMode="numeric"
                      disabled={readOnly}
                      value={draftVal}
                      onChange={(e) => handlePresetChange(key, e.target.value)}
                      className={`h-8 text-xs font-mono ${!valid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                      placeholder={preset?.max_tokens != null ? String(preset.max_tokens) : "Bytes"}
                    />
                    {!valid && (
                      <p className="text-[11px] text-destructive mt-1">
                        {labels?.invalidByteRange || "Must be an integer between 1 and 1,048,576"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
        {(onSaveMemory || onDiscardMemory) && (
          <CardFooter className="flex justify-end gap-2 border-t pt-3">
            {onRefreshMemory && (
              <Button variant="outline" size="sm" disabled={readOnly} onClick={onRefreshMemory}>
                {labels?.refreshBaseline || "Refresh baseline"}
              </Button>
            )}
            {onDiscardMemory && (
              <Button
                data-testid="reading-discard-memory-btn"
                variant="outline"
                size="sm"
                disabled={readOnly || savingMemory}
                onClick={() => onDiscardMemory()}
              >
                {labels?.discardBudget || "Discard budget changes"}
              </Button>
            )}
            <Button
              data-testid="reading-save-memory-btn"
              size="sm"
              disabled={readOnly || savingMemory || !canSaveMemory || !isMemoryValid}
              onClick={() => onSaveMemory?.()}
            >
              {savingMemory
                ? labels?.saving || "Saving..."
                : labels?.saveMemory || "Save Memory Budgets"}
            </Button>
          </CardFooter>
        )}
      </Card>

      {/* 2. KNOWLEDGE BASE GLOBAL BUDGET */}
      <Card data-testid="reading-section-knowledge-global">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                {labels?.knowledgeGlobalTitle || "Global Knowledge Base Default Read Quota"}
              </CardTitle>
              <CardDescription>
                {labels?.knowledgeGlobalDesc ||
                  "Shared default per-request knowledge read limit; assistants without their own override inherit it."}
              </CardDescription>
            </div>
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {labels?.scopeGlobal || "Global Scope"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-1.5">
            <label
              htmlFor="reading-global-budget"
              className="text-xs font-medium text-muted-foreground block"
            >
              {labels?.defaultBytesLabel || "Default Read Quota (Bytes, 1..1,048,576)"}
            </label>
            <Input
              id="reading-global-budget"
              data-testid="reading-knowledge-global-budget-input"
              type="text"
              inputMode="numeric"
              disabled={readOnly}
              value={invalidFor("knowledgeGlobal") ?? knowledgeGlobalDraft}
              onChange={(e) => handleGlobalKnowledgeChange(e.target.value)}
              className={`h-8 text-xs font-mono ${!isKnowledgeGlobalValid ? "border-destructive focus-visible:ring-destructive" : ""}`}
              placeholder={knowledgeGlobalBudget != null ? String(knowledgeGlobalBudget) : "Bytes"}
            />
            {!isKnowledgeGlobalValid && (
              <p className="text-[11px] text-destructive">
                {labels?.invalidPositiveByte ||
                  "Must be a positive integer between 1 and 1,048,576"}
              </p>
            )}
          </div>
        </CardContent>
        {(onSaveKnowledgeGlobal || onDiscardKnowledgeGlobal) && (
          <CardFooter className="flex justify-end gap-2 border-t pt-3">
            {onRefreshKnowledgeGlobal && (
              <Button
                variant="outline"
                size="sm"
                disabled={readOnly}
                onClick={onRefreshKnowledgeGlobal}
              >
                {labels?.refreshBaseline || "Refresh baseline"}
              </Button>
            )}
            {onDiscardKnowledgeGlobal && (
              <Button
                data-testid="reading-discard-knowledge-global-btn"
                variant="outline"
                size="sm"
                disabled={readOnly || savingKnowledgeGlobal}
                onClick={() => onDiscardKnowledgeGlobal()}
              >
                {labels?.discardBudget || "Discard budget changes"}
              </Button>
            )}
            <Button
              data-testid="reading-save-knowledge-global-btn"
              size="sm"
              disabled={
                readOnly ||
                savingKnowledgeGlobal ||
                !canSaveKnowledgeGlobal ||
                !isKnowledgeGlobalValid
              }
              onClick={() => onSaveKnowledgeGlobal?.()}
            >
              {savingKnowledgeGlobal
                ? labels?.saving || "Saving..."
                : labels?.saveKnowledgeGlobal || "Save Global Knowledge Quota"}
            </Button>
          </CardFooter>
        )}
      </Card>

      {/* 3. KNOWLEDGE BASE AGENT OVERRIDE */}
      <Card data-testid="reading-section-knowledge-agent">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                {labels?.knowledgeAgentTitle || "Assistant Knowledge Read Quota"}
              </CardTitle>
              <CardDescription>
                {labels?.knowledgeAgentDesc ||
                  `Independent knowledge read quota override${agentName ? ` for ${agentName}` : ""}.`}
              </CardDescription>
            </div>
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {labels?.scopeAgentOverride || "Agent Override"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="reading-agent-inherit"
              data-testid="reading-knowledge-agent-inherit-checkbox"
              disabled={readOnly}
              checked={isAgentInheriting}
              onChange={(e) => handleToggleAgentInherit(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-primary cursor-pointer disabled:cursor-not-allowed"
            />
            <label
              htmlFor="reading-agent-inherit"
              className="text-xs font-medium leading-none cursor-pointer"
            >
              {labels?.followGlobalDefault || "Follow global default quota (inherit global)"}
            </label>
          </div>

          <div className="rounded-md border bg-muted/20 p-3 text-xs">
            <div
              data-testid="reading-knowledge-agent-effective-source"
              className="flex items-center justify-between"
            >
              <span className="text-muted-foreground">
                {labels?.effectiveSourceLabel || "Effective value and source:"}
              </span>
              <span className="font-medium font-mono">
                {isAgentInheriting
                  ? `${knowledgeGlobalBudget != null ? knowledgeGlobalBudget : "?"} ${labels?.bytesInherited || "Bytes (inherited from global)"}`
                  : `${knowledgeAgentDraft || knowledgeAgentBudget || 0} ${labels?.bytesAgentOverride || "Bytes (assistant override)"}`}
              </span>
            </div>
          </div>

          {!isAgentInheriting && (
            <div className="max-w-md space-y-1.5 pt-1">
              <label
                htmlFor="reading-agent-budget"
                className="text-xs font-medium text-muted-foreground block"
              >
                {labels?.overrideBytesLabel || "Override Read Quota (Bytes, 1..1,048,576)"}
              </label>
              <Input
                id="reading-agent-budget"
                data-testid="reading-knowledge-agent-budget-input"
                type="text"
                inputMode="numeric"
                disabled={readOnly}
                value={invalidFor("knowledgeAgent") ?? knowledgeAgentDraft}
                onChange={(e) => handleAgentKnowledgeChange(e.target.value)}
                className={`h-8 text-xs font-mono ${!isKnowledgeAgentValid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                placeholder="Bytes"
              />
              {!isKnowledgeAgentValid && (
                <p className="text-[11px] text-destructive">
                  {labels?.invalidPositiveByte ||
                    "Must be a positive integer between 1 and 1,048,576"}
                </p>
              )}
            </div>
          )}
        </CardContent>
        {(onSaveKnowledgeAgent || onDiscardKnowledgeAgent) && (
          <CardFooter className="flex justify-end gap-2 border-t pt-3">
            {onRefreshKnowledgeAgent && (
              <Button
                variant="outline"
                size="sm"
                disabled={readOnly}
                onClick={onRefreshKnowledgeAgent}
              >
                {labels?.refreshBaseline || "Refresh baseline"}
              </Button>
            )}
            {onDiscardKnowledgeAgent && (
              <Button
                data-testid="reading-discard-knowledge-agent-btn"
                variant="outline"
                size="sm"
                disabled={readOnly || savingKnowledgeAgent}
                onClick={() => onDiscardKnowledgeAgent()}
              >
                {labels?.discardBudget || "Discard budget changes"}
              </Button>
            )}
            <Button
              data-testid="reading-save-knowledge-agent-btn"
              size="sm"
              disabled={
                readOnly || savingKnowledgeAgent || !canSaveKnowledgeAgent || !isKnowledgeAgentValid
              }
              onClick={() => onSaveKnowledgeAgent?.()}
            >
              {savingKnowledgeAgent
                ? labels?.saving || "Saving..."
                : labels?.saveKnowledgeAgent || "Save Assistant Knowledge Quota"}
            </Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
