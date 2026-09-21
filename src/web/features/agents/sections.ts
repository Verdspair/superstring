import type { SectionKey } from "../../store";
import type { Icon } from "../../ui/icons";

// Keys are stable business identities. Display letters can change without
// rebinding save handlers, drafts or navigation guards.
export const SECTION_META: Array<{
  key: SectionKey;
  letter: string;
  title: string;
  icon: Parameters<typeof Icon>[0]["name"];
  note?: string;
}> = [
  { key: "A", letter: "A", title: "名称与模型", icon: "agent" },
  { key: "D", letter: "B", title: "性格与人设", icon: "persona" },
  { key: "E", letter: "C", title: "情绪", icon: "emotion", note: "未开放" },
  { key: "G", letter: "D", title: "用户画像", icon: "profile", note: "未开放" },
  { key: "B", letter: "E", title: "记忆管理", icon: "memory" },
  {
    key: "knowledge",
    letter: "F",
    title: "知识库",
    icon: "book",
    note: "资料授权与管理",
  },
  { key: "C", letter: "G", title: "上下文", icon: "context" },
  {
    key: "F",
    letter: "H",
    title: "外部软件接入",
    icon: "plug",
    note: "未开放",
  },
  { key: "H", letter: "I", title: "其他", icon: "more", note: "未开放" },
];
export function sectionLetter(key: SectionKey): string {
  return SECTION_META.find((item) => item.key === key)?.letter ?? key;
}
