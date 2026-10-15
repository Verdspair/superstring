import { useTranslation } from "react-i18next";

export function TokenizerEncodingHelp() {
  const { t } = useTranslation();

  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("models.tokenizerReferenceTitle")}
      </summary>
      <div className="mt-2 space-y-1.5">
        <p>{t("models.tokenizerReferenceIntro")}</p>
        <ul className="list-disc space-y-1 pl-4 font-mono text-[11px] text-foreground/90">
          <li>{t("models.tokenizerReferenceCl100k")}</li>
          <li>{t("models.tokenizerReferenceO200k")}</li>
          <li>{t("models.tokenizerReferenceUnsupported")}</li>
        </ul>
        <p>
          <a
            href="https://github.com/openai/tiktoken/blob/4e71bbe0c078468e00fefbf94b39849389f346e5/tiktoken/model.py"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t("models.tokenizerReferenceSource")}
          </a>
        </p>
      </div>
    </details>
  );
}
