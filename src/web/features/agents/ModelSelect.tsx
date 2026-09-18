import { useI18n } from "../../i18n";
export function ModelSelect({
  value,
  models,
  onChange,
}: {
  value: string | null;
  models: string[];
  onChange: (value: string | null) => void;
}) {
  const t = useI18n();
  return (
    <select
      value={value ?? "__follow__"}
      onChange={(event) =>
        onChange(event.target.value === "__follow__" ? null : event.target.value)
      }
    >
      <option value="__follow__">{t("跟随当前模型")}</option>
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  );
}
