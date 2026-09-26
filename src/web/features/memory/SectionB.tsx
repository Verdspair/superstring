import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { localTime } from "../../ui/local-time";
import { MemoryCorrection } from "./MemoryCorrection";
import { MemoryScopePanel } from "./MemoryScopePanel";
import { memoryScopeLabel } from "./scope-label";

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
  const loadMemoryPageRaw = useSuperstringStore((s) => s.loadMemoryPage);
  const loadMemory = useSuperstringStore((s) => s.loadMemoryPolicy);
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
  const [scopeKey, setScopeKey] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const loadMemoryPage = (next: number) =>
    loadMemoryPageRaw(next, {
      scope_key: scopeKey || undefined,
      search: search || undefined,
      status: status || undefined,
    });
  const resetManagement = useSuperstringStore((s) => s.resetMemoryManagement);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (useSuperstringStore.getState().editorAgentId === editorAgentId) resetManagement();
    };
  }, [resetManagement, editorAgentId]);
  useEffect(() => {
    if (editorAgentId === "__new__") return;
    // 整理策略与来源会话由这一跳加载（面板要显示网页自动整理的真实状态），随后再读列表——但只在
    // 列表本来就空的时候读：这一跳是为了"打开就看得到"，不是为了把已经在看的内容换掉。
    void loadMemory().then(() => {
      if (!mounted.current) return;
      if (useSuperstringStore.getState().memoryEntries.length > 0) {
        setListLoaded(true);
        return;
      }
      void loadMemoryPageRaw(1).then(() => {
        if (mounted.current) setListLoaded(true);
      });
    });
  }, [editorAgentId, loadMemory, loadMemoryPageRaw]);
  const locked = busy || correctionDirty || editorAgentId === "__new__";
  const validTurns = selectedTurns.filter((id) => memoryTurns.some((turn) => turn.id === id));
  const validMemories = selectedMemories.filter((id) =>
    memoryEntries.some((entry) => entry.id === id),
  );
  const selectedEntries = memoryEntries.filter((entry) => validMemories.includes(entry.id));
  const mergeable =
    selectedEntries.length >= 2 &&
    selectedEntries.every(
      (entry) => entry.status === "active" && entry.scope_key === selectedEntries[0].scope_key,
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
      className="memory-management min-w-0 space-y-5"
      aria-label={t("记忆管理")}
      aria-busy={busy}
    >
      <div className="memory-management-heading space-y-2 [&>h3]:text-base [&>h3]:font-semibold">
        <h3>{t("记忆管理")}</h3>
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("仅管理当前助手记忆；操作不提交配置草稿。")}
        </p>
      </div>
      <MemoryScopePanel
        value={scopeKey}
        disabled={locked}
        onChange={(key) => {
          resetMemorySelection();
          clearMemoryTurns();
          setSelectedTurns([]);
          setTurnsLoaded(false);
          setScopeKey(key);
          setPage(1);
          setSearch("");
          setStatus("");
          void run(async () => {
            await loadMemoryPageRaw(1, { scope_key: key || undefined });
            setListLoaded(true);
          });
        }}
      />
      {(!scopeKey || scopeKey === editorAgentId) && (
        <SettingsGroup
          title="手动整理"
          note="选择网页会话的完整轮次，整理结果存入网页分区；QQ 会话请在上方选择对应分区。"
        >
          <div className="memory-source-toolbar grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
            <Field label={t("来源会话")}>
              <NativeSelect
                className="w-full"
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
              </NativeSelect>
            </Field>
            <Field label={t("最近轮数")}>
              <Input
                type="number"
                aria-label={t("最近轮数")}
                min={1}
                max={200}
                value={recentTurnCount}
                disabled={busy}
                onChange={(e) => setRecentTurnCount(Number(e.target.value))}
              />
            </Field>
            <Button
              variant="outline"
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
            </Button>
          </div>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("可重复整理完整轮次，不改变自动整理进度。")}
          </p>
          {memoryTurns.length > 0 ? (
            <fieldset className="choice-group memory-selection-list grid max-h-96 gap-3 overflow-y-auto rounded-lg border p-4 [&>legend]:px-2 [&>legend]:text-sm [&>legend]:font-medium">
              <legend>{t("选择完整轮次")}</legend>
              {memoryTurns.map((turn) => (
                <Label
                  key={turn.id}
                  className="memory-row flex min-w-0 flex-1 items-start gap-3 text-sm [&>span]:grid [&>span]:min-w-0 [&>span]:flex-1 [&>span]:gap-1 [&_strong]:font-medium [&_small]:text-muted-foreground [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground"
                >
                  <Checkbox
                    disabled={busy}
                    aria-label={`${t("来源轮次")} ${turn.sequence_no}`}
                    checked={validTurns.includes(turn.id)}
                    onCheckedChange={(checkedValue) =>
                      setSelectedTurns((items) =>
                        checkedValue === true
                          ? [...items, turn.id]
                          : items.filter((id) => id !== turn.id),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {t("轮次 {0}", turn.sequence_no)} ·{" "}
                      {turn.processed ? t("已整理") : t("未整理")}
                    </strong>
                    <small>{t("用户：{0}", turn.user.slice(0, 100))}</small>
                    <small>{t("回复：{0}", turn.assistant.slice(0, 100))}</small>
                  </span>
                </Label>
              ))}
            </fieldset>
          ) : (
            <p className="memory-empty rounded-lg border border-dashed bg-muted/30 p-5 text-sm text-muted-foreground">
              {turnsLoaded
                ? t("当前范围没有可整理的完整轮次。")
                : t("选择来源会话、加载轮次，再勾选要整理的内容。")}
            </p>
          )}
          <div className="memory-toolbar flex flex-wrap items-center gap-3">
            <span className="hint text-sm leading-relaxed text-muted-foreground">
              {t("已选 {0} 轮", validTurns.length)}
            </span>
            <Button
              variant="default"
              type="button"
              className="primary"
              disabled={busy || !sourceSessionId || validTurns.length === 0}
              onClick={() => void run(() => manualConsolidate(sourceSessionId, validTurns))}
            >
              {t("开始整理所选轮次")}
            </Button>
          </div>
        </SettingsGroup>
      )}
      <SettingsGroup title="记忆列表与治理" note="查看、整合、屏蔽、启用或永久删除已生成的记忆。">
        <div className="memory-list-toolbar flex flex-wrap items-end gap-3 [&>.field]:min-w-0 [&>.field]:flex-1">
          <Field label="搜索记忆">
            <Input
              aria-label={t("搜索记忆")}
              value={search}
              maxLength={200}
              disabled={locked}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="记忆状态">
            <NativeSelect
              className="w-full"
              aria-label={t("记忆状态")}
              value={status}
              disabled={locked}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">{t("全部状态")}</option>
              {Object.entries(statusLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("列表页码")}>
            <Input
              type="number"
              aria-label={t("列表页码")}
              min={1}
              value={page}
              disabled={locked}
              onChange={(e) => setPage(Number(e.target.value))}
            />
          </Field>
          <Button
            variant="outline"
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
          </Button>
          <span className="hint text-sm leading-relaxed text-muted-foreground">
            {listLoaded ? t("共 {0} 条记忆，每页最多 100 条。", total) : t("每页最多 100 条。")}
          </span>
        </div>
        {memoryEntries.length > 0 ? (
          <section
            className="memory-entry-list max-h-[28rem] divide-y overflow-y-auto rounded-lg border"
            aria-label={t("记忆列表")}
          >
            {memoryEntries.map((entry) => (
              <div
                key={entry.id}
                className={`memory-entry-row flex flex-wrap items-center gap-3 p-4 ${detail?.id === entry.id ? "is-current bg-accent/50" : "bg-card"}`}
              >
                <Label className="memory-row flex min-w-0 flex-1 items-start gap-3 text-sm [&>span]:grid [&>span]:min-w-0 [&>span]:flex-1 [&>span]:gap-1 [&_strong]:font-medium [&_small]:text-muted-foreground [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
                  <Checkbox
                    aria-label={t("选择记忆：{0}", entry.name)}
                    disabled={locked}
                    checked={validMemories.includes(entry.id)}
                    onCheckedChange={(checkedValue) => {
                      setSelectedMemories((items) =>
                        checkedValue === true
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
                      {" · "}
                      {memoryScopeLabel(entry.scope_key, editorAgentId, t)}
                    </small>
                    <small>{entry.summary}</small>
                  </span>
                </Label>
                <Button
                  variant="outline"
                  type="button"
                  aria-label={t("查看记忆：{0}", entry.name)}
                  disabled={locked}
                  onClick={() => void run(() => loadMemoryEntryDetail(entry.id))}
                >
                  {t("查看详情")}
                </Button>
              </div>
            ))}
          </section>
        ) : (
          <p className="memory-empty rounded-lg border border-dashed bg-muted/30 p-5 text-sm text-muted-foreground">
            {listLoaded ? t("本页暂无记忆。") : t("加载后查看详情，或勾选多条批量管理。")}
          </p>
        )}
        <div className="memory-batch-actions flex flex-wrap items-center gap-3">
          <span className="hint text-sm leading-relaxed text-muted-foreground">
            {t("已选 {0} 条", validMemories.length)}
          </span>
          <div className="memory-toolbar flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              type="button"
              disabled={locked || !mergeable}
              onClick={() => void merge()}
            >
              {t("整合为新记忆")}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={locked || validMemories.length === 0}
              onClick={() => void govern("suppress")}
            >
              {t("屏蔽（停止使用）")}
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={locked || validMemories.length === 0}
              onClick={() => void govern("enable")}
            >
              {t("重新启用")}
            </Button>
          </div>
        </div>
        {validMemories.length > 0 && !mergeable && (
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("整合需要至少两条同一分区的生效记忆；屏蔽和删除可以跨分区选择。")}
          </p>
        )}
        {detail && (
          <Card
            role="region"
            className="memory-detail-panel gap-4 p-5 [&>h4]:font-semibold"
            aria-label={t("记忆详情（只读）")}
          >
            <h4>{detail.name}</h4>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("存储时间：{0}", localTime(detail.created_at))}
            </p>
            <p>{detail.summary}</p>
            <div className="memory-detail-body max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
              {detail.body}
            </div>
            <MemoryCorrection />
          </Card>
        )}
        {correctionDirty && (
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("请先保存或放弃纠正，再切换记忆或执行治理。")}
          </p>
        )}
        <div className="memory-danger-zone space-y-4 border-t pt-5 [&>h4]:text-sm [&>h4]:font-semibold [&>h4]:text-destructive">
          <h4>{t("永久删除")}</h4>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("永久删除只删除所选记忆条目且不可恢复；派生记忆、摘要和原聊天保留。")}
          </p>
          {validMemories.length > 0 && (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t(
                "删除对象：{0}",
                memoryEntries
                  .filter((entry) => validMemories.includes(entry.id))
                  .map((entry) => entry.name)
                  .join("、"),
              )}
            </p>
          )}
          <Label className="check flex items-start gap-3 text-sm [&>span]:grid [&>span]:gap-1 [&_small]:text-muted-foreground [&_small]:font-normal">
            <Checkbox
              disabled={locked || validMemories.length === 0}
              aria-label={t("我确认永久删除当前勾选的记忆条目")}
              checked={purgeConfirmed}
              onCheckedChange={(checkedValue) => setPurgeConfirmed(checkedValue === true)}
            />
            <span>{t("我确认永久删除当前勾选的记忆条目")}</span>
          </Label>
          <Button
            variant="destructive"
            type="button"
            className="danger"
            disabled={locked || validMemories.length === 0 || !purgeConfirmed}
            onClick={() => void govern("purge")}
          >
            {t("永久删除所选条目")}
          </Button>
        </div>
      </SettingsGroup>
      {feedback && (
        <p
          className="memory-feedback rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground"
          role="status"
        >
          {translateNotice(feedback)}
        </p>
      )}
    </section>
  );
}
