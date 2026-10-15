/**
 * 方案/本群配置共用的页内分组卡片：细边框 + 淡标题带，标题下写明组的作用范围、单位与影响。
 * 视觉沿用现有 Card（与设置页 SettingsGroup 同一套层次），不新增样式系统；
 * `description` 是文案键，由这里翻译，标题已是翻译后的文本。
 */
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";

export function SchemeFieldCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card size="sm" className="min-w-0 gap-0 pt-0">
      <CardHeader className="border-b bg-muted/50">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{t(description)}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-5 pt-3">{children}</CardContent>
    </Card>
  );
}

/**
 * 表情发送倾向（低/中/高）受控无状态单选组，供方案与群配置共用。
 */
export function StickerFrequencyOptions({
  value,
  onValueChange,
  disabled,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedby,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const { t } = useTranslation();
  const radioId = useId();

  const options = [
    {
      value: "low",
      labelKey: "connections.stickerFrequencyLow",
      hintKey: "connections.stickerFrequencyLowHint",
    },
    {
      value: "medium",
      labelKey: "connections.stickerFrequencyMedium",
      hintKey: "connections.stickerFrequencyMediumHint",
    },
    {
      value: "high",
      labelKey: "connections.stickerFrequencyHigh",
      hintKey: "connections.stickerFrequencyHighHint",
    },
  ] as const;

  return (
    <RadioGroup
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedby}
      className="grid gap-3 sm:grid-cols-3"
    >
      {options.map((opt) => (
        <Label
          key={opt.value}
          htmlFor={`${radioId}-${opt.value}`}
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-muted/30 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
        >
          <RadioGroupItem value={opt.value} id={`${radioId}-${opt.value}`} className="mt-0.5" />
          <div className="space-y-1">
            <span className="block font-medium leading-none">{t(opt.labelKey)}</span>
            <span className="block text-xs font-normal leading-normal text-muted-foreground">
              {t(opt.hintKey)}
            </span>
          </div>
        </Label>
      ))}
    </RadioGroup>
  );
}
