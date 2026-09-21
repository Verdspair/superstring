import { useEffect } from "react";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Field } from "../../ui/Field";

export function MemoryCorrection() {
  const t = useI18n();
  const entry = useSuperstringStore((s) => s.memoryEntryDetail);
  const content = useSuperstringStore((s) => s.memoryContent);
  const draft = useSuperstringStore((s) => s.memoryCorrectionDraft);
  const dirty = useSuperstringStore((s) => s.memoryCorrectionDirty);
  const saving = useSuperstringStore((s) => s.memoryCorrectionSaving);
  const load = useSuperstringStore((s) => s.loadMemoryContent);
  const patch = useSuperstringStore((s) => s.patchMemoryCorrection);
  const save = useSuperstringStore((s) => s.saveMemoryCorrection);
  const discard = useSuperstringStore((s) => s.discardMemoryCorrection);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  if (!entry) return null;
  const editable =
    content &&
    !content.retired &&
    content.content.validity === "valid" &&
    ["active", "suppressed"].includes(content.status);
  return (
    <div>
      <button type="button" disabled={dirty || saving} onClick={() => void load()}>
        {t("查看来源与纠正内容")}
      </button>
      {content && draft && (
        <>
          <p className="hint">{t("纠正只修改记忆，不改写来源聊天。")}</p>
          <p className="hint">
            {content.content.validity === "valid"
              ? t("来源完整")
              : t("来源缺失或失效，不能纠正或重新启用。")}
            {content.corrected ? ` · ${t("人工纠正")}` : ""}
          </p>
          <Field label={t("记忆名称")}>
            <input
              disabled={!editable || saving}
              aria-label={t("记忆名称")}
              value={draft.name}
              maxLength={100}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={t("记忆摘要")}>
            <textarea
              disabled={!editable || saving}
              rows={3}
              aria-label={t("记忆摘要")}
              value={draft.summary}
              maxLength={500}
              onChange={(e) => patch({ summary: e.target.value })}
            />
          </Field>
          <Field label={t("标签（逗号分隔）")}>
            <input
              disabled={!editable || saving}
              aria-label={t("标签（逗号分隔）")}
              value={draft.tags.join(", ")}
              onChange={(e) =>
                patch({
                  tags: e.target.value.split(/[,，]/).map((s) => s.trim()),
                })
              }
            />
          </Field>
          <Field label={t("记忆正文")}>
            <textarea
              disabled={!editable || saving}
              rows={10}
              aria-label={t("记忆正文")}
              value={draft.body}
              maxLength={16000}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </Field>
          <div className="memory-toolbar">
            <button
              type="button"
              className="primary"
              disabled={!editable || !dirty || saving}
              onClick={() => void save()}
            >
              {saving ? t("正在保存…") : t("保存纠正")}
            </button>
            <button type="button" disabled={saving} onClick={discard}>
              {t("放弃纠正")}
            </button>
          </div>
          {content.content.sources.map(
            (source) =>
              source.type === "chat" && (
                <details key={source.turn_id} className="group">
                  <summary>
                    {t("来源轮次")} · {source.sequence_no} ·{" "}
                    {source.valid ? t("来源完整") : t("来源失效")}
                  </summary>
                  <p className="hint">{source.turn_id}</p>
                  {content.source_messages
                    .filter((item) => item.turn_id === source.turn_id)
                    .map((item) => (
                      <div key={item.turn_id}>
                        <p>{item.session_title}</p>
                        <Field label={t("来源用户原话")}>
                          <textarea readOnly rows={3} value={item.user ?? t("不可用")} />
                        </Field>
                        <Field label={t("来源助手回复")}>
                          <textarea readOnly rows={3} value={item.assistant ?? t("不可用")} />
                        </Field>
                      </div>
                    ))}
                </details>
              ),
          )}
        </>
      )}
    </div>
  );
}
