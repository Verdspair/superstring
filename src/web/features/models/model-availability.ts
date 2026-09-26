// 模型选择器里的可用性标注。
//
// 选一个名字的时候应当看得见它现在能不能用：本地服务当前加载了哪些、哪些是外部声明的、
// 哪些只是"配置里还留着但没加载"。名字本身不变（值仍是裸模型名）——只有显示的文字多一个后缀，
// 所以保存、路由与容量查表都不受影响。
export function modelOptionLabel(
  name: string,
  availability: { readonly loaded: readonly string[]; readonly external: readonly string[] },
  translate: (key: string) => string,
): string {
  if (availability.external.includes(name)) return `${name}${translate("（外部）")}`;
  return availability.loaded.includes(name)
    ? `${name}${translate("（已加载）")}`
    : `${name}${translate("（未加载）")}`;
}
