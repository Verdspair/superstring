import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MemoryScopeView, QqMemoryOrganiseResponse } from "../../../shared/contracts";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { Field } from "../../ui/Field";

const VERDICTS: Record<QqMemoryOrganiseResponse["status"], string> = {
  queued: "已交给整理任务，跑完会出现在记忆列表里。",
  nothing_to_organise: "现在没有待整理的群消息。",
  switch_off: "第三方聊天总开关关着，整理不会花模型调用；先打开开关再试。",
  paused: "这个会话已暂停，暂停期间不新增整理任务。",
  busy: "这个助手正有一个整理任务在跑，等它完成再试。",
  agent_disabled: "这个助手已停用，先启用它再整理。",
};

export function QqMemoryControls({
  binding,
  pending,
  disabled = false,
  onChanged,
  onDirty,
}: {
  binding: NonNullable<MemoryScopeView["binding"]>;
  pending: number;
  disabled?: boolean;
  onChanged: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const draft = useSuperstringStore((s) => s.qqMemoryBatchDrafts[binding.id] ?? null);
  const patch = useSuperstringStore((s) => s.patchQqMemoryBatchDraft);
  const saveDrafts = useSuperstringStore((s) => s.saveQqMemoryBatchDrafts);
  const saving = useSuperstringStore((s) => s.qqMemoryBatchSaving);
  const setDraft = (value: { value: string; revision: number } | null) => patch(binding.id, value);
  const [running, setBusy] = useState(false);
  const busy = running || saving;
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty?.(draft !== null || busy);
    return () => onDirty?.(false);
  }, [draft, busy, onDirty]);
  const value =
    draft?.value ?? (binding.memory_batch_size === null ? "" : String(binding.memory_batch_size));
  const count = value.trim() === "" ? null : Number(value);
  const valid = count === null || (Number.isSafeInteger(count) && count >= 1);
  const run = async (save: boolean) => {
    if (busy || disabled || (save && !valid)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (save) {
        const saved = await saveDrafts([binding.id]);
        if (!alive.current) return;
        if (!saved) {
          setError(useSuperstringStore.getState().error ?? t("保存未成功"));
          return;
        }
        setNotice(t("整理条数已保存。"));
      } else {
        const result = await api.organiseQqMemory(binding.id);
        if (!alive.current) return;
        setNotice(t(VERDICTS[result.status]));
        if (result.status !== "queued") return;
      }
      onChanged();
    } catch (reason) {
      if (alive.current) setError(errorText(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="memory-qq-controls min-w-0 space-y-4">
      <div className="memory-toolbar flex flex-wrap items-center gap-3">
        <Field label="自动整理条数" info="留空＝不自动整理">
          <Input
            aria-label={t("自动整理条数")}
            type="number"
            min={1}
            value={value}
            aria-invalid={!valid}
            disabled={disabled || busy}
            onChange={(event) =>
              setDraft({ value: event.target.value, revision: draft?.revision ?? binding.revision })
            }
          />
        </Field>
        <Button
          variant="outline"
          type="button"
          disabled={disabled || busy || !valid || draft === null}
          onClick={() => void run(true)}
        >
          {t("保存条数")}
        </Button>
        {draft && (
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
          >
            {t("放弃条数修改")}
          </Button>
        )}
        <Button
          variant="outline"
          type="button"
          disabled={disabled || busy || binding.paused || !binding.enabled || pending === 0}
          onClick={() => void run(false)}
        >
          {t("立即整理")}
        </Button>
        <span className="hint text-sm leading-relaxed text-muted-foreground">
          {t("待整理 {0} 条", pending)}
        </span>
      </div>
      <p className="hint text-sm leading-relaxed text-muted-foreground">
        {t("按本会话的文字消息条数自动整理；立即整理忽略条数门槛，使用当前助手的整理模型与规则。")}
      </p>
      {!valid && (
        <p className="error text-sm text-destructive" role="alert">
          {t("条数需为正整数，留空表示关闭。")}
        </p>
      )}
      {binding.paused && (
        <p className="hint text-sm leading-relaxed text-muted-foreground">{t(VERDICTS.paused)}</p>
      )}
      {!binding.enabled && (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t(VERDICTS.switch_off)}
        </p>
      )}
      {notice && (
        <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error text-sm text-destructive" role="alert">
          {translateNotice(error)}
        </p>
      )}
    </div>
  );
}
