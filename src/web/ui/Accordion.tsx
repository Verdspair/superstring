import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { Chevron, Icon } from "./icons";

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
  高级设置: "sliders",
  "人设（身份与边界）": "profile",
  "性格（表达风格）": "chat",
} as const satisfies Record<string, Parameters<typeof Icon>[0]["name"]>;

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
  return (
    <details className="group" open={open}>
      <summary className={icon ? "icon-summary" : undefined}>
        {icon && <Icon name={icon} />}
        <span className="summary-copy">
          <strong>
            {listIcon && (
              <span className="config-list-icon">
                <Icon name={listIcon} />
              </span>
            )}
            {t(listIcon ? label : title)}
          </strong>
          {note && <small>{t(note)}</small>}
        </span>
        <Chevron />
      </summary>
      <div className="group-body">{children}</div>
    </details>
  );
}
