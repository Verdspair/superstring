// 离开守卫的唯一所有者：页面草稿未保存聚合（hasUnsavedDrafts）与在途写入聚合（navigationBusy）。
//
// 依赖方向固定为 编排层(state) -> 领域谓词(features/* 的 dirty 判定)，领域模块不反向 import
// 这里。此前该聚合放在 features/qq/draft-state.ts，使 QQ 领域 import access/agents/knowledge
// 三个同层领域，形成跨领域值依赖；判定集合与顺序与迁移前逐位一致。

import { permissionSettingsDirty } from "../features/access/permission-state";
import { webAccessDraftDirty } from "../features/access/web-access-state";
import { dirtyPages } from "../features/agents/page-drafts";
import {
  knowledgeModelDirty,
  knowledgeReadDirty,
  organizationDirty,
} from "../features/knowledge/types";
import { qqDraftChanges } from "../features/qq/draft-state";
import type { SuperstringState } from "./types";

/** 全应用是否有未保存草稿：beforeunload 与导航确认共用同一条判定。 */
export function hasUnsavedDrafts(state: SuperstringState): boolean {
  return (
    state.dirty ||
    state.memoryCorrectionDirty ||
    state.knowledgeDirty ||
    permissionSettingsDirty(state.permissionEditor) ||
    webAccessDraftDirty(state.webAccessSnapshot, state.webAccessDraft) ||
    dirtyPages(state.pageEditor).length > 0 ||
    organizationDirty(state.organizationEditor) ||
    knowledgeModelDirty(state.knowledgeModelEditor) ||
    knowledgeReadDirty(state.knowledgeReadEditor) ||
    Object.keys(state.qqMemoryBatchDrafts).length > 0 ||
    qqDraftChanges(state).length > 0
  );
}

/** 有任一保存/读取在途：导航必须被拦住，防止带着半份答案或半次读取切走。 */
export function navigationBusy(state: SuperstringState): boolean {
  return (
    state.qqAccessSaving ||
    state.qqSchemeSaving ||
    state.qqStickerSaving ||
    // 存储管理（保留设置保存与清理预览/执行）同样持写：保存期间导航必须被拦住。
    state.qqStorageSaving ||
    // 本群配置保存：同一条写保护，防止带着半份答案切走。
    state.qqGroupConfigSaving ||
    state.settingsSaving ||
    state.permissionSaving ||
    state.webAccessSaving ||
    state.webAccessTesting ||
    state.editorLoading ||
    state.knowledgeReadLoading ||
    state.organizationLoading ||
    state.knowledgeModelLoading ||
    state.memoryCorrectionSaving ||
    state.qqMemoryBatchSaving ||
    state.knowledgeBusy
  );
}
