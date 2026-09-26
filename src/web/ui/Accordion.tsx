import type { ReactNode } from "react";
import {
  AccordionContent,
  AccordionItem,
  Accordion as AccordionRoot,
  AccordionTrigger,
} from "../components/ui/accordion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useI18n } from "../i18n";
import { Icon } from "./icons";

const CONFIG_LIST_ICONS = {
  基本信息: "profile",
  基础指令: "instructions",
  本地模型: "chip",
  "外部 API 模型接入": "plug",
  读取配置: "search",
  保守预设: "shield",
  标准预设: "sliders",
  宽泛预设: "scope",
  整理配置: "archive",
  自动整理: "clock",
  手动整理: "hand",
  记忆列表与治理: "memory",
  模型与预算: "chip",
  压缩策略: "compress",
  压缩与读取摘要策略: "compress",
  高级设置: "sliders",
  "人设（身份与边界）": "profile",
  "性格（表达风格）": "chat",
  基础信息: "profile",
  当前助手: "agent",
  所有助手: "users",
  对话模型: "chip",
  记忆模型: "memory",
  上下文压缩模型: "compress",
  身份与行为: "profile",
  补充指令: "instructions",
  沟通风格: "chat",
  示例对话: "chat",
  性格强度: "sliders",
  容量与预算: "chip",
  知识库读取开关: "book",
  读取预算: "sliders",
  读取范围: "scope",
  尚未开放的读取策略: "clock",
  全局共享配置: "book",
  全局知识库整理模型: "chip",
} as const satisfies Record<string, Parameters<typeof Icon>[0]["name"]>;

export function SettingsGroup({
  id,
  title,
  note,
  children,
}: {
  id?: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  const t = useI18n();
  const icon = CONFIG_LIST_ICONS[title as keyof typeof CONFIG_LIST_ICONS] ?? "sliders";
  return (
    <section
      id={id}
      className="group workspace-group scroll-mt-6"
      tabIndex={-1}
      aria-label={t(title)}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h3 className="workspace-group-heading flex items-center gap-2">
              <Icon name={icon} />
              {t(title)}
            </h3>
          </CardTitle>
          {note && <CardDescription>{t(note)}</CardDescription>}
        </CardHeader>
        <CardContent className="group-body grid min-w-0 gap-4">{children}</CardContent>
      </Card>
    </section>
  );
}

export function Accordion({
  title,
  note,
  icon,
  open = false,
  children,
}: {
  title: string;
  note?: string;
  icon?: Parameters<typeof Icon>[0]["name"];
  open?: boolean;
  children: ReactNode;
}) {
  const t = useI18n();
  const label = title.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "");
  const listIcon = !icon ? CONFIG_LIST_ICONS[label as keyof typeof CONFIG_LIST_ICONS] : undefined;
  const glyph = icon || listIcon;
  return (
    <Card className="group py-0">
      <AccordionRoot type="single" collapsible defaultValue={open ? "content" : undefined}>
        <AccordionItem value="content" className="border-0">
          <AccordionTrigger className="px-4 py-4">
            <span className="flex min-w-0 items-start gap-3">
              {glyph && <Icon name={glyph} className="mt-0.5 text-primary" />}
              <span className="summary-copy grid gap-1">
                <strong>{t(listIcon ? label : title)}</strong>
                {note && (
                  <small className="text-xs font-normal text-muted-foreground">{t(note)}</small>
                )}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="group-body grid gap-4 px-4 pb-4">
            {children}
          </AccordionContent>
        </AccordionItem>
      </AccordionRoot>
    </Card>
  );
}
