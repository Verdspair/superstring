import * as Tabs from "@radix-ui/react-tabs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextHandle, InspectedContext } from "../../../shared/contracts/agent-run";
import { translateNotice, useI18n } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { ContextText } from "./ContextText";

export function StepContext({ context: handle }: { context: ContextHandle }) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const [context, setContext] = useState<InspectedContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<ReadTask | null>(null);
  const clear = useCallback(() => {
    request.current?.cancel();
    request.current = null;
    setContext(null);
    setLoading(false);
    setError("");
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Both handle IDs define the lifetime of protected material.
  useEffect(() => {
    // Identity changes dispose all body state even when the caller doesn't remount this component.
    clear();
    const hidden = () => {
      if (document.visibilityState === "hidden") clear();
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      request.current?.cancel();
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clear, handle.runId, handle.stepId]);
  const inspect = () => {
    clear();
    setLoading(true);
    request.current = startRead((signal) => api.inspectRunContext(handle, signal), {
      success: setContext,
      failure: (reason) => setError(errorText(reason)),
      settled: () => {
        request.current = null;
        setLoading(false);
      },
    });
  };
  return (
    <div className="run-context">
      <div className="run-inspector-toolbar">
        <button type="button" disabled={loading} onClick={inspect}>
          {t(context ? "重新核对实际输入与输出" : "查看实际输入与输出")}
        </button>
        {(context || loading) && (
          <button type="button" onClick={clear}>
            {t("收起实际输入与输出")}
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
    <Tabs.Root className="run-context-content run-context-tabs" defaultValue="input">
      <Tabs.List className="inspector-tab-list" aria-label={t("模型输入输出与来源")}>
        <Tabs.Trigger className="inspector-tab" value="input">
          {t("模型输入")}
        </Tabs.Trigger>
        <Tabs.Trigger className="inspector-tab" value="output">
          {t("模型输出")}
        </Tabs.Trigger>
        <Tabs.Trigger className="inspector-tab" value="sources">
          {t("来源与版本")}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content className="inspector-tab-panel" value="input">
        <h4>{t("模型输入")}</h4>
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
                  <ContextText
                    // biome-ignore lint/suspicious/noArrayIndexKey: Ordered immutable input content.
                    key={`${index}:${part}`}
                    text={content.text}
                    label={t("消息 {0} · {1}", index + 1, message.role)}
                  />
                ) : (
                  <dl
                    // biome-ignore lint/suspicious/noArrayIndexKey: Repeated immutable image frames share their source.
                    key={`${content.sourceId}:${content.sha256}:${part}`}
                    className="run-metadata"
                  >
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
      </Tabs.Content>
      <Tabs.Content className="inspector-tab-panel" value="output">
        <h4>{t("模型输出")}</h4>
        <ModelResult context={context} />
      </Tabs.Content>
      <Tabs.Content className="inspector-tab-panel" value="sources">
        <h4>{t("来源与版本")}</h4>
        {context.sourceVersions.length ? (
          <ul className="run-context-sources">
            {context.sourceVersions.map((source) => (
              <li key={`${source.id}:${source.revision}`}>
                <code>{source.id}</code> · {source.revision}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t("此步骤未记录来源版本。")}</p>
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}

function ModelResult({ context }: { context: InspectedContext }) {
  const t = useI18n();
  const result = context.result;
  if (context.status === "revoked" || result?.status === "revoked")
    return <p className="hint">{t("来源已撤权或删除，模型输出不可查看。")}</p>;
  if (context.status === "expired" || result?.status === "expired")
    return <p className="hint">{t("来源保留期已结束，模型输出已清除。")}</p>;
  if (!result || result.status === "unavailable")
    return (
      <p className="hint">
        {t(
          result?.reason === "pending"
            ? "模型尚未完成，输出待记录。"
            : result?.reason === "no_response"
              ? "模型未返回可记录的输出。"
              : "此步骤没有保留模型输出。",
        )}
      </p>
    );
  return (
    <section className="run-model-result">
      <p className="hint">
        {t(
          result.status === "partial"
            ? "这是中断前保留的部分模型输出。"
            : "以下为此步骤实际返回的模型输出。",
        )}
        {result.format && (
          <>
            {" "}
            · <code>{result.format}</code>
          </>
        )}
      </p>
      <ContextText text={result.text ?? ""} label={t("模型输出正文")} />
    </section>
  );
}
