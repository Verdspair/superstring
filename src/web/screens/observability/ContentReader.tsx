import { findChunks } from "highlight-words-core";
import { ArrowDown, Copy, Search, WrapText } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
/** A local reader: the exact string never enters global state, URLs or browser storage. */
export function ContentReader({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation(),
    id = useId();
  const [query, setQuery] = useState(""),
    [position, setPosition] = useState(0),
    [wrap, setWrap] = useState(true),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  const mark = useRef<HTMLElement>(null);
  const matches = useMemo(
    () =>
      findChunks({
        autoEscape: true,
        caseSensitive: true,
        searchWords: query ? [query] : [],
        textToHighlight: text,
      }).map((chunk) => chunk.start),
    [text, query],
  );
  const start = matches[position % Math.max(matches.length, 1)] ?? -1;
  return (
    <section aria-label={label} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search
            className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={id}
            aria-label={t("observability.findInThisContent")}
            className="pl-8"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPosition(0);
            }}
            placeholder={t("observability.findInThisContent")}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!matches.length}
          onClick={() => {
            setPosition((value) => (value + 1) % matches.length);
            requestAnimationFrame(() =>
              mark.current?.scrollIntoView({
                block: "nearest",
              }),
            );
          }}
        >
          <ArrowDown />
          {t("observability.nextMatch_223fc")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText />
          {t("observability.wrapLines")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopyError(true);
            }
          }}
        >
          <Copy />
          {t(copied ? "observability.copied" : "observability.copyOriginal")}
        </Button>
        {query && (
          <span className="text-xs text-muted-foreground" role="status">
            {t("observability.valueMatches", {
              "0": matches.length,
            })}
          </span>
        )}
        {copyError && (
          <span role="status">{t("observability.couldNotCopySelectTheContentToCopyIt")}</span>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: A named region preserves exact preformatted text while enabling keyboard scrolling. */}
      <pre
        role="region"
        aria-label={`${label} · ${t("observability.contentReader")}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the scrollable source is required in Safari.
        tabIndex={0}
        className={`max-h-[65dvh] min-w-0 overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-ring ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
      >
        {start < 0 ? (
          text
        ) : (
          <>
            {text.slice(0, start)}
            <mark ref={mark} className="bg-primary/25 text-foreground">
              {text.slice(start, start + query.length)}
            </mark>
            {text.slice(start + query.length)}
          </>
        )}
      </pre>
    </section>
  );
}
