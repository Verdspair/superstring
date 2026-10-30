import { useEffect, useState } from "react";
import { Trans } from "react-i18next";
import { KnowledgeSettingsUpdateSchema } from "../../../shared/contracts/knowledge";
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

export interface ContextAllocationReadingProps {
  knowledgeGlobalBudget?: number | null;
  onKnowledgeGlobalBudget?: (value: number) => void;
  onSaveKnowledgeGlobal?: () => Promise<void> | void;
  savingKnowledgeGlobal?: boolean;
  canSaveKnowledgeGlobal?: boolean;
  onValidityChange?: (validity: { knowledgeGlobalValid: boolean }) => void;
  invalidInputs?: Record<string, string>;
  onInvalidInput?: (key: string, raw: string | undefined) => void;
  onRefreshKnowledgeGlobal?: () => void;
  onDiscardKnowledgeGlobal?: () => void;
  labels?: Partial<Record<string, string>>;
  readOnly?: boolean;
}

/** The global knowledge quota; Agent memory and knowledge drafts belong to materials. */
export function ContextAllocationReading({
  knowledgeGlobalBudget,
  onKnowledgeGlobalBudget,
  onSaveKnowledgeGlobal,
  savingKnowledgeGlobal = false,
  canSaveKnowledgeGlobal = true,
  onValidityChange,
  invalidInputs,
  onInvalidInput,
  onRefreshKnowledgeGlobal,
  onDiscardKnowledgeGlobal,
  labels,
  readOnly = false,
}: ContextAllocationReadingProps) {
  const [draft, setDraft] = useState(String(knowledgeGlobalBudget ?? ""));
  useEffect(() => setDraft(String(knowledgeGlobalBudget ?? "")), [knowledgeGlobalBudget]);
  const raw = invalidInputs?.knowledgeGlobal ?? draft;
  const valid =
    raw.trim() !== "" &&
    KnowledgeSettingsUpdateSchema.shape.context_budget.safeParse(Number(raw)).success;
  useEffect(() => onValidityChange?.({ knowledgeGlobalValid: valid }), [valid, onValidityChange]);
  return (
    <div data-testid="reading-allocation-panel">
      <Card data-testid="reading-section-knowledge-global">
        <CardHeader>
          <CardTitle>{labels?.knowledgeGlobalTitle}</CardTitle>
          <CardDescription>{labels?.knowledgeGlobalDesc}</CardDescription>
        </CardHeader>
        <CardContent>
          <label htmlFor="reading-global-budget" className="text-xs font-medium">
            {labels?.defaultBytesLabel}
          </label>
          <Input
            id="reading-global-budget"
            data-testid="reading-knowledge-global-budget-input"
            aria-invalid={!valid || undefined}
            inputMode="numeric"
            disabled={readOnly}
            value={raw}
            onChange={(event) => {
              const value = event.target.value;
              setDraft(value);
              const number = Number(value);
              if (
                value.trim() !== "" &&
                KnowledgeSettingsUpdateSchema.shape.context_budget.safeParse(number).success
              ) {
                onInvalidInput?.("knowledgeGlobal", undefined);
                onKnowledgeGlobalBudget?.(number);
              } else onInvalidInput?.("knowledgeGlobal", value);
            }}
          />
          {!valid && (
            <p role="alert" className="text-xs text-destructive">
              {labels?.invalidPositiveByte}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {onRefreshKnowledgeGlobal && (
            <Button
              variant="outline"
              disabled={readOnly}
              onClick={onRefreshKnowledgeGlobal}
              tooltip={<Trans i18nKey="hints.complete.budgetRefresh" />}
            >
              {labels?.refreshBaseline}
            </Button>
          )}
          {onDiscardKnowledgeGlobal && (
            <Button
              variant="outline"
              disabled={readOnly || savingKnowledgeGlobal}
              onClick={onDiscardKnowledgeGlobal}
              tooltip={<Trans i18nKey="hints.complete.budgetDiscard" />}
            >
              {labels?.discardBudget}
            </Button>
          )}
          <Button
            data-testid="reading-save-knowledge-global-btn"
            disabled={readOnly || savingKnowledgeGlobal || !canSaveKnowledgeGlobal || !valid}
            onClick={() => void onSaveKnowledgeGlobal?.()}
            tooltip={<Trans i18nKey="hints.complete.knowledgeGlobalSave" />}
          >
            {labels?.[savingKnowledgeGlobal ? "saving" : "saveKnowledgeGlobal"]}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
