// The sticker library surface (§9.2, ADR0018 P5d).
//
// A management page rather than a settings form: §9.1's sequence is import → review → describe →
// enable, so the page leads with the import, then the collections a scheme can authorize, then
// the assets themselves, and it opens the imported asset for the review that has to happen next.
// The library is QQ-global, so nothing here follows the assistant being configured.
//
// What the page deliberately does not offer: deleting or replacing anything (U11 — undecided, and
// a wrong guess destroys a file the user imported), batch operations (their conflict rules are
// still undesigned), previews, and a "generate a description" button (its model call is not
// wired). The enable action shows who it reaches, because §9.1 asks the surface to.

import { useEffect, useState } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { Icon } from "../../ui/icons";
import { formatBytes } from "./format";
import { qqStickerEditorDirty } from "./types";

export function StickerLibrary() {
  const t = useI18n();
  const collections = useSuperstringStore((s) => s.qqStickerCollections);
  const assets = useSuperstringStore((s) => s.qqStickerAssets);
  const loading = useSuperstringStore((s) => s.qqStickerLoading);
  const saving = useSuperstringStore((s) => s.qqStickerSaving);
  const editor = useSuperstringStore((s) => s.qqStickerEditor);
  const impact = useSuperstringStore((s) => s.qqStickerImpact);
  const notice = useSuperstringStore((s) => s.qqStickerImportNotice);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const load = useSuperstringStore((s) => s.loadQqStickers);
  const openEditor = useSuperstringStore((s) => s.openQqStickerEditor);
  const patchEditor = useSuperstringStore((s) => s.patchQqStickerEditor);
  const saveEditor = useSuperstringStore((s) => s.saveQqStickerEditor);
  const setEnabled = useSuperstringStore((s) => s.setQqStickerEnabled);
  const importFile = useSuperstringStore((s) => s.importQqStickerFile);
  const selected = useSuperstringStore((s) => s.qqStickerSelection);
  const setSelection = useSuperstringStore((s) => s.setQqStickerSelection);
  const bulkUpdate = useSuperstringStore((s) => s.bulkUpdateQqStickers);
  const annotate = useSuperstringStore((s) => s.annotateQqSticker);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const [annotationNotice, setAnnotationNotice] = useState<string | null>(null);
  const batchImpact = useSuperstringStore((s) => s.qqStickerBatchImpact);
  const loadBatchImpact = useSuperstringStore((s) => s.loadQqStickerBatchImpact);
  const createCollection = useSuperstringStore((s) => s.createQqStickerCollection);
  const renameCollection = useSuperstringStore((s) => s.renameQqStickerCollection);
  const [newCollection, setNewCollection] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [batchCollection, setBatchCollection] = useState("");
  const [batchTag, setBatchTag] = useState("");
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = qqStickerEditorDirty(editor);
  const collectionName = (id: string) =>
    collections.find((row) => row.id === id)?.name ?? t("未知集合");
  const rejectedText = (reason: string) =>
    reason === "empty"
      ? t("这个文件是空的，没有可保存的内容。")
      : reason === "unsupported_format"
        ? t("这个格式不在支持范围内：请选择 PNG、JPEG、GIF、WebP 或 BMP 图片。")
        : reason === "truncated_header"
          ? t("这个文件不完整，读不出图片信息。")
          : t("这个文件的尺寸不合法，无法作为素材。");

  return (
    <>
      <p className="settings-note">
        {t(
          "QQ 全局共享素材，不随当前助手切换。导入只保存应用内副本并默认停用，启用后还要有方案授权它所在的集合，回复才可能选中它。",
        )}
      </p>
      {loading && <p role="status">{t("正在读取素材库…")}</p>}
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      {feedback && (
        <p className="hint workspace-feedback" role="status">
          {translateNotice(feedback)}
        </p>
      )}

      <SettingsGroup
        id="qq-sticker-import"
        title="导入素材"
        note="原文件不会被移动或修改；导入后默认停用，等待你审核与补充说明。"
      >
        <Field
          label="选择图片文件"
          info="格式与尺寸按文件内容读取，不看扩展名；同时导入多个文件请逐个进行。"
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            disabled={saving}
            aria-label={t("选择图片文件")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
        </Field>
        {notice?.kind === "rejected" && (
          <p role="alert" className="error">
            {rejectedText(notice.reason)}
          </p>
        )}
        {notice?.kind === "imported" && (
          <p className="hint" role="status">
            {t("已导入并选中：")}
            {notice.name}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        id="qq-sticker-collections"
        title="集合"
        note="方案授权的是集合；一个素材可以同时属于多个集合，不会因此更容易被选中。"
      >
        {collections.length === 0 ? (
          <p className="hint">{t("还没有集合。先建一个集合，素材才能被方案授权。")}</p>
        ) : (
          <ul className="qq-sticker-collections">
            {collections.map((collection) => (
              <li key={collection.id}>
                {renaming?.id === collection.id ? (
                  <>
                    <input
                      value={renaming.name}
                      aria-label={t("集合名称")}
                      onChange={(event) =>
                        setRenaming({ id: collection.id, name: event.target.value })
                      }
                    />
                    <button
                      type="button"
                      disabled={saving || renaming.name.trim() === ""}
                      onClick={() => {
                        void renameCollection(
                          collection.id,
                          renaming.name.trim(),
                          collection.revision,
                        ).then((ok) => {
                          if (ok) setRenaming(null);
                        });
                      }}
                    >
                      {t("保存名称")}
                    </button>
                    <button type="button" disabled={saving} onClick={() => setRenaming(null)}>
                      {t("取消")}
                    </button>
                  </>
                ) : (
                  <>
                    <span>{collection.name}</span>
                    <small>
                      {t("素材")}
                      {collection.asset_count}
                    </small>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label={`${t("重命名集合")}：${collection.name}`}
                      onClick={() => setRenaming({ id: collection.id, name: collection.name })}
                    >
                      <Icon name="edit" />
                      <span>{t("重命名")}</span>
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <Field label="新建集合" info="集合是方案授权的单位，名字只是给你自己看的。">
          <input
            value={newCollection}
            aria-label={t("新建集合")}
            placeholder={t("例如：日常、节日")}
            onChange={(event) => setNewCollection(event.target.value)}
          />
          <button
            type="button"
            disabled={saving || newCollection.trim() === ""}
            onClick={() => {
              void createCollection(newCollection.trim()).then((ok) => {
                if (ok) setNewCollection("");
              });
            }}
          >
            {t("新建")}
          </button>
        </Field>
      </SettingsGroup>

      <SettingsGroup
        id="qq-stickers"
        title="素材"
        note="启用只是允许选用；是否真的发出去还要看方案授权、节奏与防重复规则。"
      >
        {selected.length > 0 && (
          <div className="qq-sticker-batch">
            <p className="hint">
              {t("已选择")}
              {selected.length}
              {t("个素材")}
              <button
                type="button"
                disabled={saving}
                onClick={() => setSelection(assets.map((row) => row.id))}
              >
                {t("全选")}
              </button>
              <button type="button" disabled={saving} onClick={() => setSelection([])}>
                {t("取消全选")}
              </button>
            </p>
            <div className="qq-sticker-actions">
              <select
                aria-label={t("归类集合")}
                value={batchCollection}
                disabled={saving}
                onChange={(event) => setBatchCollection(event.target.value)}
              >
                <option value="">{t("选择集合")}</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={saving || batchCollection === ""}
                onClick={() => void bulkUpdate({ addCollectionIds: [batchCollection] })}
              >
                {t("加入集合")}
              </button>
              <button
                type="button"
                disabled={saving || batchCollection === ""}
                onClick={() => void bulkUpdate({ removeCollectionIds: [batchCollection] })}
              >
                {t("移出集合")}
              </button>
            </div>
            <div className="qq-sticker-actions">
              <input
                value={batchTag}
                disabled={saving}
                aria-label={t("批量标签")}
                placeholder={t("标签")}
                onChange={(event) => setBatchTag(event.target.value)}
              />
              <button
                type="button"
                disabled={saving || batchTag.trim() === ""}
                onClick={() => void bulkUpdate({ tags: { add: [batchTag.trim()] } })}
              >
                {t("添加标签")}
              </button>
              <button
                type="button"
                disabled={saving || batchTag.trim() === ""}
                onClick={() => void bulkUpdate({ tags: { remove: [batchTag.trim()] } })}
              >
                {t("移除标签")}
              </button>
            </div>
            <div className="qq-sticker-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  void loadBatchImpact().then(() => bulkUpdate({ enabled: true }));
                }}
              >
                {t("启用所选")}
              </button>
              {confirmingDisable ? (
                <>
                  <span className="hint">
                    {t("停用所选会阻止它们尚未提交的发送；已发出的内容不受影响。")}
                  </span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setConfirmingDisable(false);
                      void bulkUpdate({ enabled: false });
                    }}
                  >
                    {t("确认停用")}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmingDisable(false)}
                  >
                    {t("取消")}
                  </button>
                </>
              ) : (
                <button type="button" disabled={saving} onClick={() => setConfirmingDisable(true)}>
                  {t("停用所选")}
                </button>
              )}
            </div>
            {batchImpact !== null && (
              <p className="hint">
                {batchImpact.length === 0
                  ? t("启用所选后，回复才可能选中它们；目前没有方案授权它们的集合。")
                  : `${t("启用所选后，回复才可能选中它们；会到达的方案：")}${batchImpact.join("、")}`}
              </p>
            )}
          </div>
        )}
        {assets.length === 0 ? (
          <p className="hint">{t("还没有素材。先导入一张图片。")}</p>
        ) : (
          <ul className="qq-sticker-list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <label className="qq-sticker-select">
                  <input
                    type="checkbox"
                    disabled={saving}
                    checked={selected.includes(asset.id)}
                    aria-label={`${t("选择")}${asset.name}`}
                    onChange={(event) =>
                      setSelection(
                        event.target.checked
                          ? [...selected, asset.id]
                          : selected.filter((id) => id !== asset.id),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className={
                    editor?.source.id === asset.id ? "qq-sticker-row active" : "qq-sticker-row"
                  }
                  disabled={saving}
                  aria-current={editor?.source.id === asset.id ? "true" : undefined}
                  onClick={() => openEditor(asset.id)}
                >
                  {/* The list shows the first frame; the detail below is the one that plays. */}
                  <img
                    className="qq-sticker-thumb"
                    src={`/qq/stickers/${asset.id}/preview?still=1`}
                    alt=""
                    loading="lazy"
                  />
                  <span className="qq-sticker-row-text">
                    <span className="qq-sticker-row-head">
                      <strong>{asset.name}</strong>
                      <small
                        className={asset.enabled ? "qq-sticker-state enabled" : "qq-sticker-state"}
                      >
                        {asset.enabled ? t("已启用") : t("已停用")}
                      </small>
                    </span>
                    <small>
                      {asset.media_type === "animation" ? t("动图") : t("静态图")} ·{" "}
                      {formatBytes(asset.byte_size)}
                      {asset.width !== null && asset.height !== null
                        ? ` · ${asset.width}×${asset.height}`
                        : ""}
                    </small>
                    <small>
                      {asset.collection_ids.length === 0
                        ? t("不属于任何集合")
                        : `${t("集合")}：${asset.collection_ids.map(collectionName).join("、")}`}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      {editor && (
        <SettingsGroup
          id="qq-sticker-detail"
          title="素材详情"
          note="保存整理只写内容；开放使用是另一个动作，保存并启用会一并完成。"
        >
          <Field label="名称">
            <input
              value={editor.name}
              disabled={saving}
              aria-label={t("名称")}
              onChange={(event) => patchEditor({ name: event.target.value })}
            />
          </Field>
          <Field label="预览" info="动图在这里播放；列表里显示的是首帧。">
            <img
              className="qq-sticker-preview"
              src={`/qq/stickers/${editor.source.id}/preview`}
              alt={editor.name}
            />
          </Field>
          <Field label="内容说明" info="选图时按说明判断是否贴合语境；说不清就留空，别让模型猜。">
            <textarea
              value={editor.description}
              disabled={saving}
              aria-label={t("内容说明")}
              rows={3}
              onChange={(event) => patchEditor({ description: event.target.value })}
            />
          </Field>
          <Field label="标签" info="用逗号分隔，仅用于你自己的整理。">
            <input
              value={editor.tags}
              disabled={saving}
              aria-label={t("标签")}
              placeholder={t("例如：日常、问候")}
              onChange={(event) => patchEditor({ tags: event.target.value })}
            />
          </Field>
          <Field label="使用说明" info="可选的备注，例如适合在什么场合发。">
            <input
              value={editor.usageNote}
              disabled={saving}
              aria-label={t("使用说明")}
              onChange={(event) => patchEditor({ usageNote: event.target.value })}
            />
          </Field>
          <Field label="所属集合" info="取消勾选只是移出这个集合，素材与文件都保留。">
            {collections.length === 0 ? (
              <p className="hint">{t("还没有集合可归类。")}</p>
            ) : (
              <div className="qq-sticker-memberships">
                {collections.map((collection) => (
                  <label key={collection.id}>
                    <input
                      type="checkbox"
                      disabled={saving}
                      checked={editor.collectionIds.includes(collection.id)}
                      onChange={(event) =>
                        patchEditor({
                          collectionIds: event.target.checked
                            ? [...editor.collectionIds, collection.id]
                            : editor.collectionIds.filter((id) => id !== collection.id),
                        })
                      }
                    />
                    {collection.name}
                  </label>
                ))}
              </div>
            )}
          </Field>
          {/* §9.2's manual generation: the model writes drafts, the user decides. */}
          <div className="qq-sticker-actions">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setAnnotationNotice(null);
                void annotate(editor.source.id).then((result) => {
                  if (result.kind === "rejected") setAnnotationNotice(result.reason);
                });
              }}
            >
              {t("生成说明和标签")}
            </button>
            <button type="button" onClick={() => openRoute("management")}>
              {t("前往默认模型")}
            </button>
          </div>
          {annotationNotice !== null && (
            <p className="hint" role="status">
              {annotationNotice === "model_not_configured"
                ? t("还没有配置图片理解模型：先到默认模型页选一个；未配置＝不能理解图片。")
                : annotationNotice === "capacity_unavailable" ||
                    annotationNotice === "capacity_exceeded"
                  ? t("当前加载的模型没有余量完成这次生成，请换一个模型或稍后再试。")
                  : annotationNotice === "unreadable_answer"
                    ? t("模型没有按要求返回说明和标签，草稿保持为空。")
                    : t("这次生成没有成功，草稿保持为空。")}
            </p>
          )}
          {(editor.source.description_draft !== null || editor.source.tags_draft.length > 0) && (
            <div className="qq-sticker-impact">
              <h4>{t("模型草稿（未审核）")}</h4>
              <p className="hint">{editor.source.description_draft ?? t("（没有说明草稿）")}</p>
              {editor.source.tags_draft.length > 0 && (
                <p className="hint">
                  {t("建议标签")}：{editor.source.tags_draft.join("、")}
                </p>
              )}
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  patchEditor({
                    description: editor.source.description_draft ?? editor.description,
                    tags:
                      editor.source.tags_draft.length > 0
                        ? editor.source.tags_draft.join("、")
                        : editor.tags,
                  })
                }
              >
                {t("把草稿填入编辑器（还需保存）")}
              </button>
            </div>
          )}
          <div className="qq-sticker-actions">
            <button type="button" disabled={saving || !dirty} onClick={() => void saveEditor()}>
              {t("保存整理")}
            </button>
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={() => void saveEditor({ enableAfterSave: true })}
            >
              {t("保存并启用")}
            </button>
            {editor.source.enabled ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void setEnabled(editor.source.id, false)}
              >
                {t("停用素材")}
              </button>
            ) : (
              <button
                type="button"
                disabled={saving || dirty}
                onClick={() => void setEnabled(editor.source.id, true)}
              >
                {t("启用素材")}
              </button>
            )}
            <button
              type="button"
              disabled={saving || !dirty}
              onClick={() => openEditor(editor.source.id)}
            >
              {t("放弃改动")}
            </button>
          </div>
          {dirty && <p className="hint">{t("有未保存的改动；保存前不会影响任何回复。")}</p>}
          {impact && (
            <div className="qq-sticker-impact">
              <h4>{t("启用后的影响范围")}</h4>
              {impact.schemes.length === 0 ? (
                <p className="hint">
                  {t("目前没有方案授权它所在的集合，因此不会被任何回复选中。")}
                </p>
              ) : (
                <>
                  <p className="hint">
                    {t("授权它的方案")}：{impact.schemes.map((scheme) => scheme.name).join("、")}
                  </p>
                  {impact.bindings.length > 0 && (
                    <ul>
                      {impact.bindings.map((binding) => (
                        <li key={`${binding.scheme_id}-${binding.peer_id}`}>
                          {binding.conversation_kind === "group" ? t("群") : t("私聊")}
                          {binding.peer_id}
                          {binding.paused ? `（${t("已暂停")}）` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </SettingsGroup>
      )}
    </>
  );
}
