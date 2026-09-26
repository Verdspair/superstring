import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";

/** A read-only text view. Search highlights one exact match without rendering thousands of marks. */
export function ContextText({ text, label }: { text: string; label: string }) {
  const t = useI18n();
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(-1);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const match = useRef<HTMLElement>(null);
  useEffect(() => {
    if (offset < 0) return;
    match.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [offset]);
  const search = (value: string, after = 0) => {
    setQuery(value);
    setOffset(value ? text.indexOf(value, after) : -1);
  };
  const next = () => {
    const following = text.indexOf(query, offset + Math.max(1, query.length));
    setOffset(following < 0 ? text.indexOf(query) : following);
  };
  return (
    <section className="context-text" aria-label={label}>
      <div className="context-text-toolbar">
        <label>
          <span>{t("搜索此正文")}</span>
          <input
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                search("");
              }
              if (event.key === "Enter" && query) {
                event.preventDefault();
                next();
              }
            }}
          />
        </label>
        <button type="button" disabled={!query || offset < 0} onClick={next}>
          {t("下一个匹配")}
        </button>
        <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>
          {t("自动换行")}
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
          }}
        >
          {t("复制正文")}
        </button>
        <small role="status">
          {query && offset < 0
            ? t("正文内无匹配")
            : copyState === "copied"
              ? t("已复制")
              : copyState === "failed"
                ? t("复制未成功，可手动选择正文。")
                : ""}
        </small>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: The named scroll region must preserve preformatted source text. */}
      <pre
        className="context-text-body"
        data-wrap={wrap}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Safari needs a focus target for keyboard scrolling of this read-only text.
        tabIndex={0}
        role="region"
        aria-label={`${label} · ${t("正文阅读区")}`}
      >
        {offset < 0 ? (
          text
        ) : (
          <>
            {text.slice(0, offset)}
            <mark ref={match}>{text.slice(offset, offset + query.length)}</mark>
            {text.slice(offset + query.length)}
          </>
        )}
      </pre>
    </section>
  );
}
