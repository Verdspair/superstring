import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LocalModelEncoding,
  LocalModelEncodingsResponse,
} from "../../../shared/contracts/models";
import type { SuperstringApi } from "../../api";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/native-select";
import { startRead } from "../../services/read-task";
import { TokenizerEncodingHelp } from "./TokenizerEncodingHelp";

type Encoding = LocalModelEncoding["tokenizer_encoding"];
export function LocalModelEncodings({
  active,
  apiClient,
  loadedModels,
  externalModels,
}: {
  active: boolean;
  apiClient: SuperstringApi;
  loadedModels: readonly string[];
  externalModels: readonly string[];
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<LocalModelEncodingsResponse | null>(null);
  const [draft, setDraft] = useState<LocalModelEncoding[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const lifecycle = useRef(0);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mutation = useRef(false);
  const draftRef = useRef(draft);
  const snapshotRef = useRef(snapshot);
  draftRef.current = draft;
  snapshotRef.current = snapshot;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the explicit authoritative-read generation.
  useEffect(() => {
    if (!active) return;
    const owner = ++lifecycle.current;
    setLoading(true);
    const task = startRead((signal) => apiClient.getLocalModelEncodings(signal), {
      success: (next) => {
        if (lifecycle.current !== owner) return;
        const old = snapshotRef.current;
        const changed = new Map(
          draftRef.current.map((model) => [model.name, model.tokenizer_encoding]),
        );
        const names = new Set([
          ...(old?.models ?? []).map((model) => model.name),
          ...changed.keys(),
        ]);
        const modified = new Set(
          [...names].filter(
            (name) =>
              old?.models.find((model) => model.name === name)?.tokenizer_encoding !==
              changed.get(name),
          ),
        );
        const merged = new Map(next.models.map((model) => [model.name, model.tokenizer_encoding]));
        for (const name of modified) {
          const value = changed.get(name);
          if (value) merged.set(name, value);
          else merged.delete(name);
        }
        setSnapshot(next);
        setDraft([...merged].map(([name, tokenizer_encoding]) => ({ name, tokenizer_encoding })));
        setNotice("");
      },
      failure: (error) =>
        setNotice(error instanceof Error ? error.message : t("models.localEncodingLoadError")),
      settled: () => setLoading(false),
    });
    return () => {
      lifecycle.current++;
      task.cancel();
    };
  }, [active, apiClient, refresh, t]);
  const normalize = (models: readonly LocalModelEncoding[]) =>
    JSON.stringify([...models].sort((a, b) => a.name.localeCompare(b.name)));
  const dirty = snapshot !== null && normalize(draft) !== normalize(snapshot.models);
  const models = [
    ...new Set([
      ...loadedModels,
      ...(snapshot?.models ?? []).map((model) => model.name),
      ...draft.map((model) => model.name),
    ]),
  ]
    .filter(
      (name) =>
        !externalModels.includes(name) ||
        draft.some((model) => model.name === name) ||
        snapshot?.models.some((model) => model.name === name),
    )
    .sort((a, b) => a.localeCompare(b));
  async function save() {
    if (!active || !snapshot || mutation.current || !dirty) return;
    const owner = lifecycle.current;
    mutation.current = true;
    setSaving(true);
    setNotice("");
    try {
      const saved = await apiClient.saveLocalModelEncodings({
        expected_revision: snapshot.revision,
        models: draft,
      });
      if (lifecycle.current !== owner) return;
      setSnapshot(saved);
      setDraft(saved.models);
      setNotice(t("models.localEncodingSaved"));
    } catch (error) {
      if (lifecycle.current === owner)
        setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  }
  return (
    <section className="mt-5 space-y-3">
      <h3 className="text-sm font-medium">{t("models.localEncodingTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("models.localEncodingHint")}</p>
      <TokenizerEncodingHelp />
      {models.map((name) => (
        <label
          key={name}
          htmlFor={`local-model-encoding-${encodeURIComponent(name)}`}
          className="grid gap-2 text-sm sm:grid-cols-2"
        >
          <span className="break-all font-mono">{name}</span>
          <NativeSelect
            id={`local-model-encoding-${encodeURIComponent(name)}`}
            aria-label={`${t("models.tokenizerEncoding")} · ${name}`}
            disabled={loading || saving || !snapshot}
            value={draft.find((model) => model.name === name)?.tokenizer_encoding ?? ""}
            onChange={(event) => {
              const value = event.target.value as Encoding | "";
              setDraft((old) => [
                ...old.filter((model) => model.name !== name),
                ...(value ? [{ name, tokenizer_encoding: value }] : []),
              ]);
            }}
          >
            <option value="">{t("models.tokenizerUnspecified")}</option>
            <option value="cl100k_base" disabled={externalModels.includes(name)}>
              cl100k_base
            </option>
            <option value="o200k_base" disabled={externalModels.includes(name)}>
              o200k_base
            </option>
          </NativeSelect>
        </label>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button disabled={loading || saving || !dirty} onClick={() => void save()}>
          {t("models.localEncodingSave")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || saving}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("models.localEncodingRefresh")}
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
