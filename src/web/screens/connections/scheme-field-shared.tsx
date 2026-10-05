/**
 * 方案/本群配置共用的页内分组卡片：细边框 + 淡标题带，标题下写明组的作用范围、单位与影响。
 * 视觉沿用现有 Card（与设置页 SettingsGroup 同一套层次），不新增样式系统；
 * `description` 是文案键，由这里翻译，标题已是翻译后的文本。
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

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
