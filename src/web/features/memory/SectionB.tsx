import { useLayoutEffect, useRef, useState } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { localTime } from "../../ui/local-time";
import { MemoryCorrection } from "./MemoryCorrection";

export function SectionB() {
  const t = useI18n();
  const memorySessions = useSuperstringStore((s) => s.memorySessions);
  const memoryTurns = useSuperstringStore((s) => s.memoryTurns);
  const memoryEntries = useSuperstringStore((s) => s.memoryEntries);
  const total = useSuperstringStore((s) => s.memoryEntryTotal);
  const detail = useSuperstringStore((s) => s.memoryEntryDetail);
  const feedback = useSuperstringStore((s) => s.feedback);
  const correctionDirty = useSuperstringStore(
    (s) => s.memoryCorrectionDirty || s.memoryCorrectionSaving,
  );
  const loadMemoryTurns = useSuperstringStore((s) => s.loadMemoryTurns);
  const loadMemoryPage = useSuperstringStore((s) => s.loadMemoryPage);
  const loadMemoryEntryDetail = useSuperstringStore((s) => s.loadMemoryEntryDetail);
  const manualConsolidate = useSuperstringStore((s) => s.manualConsolidate);
  const editorAgentId = useSuperstringStore((s) => s.editorAgentId);
  const governMemories = useSuperstringStore((s) => s.governMemories);
  const mergeMemories = useSuperstringStore((s) => s.mergeMemories);
  const clearMemoryDetail = useSuperstringStore((s) => s.clearMemoryDetail);
  const clearMemoryTurns = useSuperstringStore((s) => s.clearMemoryTurns);
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [recentTurnCount, setRecentTurnCount] = useState(20);
  const [selectedTurns, setSelectedTurns] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selectedMemories, setSelectedMemories] = useState<string[]>([]);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [turnsLoaded, setTurnsLoaded] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const resetManagement = useSuperstringStore((s) => s.resetMemoryManagement);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (useSuperstringStore.getState().editorAgentId === editorAgentId) resetManagement();
    };
  }, [resetManagement, editorAgentId]);
  const locked = busy || correctionDirty || editorAgentId === "__new__";
  const validTurns = selectedTurns.filter((id) => memoryTurns.some((turn) => turn.id === id));
  const validMemories = selectedMemories.filter((id) =>
    memoryEntries.some((entry) => entry.id === id),
  );
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const resetMemorySelection = () => {
    setSelectedMemories([]);
    setPurgeConfirmed(false);
    clearMemoryDetail();
  };
  const govern = async (action: "suppress" | "enable" | "purge") => {
    if (locked) return;
    await run(async () => {
      const ok = await governMemories(editorAgentId, validMemories, action, purgeConfirmed);
      if (!mounted.current || useSuperstringStore.getState().editorAgentId !== editorAgentId)
        return;
      if (ok) {
        resetMemorySelection();
        await loadMemoryPage(page);
      } else setPurgeConfirmed(false);
    });
  };
  const merge = async () => {
    if (locked) return;
    await run(async () => {
      const ok = await mergeMemories(editorAgentId, validMemories);
      if (!mounted.current || useSuperstringStore.getState().editorAgentId !== editorAgentId)
        return;
      if (ok) resetMemorySelection();
      else setPurgeConfirmed(false);
    });
  };
  const statusLabel = {
    active: t("生效"),
    suppressed: t("已屏蔽"),
    replaced: t("已被替代"),
    invalid: t("来源失效"),
  } as const;

  return (
    <section
      id="settings-memory-management"
      className="memory-management"
      aria-label={t("记忆管理")}
      aria-busy={busy}
    >
      <div className="memory-management-heading">
        <h3>{t("记忆管理")}</h3>
        <p className="hint">{t("仅管理当前助手记忆；操作不提交配置草稿。")}</p>
      </div>
      <SettingsGroup title="手动整理" note="选择会话的完整轮次，整理为长期记忆。">
        <div className="memory-source-toolbar">
          <Field label={t("来源会话")}>
            <select
              aria-label={t("来源会话")}
              value={sourceSessionId}
              disabled={busy}
              onChange={(event) => {
                setSourceSessionId(event.target.value);
                setSelectedTurns([]);
                setTurnsLoaded(false);
                clearMemoryTurns();
              }}
            >
              <option value="">{t("请选择会话")}</option>
              {memorySessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("最近轮数")}>
            <input
              type="number"
              aria-label={t("最近轮数")}
              min={1}
              max={200}
              value={recentTurnCount}
              disabled={busy}
              onChange={(e) => setRecentTurnCount(Number(e.target.value))}
            />
          </Field>
          <button
            type="button"
            disabled={
              busy ||
              !sourceSessionId ||
              !Number.isInteger(recentTurnCount) ||
              recentTurnCount < 1 ||
              recentTurnCount > 200
            }
            onClick={() =>
              void run(async () => {
                setSelectedTurns([]);
                await loadMemoryTurns(sourceSessionId, recentTurnCount);
                setTurnsLoaded(true);
              })
            }
          >
            {t("加载可选择的轮次")}
          </button>
        </div>
        <p className="hint">{t("可重复整理完整轮次，不改变自动整理进度。")}</p>
        {memoryTurns.length > 0 ? (
          <fieldset className="choice-group memory-selection-list">
            <legend>{t("选择完整轮次")}</legend>
            {memoryTurns.map((turn) => (
              <label key={turn.id} className="memory-row">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={validTurns.includes(turn.id)}
                  onChange={(e) =>
                    setSelectedTurns((items) =>
                      e.target.checked ? [...items, turn.id] : items.filter((id) => id !== turn.id),
                    )
                  }
                />
                <span>
                  <strong>
                    {t("轮次 {0}", turn.sequence_no)} · {turn.processed ? t("已整理") : t("未整理")}
                  </strong>
                  <small>{t("用户：{0}", turn.user.slice(0, 100))}</small>
                  <small>{t("回复：{0}", turn.assistant.slice(0, 100))}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="memory-empty">
            {turnsLoaded
              ? t("当前范围没有可整理的完整轮次。")
              : t("选择来源会话、加载轮次，再勾选要整理的内容。")}
          </p>
        )}
        <div className="memory-toolbar">
          <span className="hint">{t("已选 {0} 轮", validTurns.length)}</span>
          <button
            type="button"
            className="primary"
            disabled={busy || !sourceSessionId || validTurns.length === 0}
            onClick={() => void run(() => manualConsolidate(sourceSessionId, validTurns))}
          >
            {t("开始整理所选轮次")}
          </button>
        </div>
      </SettingsGroup>
      <SettingsGroup title="记忆列表与治理" note="查看、整合、屏蔽、启用或永久删除已生成的记忆。">
        <div className="memory-list-toolbar">
          <Field label={t("列表页码")}>
            <input
              type="number"
              aria-label={t("列表页码")}
              min={1}
              value={page}
              disabled={locked}
              onChange={(e) => setPage(Number(e.target.value))}
            />
          </Field>
          <button
            type="button"
            disabled={locked || !Number.isInteger(page) || page < 1}
            onClick={() =>
              void run(async () => {
                resetMemorySelection();
                await loadMemoryPage(page);
                setListLoaded(true);
              })
            }
          >
            {t("加载记忆列表")}
          </button>
          <span className="hint">
            {listLoaded ? t("共 {0} 条记忆，每页最多 100 条。", total) : t("每页最多 100 条。")}
          </span>
        </div>
        {memoryEntries.length > 0 ? (
          <section className="memory-entry-list" aria-label={t("记忆列表")}>
            {memoryEntries.map((entry) => (
              <div
                key={entry.id}
                className={`memory-entry-row${detail?.id === entry.id ? " is-current" : ""}`}
              >
                <label className="memory-row">
                  <input
                    type="checkbox"
                    aria-label={t("选择记忆：{0}", entry.name)}
                    disabled={locked}
                    checked={validMemories.includes(entry.id)}
                    onChange={(e) => {
                      setSelectedMemories((items) =>
                        e.target.checked
                          ? [...items, entry.id]
                          : items.filter((id) => id !== entry.id),
                      );
                      setPurgeConfirmed(false);
                    }}
                  />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {statusLabel[entry.status]} · {localTime(entry.created_at)}
                    </small>
                    <small>{entry.summary}</small>
                  </span>
                </label>
                <button
                  type="button"
                  aria-label={t("查看记忆：{0}", entry.name)}
                  disabled={locked}
                  onClick={() => void run(() => loadMemoryEntryDetail(entry.id))}
                >
                  {t("查看详情")}
                </button>
              </div>
            ))}
          </section>
        ) : (
          <p className="memory-empty">
            {listLoaded ? t("本页暂无记忆。") : t("加载后查看详情，或勾选多条批量管理。")}
          </p>
        )}
        <div className="memory-batch-actions">
          <span className="hint">{t("已选 {0} 条", validMemories.length)}</span>
          <div className="memory-toolbar">
            <button
              type="button"
              disabled={locked || validMemories.length === 0}
              onClick={() => void merge()}
            >
              {t("整合为新记忆")}
            </button>
            <button
              type="button"
              disabled={locked || validMemories.length === 0}
              onClick={() => void govern("suppress")}
            >
              {t("屏蔽（停止使用）")}
            </button>
            <button
              type="button"
              disabled={locked || validMemories.length === 0}
              onClick={() => void govern("enable")}
            >
              {t("重新启用")}
            </button>
          </div>
        </div>
        {detail && (
          <section className="memory-detail-panel" aria-label={t("记忆详情（只读）")}>
            <h4>{detail.name}</h4>
            <p className="hint">{t("存储时间：{0}", localTime(detail.created_at))}</p>
            <p>{detail.summary}</p>
            <div className="memory-detail-body">{detail.body}</div>
            <MemoryCorrection />
          </section>
        )}
        {correctionDirty && (
          <p className="hint">{t("请先保存或放弃纠正，再切换记忆或执行治理。")}</p>
        )}
        <div className="memory-danger-zone">
          <h4>{t("永久删除")}</h4>
          <p className="hint">
            {t("永久删除只删除所选记忆条目且不可恢复；派生记忆、摘要和原聊天保留。")}
          </p>
          {validMemories.length > 0 && (
            <p className="hint">
              {t(
                "删除对象：{0}",
                memoryEntries
                  .filter((entry) => validMemories.includes(entry.id))
                  .map((entry) => entry.name)
                  .join("、"),
              )}
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              disabled={locked || validMemories.length === 0}
              checked={purgeConfirmed}
              onChange={(e) => setPurgeConfirmed(e.target.checked)}
            />
            <span>{t("我确认永久删除当前勾选的记忆条目")}</span>
          </label>
          <button
            type="button"
            className="danger"
            disabled={locked || validMemories.length === 0 || !purgeConfirmed}
            onClick={() => void govern("purge")}
          >
            {t("永久删除所选条目")}
          </button>
        </div>
      </SettingsGroup>
      {feedback && (
        <p className="memory-feedback" role="status">
          {translateNotice(feedback)}
        </p>
      )}
    </section>
  );
}
