import { useI18n } from "../../i18n";
import { SECTION_META } from "./sections";

export function UnavailableSection({ section }: { section: "E" | "F" | "G" | "H" | "knowledge" }) {
  const t = useI18n();
  const meta = SECTION_META.find((item) => item.key === section);
  const description = {
    E: "当前无需设置。",
    F: "外部软件接入暂不可用；现有本地聊天不受影响。",
    G: "用户画像暂未开放，当前无需设置。",
    H: "这里将收纳其他助手设置，当前无需操作。",
    knowledge: "知识库暂未开放，当前无需设置。",
  }[section];
  return (
    <div className="config-section unavailable-section">
      <h3>
        {meta?.letter} · {t(meta?.title ?? "")}
      </h3>
      <p>{t(description)}</p>
      <button type="button" disabled>
        {t("暂未开放")}
      </button>
    </div>
  );
}
