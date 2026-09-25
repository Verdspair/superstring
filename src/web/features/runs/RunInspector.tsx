import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import type {
  AgentStepSnapshot,
  InspectedContext,
  RunStatus,
} from "../../../shared/contracts/agent-run";
import { translateNotice, useI18n } from "../../i18n";
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
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void load(ownerKind, ownerId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSelected((current) =>
          result.some((run) => run.runId === current) ? current : (result[0]?.runId ?? ""),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
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
    const controller = new AbortController();
    void api
      .getRun(runId, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) receive(snapshot);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      });
    return () => controller.abort();
  }, [api, receive, runId]);
  const run = view?.snapshot;
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
          <ol className="run-step-list">
            {run.steps.map((step) => (
              <li key={step.stepId} className="run-step">
                <div className="run-step-heading">
                  <strong>{t("步骤 {0} · {1}", step.stepNo, t(phaseLabels[step.phase]))}</strong>
                  <span>{t(step.status === "running" ? "执行中" : runLabels[step.status])}</span>
                </div>
                <p className="hint">{t("模型：{0}", step.model)}</p>
                {step.errorCode && <p className="error">{t("错误代码：{0}", step.errorCode)}</p>}
                <StepContext step={step} />
              </li>
            ))}
          </ol>
        </>
      ) : (
        !error && <p role="status">{t("正在读取运行记录…")}</p>
      )}
    </section>
  );
}

function StepContext({ step }: { step: AgentStepSnapshot }) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const [context, setContext] = useState<InspectedContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const clear = () => {
    request.current?.abort();
    request.current = null;
    setContext(null);
    setLoading(false);
    setError("");
  };
  useEffect(() => {
    const discard = () => {
      request.current?.abort();
      request.current = null;
      setContext(null);
      setLoading(false);
      setError("");
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") discard();
    };
    window.addEventListener("blur", discard);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      request.current?.abort();
      window.removeEventListener("blur", discard);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const inspect = async () => {
    clear();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await api.inspectRunContext(step.context, controller.signal);
      if (!controller.signal.aborted) setContext(result);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorText(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return (
    <div className="run-context">
      <div className="run-inspector-toolbar">
        <button type="button" disabled={loading} onClick={() => void inspect()}>
          {t(context ? "重新核对实际输入" : "查看实际输入")}
        </button>
        {(context || loading) && (
          <button type="button" onClick={clear}>
            {t("收起实际输入")}
          </button>
        )}
      </div>
      {loading && <p role="status">{t("正在核对来源权限与保留状态…")}</p>}
      {error && (
        <p className="error" role="alert">
          {translateNotice(error)}
        </p>
      )}
      {context && <ContextContent context={context} />}
    </div>
  );
}

export function ContextContent({ context }: { context: InspectedContext }) {
  const t = useI18n();
  const statusText = {
    exact: "可查看当时的精确文本输入。",
    partial: "文本可查看；部分图片原始字节不可重取，来源与校验值仍可核对。",
    expired: "来源保留期已结束，实际输入已清除；仅保留布局元数据。",
    revoked: "来源已撤权或删除，实际输入不可查看；仅保留允许的元数据。",
  };
  const readable = context.status === "exact" || context.status === "partial";
  return (
    <div className="run-context-content">
      <p className="hint" role="status">
        {t(statusText[context.status])}
      </p>
      <ul className="run-context-layout">
        {context.layout.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Model input layout is an immutable ordered snapshot.
          <li key={`${index}:${item.role}`}>
            <code>{item.role}</code> ·{" "}
            {t("{0} 单位 · {1} 个来源", item.units, item.sourceIds.length)}
          </li>
        ))}
      </ul>
      {readable &&
        context.exactMessages?.map((message, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Message order is intrinsic to this immutable model input.
          <details key={`${index}:${message.role}`} className="run-context-message">
            <summary>{t("消息 {0} · {1}", index + 1, message.role)}</summary>
            {message.content.map((content, part) =>
              content.kind === "text" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: Content parts keep their fixed position in the snapshot.
                <pre key={`${index}:${part}`}>{content.text}</pre>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: Multiple immutable image frames may share a source and hash.
                <dl key={`${content.sourceId}:${content.sha256}:${part}`} className="run-metadata">
                  <div>
                    <dt>{t("图片来源")}</dt>
                    <dd>{content.sourceId}</dd>
                  </div>
                  <div>
                    <dt>{t("来源版本")}</dt>
                    <dd>{content.revision}</dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd>
                      <code>{content.sha256}</code>
                    </dd>
                  </div>
                </dl>
              ),
            )}
          </details>
        ))}
      {readable &&
        context.unavailableMedia?.map((item) => (
          <p className="hint" key={`${item.sourceId}:${item.sha256}`}>
            {t("图片不可重取：{0}；SHA-256：{1}", item.sourceId, item.sha256)}
          </p>
        ))}
      {!!context.sourceVersions.length && (
        <details className="run-context-message">
          <summary>{t("来源与版本")}</summary>
          <ul>
            {context.sourceVersions.map((source) => (
              <li key={`${source.id}:${source.revision}`}>
                <code>{source.id}</code> · {source.revision}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
