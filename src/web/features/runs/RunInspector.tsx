import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import type { AgentStepSnapshot, RunStatus } from "../../../shared/contracts/agent-run";
import { translateNotice, useI18n } from "../../i18n";
import { startRead } from "../../services/read-task";
import { StepContext } from "./StepContext";

export { ContextContent, StepContext } from "./StepContext";

import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { localTime } from "../../ui/local-time";
import { runOwnerKey } from "./run-state";

const runLabels: Record<RunStatus, string> = {
  prepared: "等待处理",
  deciding: "正在准备",
  observing: "正在读取资料",
  generating: "正在回复",
  completed: "运行已完成",
  no_output: "本次未发言",
  failed: "运行失败",
  cancelled: "运行已取消",
};
export function runStatusLabel(status: RunStatus, phase?: AgentStepSnapshot["phase"]): string {
  if (status === "generating" && phase === "leaf") return "正在处理";
  if (status === "generating" && phase === "vision") return "正在理解图片";
  return runLabels[status];
}

const phaseLabels = {
  leaf: "单轮任务",
  next: "行动判断",
  generate: "生成回复",
  vision: "图片理解",
};

/** The trigger stays mounted so Radix can restore focus after dismissal. */
export function JobRunLink(props: { ownerKind: string; ownerId: string }) {
  return <InspectorDialog {...props} />;
}
export function RunLink(props: { runId: string }) {
  return <InspectorDialog {...props} />;
}
function InspectorDialog(props: { ownerKind: string; ownerId: string } | { runId: string }) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="link-button">
          {t("运行详情")}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="run-inspector-overlay" />
        <Dialog.Content
          className="run-inspector"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            close.current?.focus();
          }}
        >
          <header className="run-inspector-heading">
            <div>
              <Dialog.Title>{t("运行详情")}</Dialog.Title>
              <Dialog.Description>{t("查看本任务的模型运行、步骤与实际输入。")}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button ref={close} type="button" aria-label={t("关闭运行详情")}>
                {t("关闭")}
              </button>
            </Dialog.Close>
          </header>
          <div className="run-inspector-body">
            {"runId" in props ? (
              <RunDetails key={props.runId} runId={props.runId} />
            ) : (
              <OwnerRuns
                key={runOwnerKey(props.ownerKind, props.ownerId)}
                ownerKind={props.ownerKind}
                ownerId={props.ownerId}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OwnerRuns({ ownerKind, ownerId }: { ownerKind: string; ownerId: string }) {
  const t = useI18n();
  const load = useSuperstringStore((s) => s.loadOwnerRuns);
  const ids = useSuperstringStore((s) => s.runIdsByOwner[runOwnerKey(ownerKind, ownerId)]);
  const runs = useSuperstringStore((s) => s.runById);
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit user refresh trigger.
  useEffect(() => {
    setLoading(true);
    setError("");
    const task = startRead((signal) => load(ownerKind, ownerId, signal), {
      success: (result) =>
        setSelected((current) =>
          result.some((run) => run.runId === current) ? current : (result[0]?.runId ?? ""),
        ),
      failure: (reason) => setError(errorText(reason)),
      settled: () => setLoading(false),
    });
    return () => task.cancel();
  }, [load, ownerKind, ownerId, revision]);
  return (
    <>
      <div className="run-inspector-toolbar">
        <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          {t("刷新运行记录")}
        </button>
        {loading && <span role="status">{t("正在读取运行记录…")}</span>}
      </div>
      {error && (
        <p className="error" role="alert">
          {translateNotice(error)}
        </p>
      )}
      {!loading && !error && !ids?.length && (
        <p className="hint">{t("此任务暂无运行记录；排队任务与迁移前任务可能尚未留下记录。")}</p>
      )}
      {!!ids?.length && (
        <label className="run-attempt-select">
          <span>{t("运行尝试")}</span>
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            {ids.map((id) => (
              <option key={id} value={id}>
                {localTime(runs[id]?.snapshot?.startedAt ?? "")} ·{" "}
                {t(
                  runStatusLabel(
                    runs[id]?.status ?? "prepared",
                    runs[id]?.snapshot?.steps.at(-1)?.phase,
                  ),
                )}{" "}
                · {id}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && <RunDetails key={`${selected}:${revision}`} runId={selected} />}
    </>
  );
}

export function RunDetails({ runId }: { runId: string }) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const receive = useSuperstringStore((s) => s.receiveRunSnapshot);
  const view = useSuperstringStore((s) => s.runById[runId]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    const task = startRead((signal) => api.getRun(runId, signal), {
      success: receive,
      failure: (reason) => setError(errorText(reason)),
    });
    return () => task.cancel();
  }, [api, receive, runId]);
  const run = view?.snapshot;
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const selectedStep = run?.steps.find((step) => step.stepId === selectedStepId) ?? run?.steps[0];
  return (
    <section className="run-details" aria-label={t("选中运行的详情")}>
      {error && (
        <p className="error" role="alert">
          {translateNotice(error)}
        </p>
      )}
      {run ? (
        <>
          <p className="run-status" data-status={view.status} role="status">
            {t(runStatusLabel(view.status, run.steps.at(-1)?.phase))}
          </p>
          <dl className="run-metadata">
            <div>
              <dt>{t("运行 ID")}</dt>
              <dd>
                <code>{run.runId}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Agent 配置")}</dt>
              <dd>
                {run.specId} · {run.specVersion}
              </dd>
            </div>
            <div>
              <dt>{t("开始时间")}</dt>
              <dd>{localTime(run.startedAt)}</dd>
            </div>
            {run.endedAt && (
              <div>
                <dt>{t("结束时间")}</dt>
                <dd>{localTime(run.endedAt)}</dd>
              </div>
            )}
          </dl>
          {view.errorCode && <p className="error">{t("错误代码：{0}", view.errorCode)}</p>}
          {view.status === "completed" && (
            <p className="hint">{t("运行完成表示模型任务已完成；外部消息的送达结果单独记录。")}</p>
          )}
          <h3>{t("模型步骤")}</h3>
          {!run.steps.length && <p className="hint">{t("尚未开始模型步骤。")}</p>}
          <div className="run-steps-workspace">
            <ol className="run-step-list">
              {run.steps.map((step) => (
                <li
                  key={step.stepId}
                  className="run-step"
                  data-selected={selectedStep?.stepId === step.stepId}
                >
                  <button
                    type="button"
                    className="run-step-select"
                    aria-pressed={selectedStep?.stepId === step.stepId}
                    onClick={() => setSelectedStepId(step.stepId)}
                  >
                    <strong>{t("步骤 {0} · {1}", step.stepNo, t(phaseLabels[step.phase]))}</strong>
                    <span>{t(step.status === "running" ? "执行中" : runLabels[step.status])}</span>
                    <small>{t("模型：{0}", step.model)}</small>
                  </button>
                  {step.errorCode && <p className="error">{t("错误代码：{0}", step.errorCode)}</p>}
                </li>
              ))}
            </ol>
            {selectedStep && (
              <section className="run-selected-step" aria-label={t("选中模型步骤")}>
                <StepContext key={selectedStep.stepId} context={selectedStep.context} />
              </section>
            )}
          </div>
        </>
      ) : (
        !error && <p role="status">{t("正在读取运行记录…")}</p>
      )}
    </section>
  );
}
