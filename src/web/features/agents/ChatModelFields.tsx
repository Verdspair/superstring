import { NativeSelect } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "../../i18n";
import type { AgentDraft } from "../../state/types";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { ModelUseHint } from "../models/ModelUseHint";
import { modelOptionLabel } from "../models/model-availability";

export function ChatModelFields({
  draft,
  models,
  patch,
  disabled = false,
}: {
  draft: AgentDraft;
  models: string[];
  patch: (value: Partial<AgentDraft>) => void;
  disabled?: boolean;
}) {
  const availability = {
    loaded: useSuperstringStore((s) => s.loadedModelNames),
    external: useSuperstringStore((s) => s.externalModelNames),
  };
  const t = useI18n();
  const saved = useSuperstringStore((s) => s.pageEditor?.agent.model_name ?? null);
  const options = [...new Set([...models, ...(draft.model_name ? [draft.model_name] : [])])];
  return (
    <SettingsGroup id="settings-chat-model" title="对话模型">
      <Field label={t("对话模型")} info={t("仅用于当前助手的对话；不会自动加载或重载模型。")}>
        <NativeSelect
          className="w-full"
          aria-label={t("对话模型")}
          disabled={disabled}
          value={draft.model_name}
          onChange={(event) => patch({ model_name: event.target.value })}
        >
          {!draft.model_name && (
            <option value="" disabled>
              {t("选择模型")}
            </option>
          )}
          {options.map((name) => (
            <option key={name} value={name}>
              {modelOptionLabel(name, availability, t)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <ModelUseHint purpose="chat" configured={draft.model_name} saved={saved} />
      <Field
        label={t("回复随机度")}
        info={t("越低越稳定，越高越多样。对应 temperature，默认 0.7。")}
      >
        <div className="range-row grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-4 [&>output]:text-center [&>output]:text-sm [&>output]:tabular-nums [&>output]:text-muted-foreground">
          <Slider
            aria-label={t("回复随机度")}
            disabled={disabled}
            min={0}
            max={2}
            step={0.05}
            value={[draft.temperature]}
            onValueChange={(values) => patch({ temperature: Number(values[0]) })}
          />
          <output>{draft.temperature.toFixed(2)}</output>
        </div>
      </Field>
    </SettingsGroup>
  );
}
