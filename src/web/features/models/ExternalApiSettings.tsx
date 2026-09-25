// 快捷管理 → 外部模型API（0032，用户 2026-09-25）。
//
// What this page is for: registering an OpenAI-compatible external service (base URL + key) and the
// models it serves, each with the context window the user types. Declared names then appear in every
// "pick a model" list in the app, and the local model service keeps working for every name nobody
// declared.
//
// Two rules the UI must not soften:
//   * the key is write-only — the page can say whether one is stored, and can replace or clear it,
//     but it never receives the value;
//   * the context window is required per model, because external services do not report one and an
//     unknown window makes the QQ chain refuse to call (its capacity preflight fails closed).

import { useEffect, useState } from "react";
import type { ModelProviderResponse } from "../../../shared/contracts/models";
import { MODEL_PROVIDER_MODEL_LIMIT } from "../../../shared/contracts/models";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";

interface ProviderDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string; name: string; window: string }>;
}

function draftOf(provider: ModelProviderResponse): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.base_url,
    apiKey: "",
    models: provider.models.map((model) => ({
      id: `stored-${model.name}`,
      name: model.name,
      window: String(model.context_window),
    })),
  };
}

/** The models a save would send, or the reason it cannot: a name and a positive window, both filled. */
function parseModels(
  draft: ProviderDraft,
): { ok: true; models: Array<{ name: string; context_window: number }> } | { ok: false } {
  const models: Array<{ name: string; context_window: number }> = [];
  for (const entry of draft.models) {
    const name = entry.name.trim();
    const window = Number(entry.window);
    if (name === "" || !Number.isInteger(window) || window < 256) return { ok: false };
    models.push({ name, context_window: window });
  }
  return { ok: true, models };
}

export function ExternalApiSettings() {
  const t = useI18n();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const refreshModels = useSuperstringStore((s) => s.refreshModels);
  const loading = useSuperstringStore((s) => s.editorLoading);
  const [providers, setProviders] = useState<ModelProviderResponse[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [creating, setCreating] = useState<ProviderDraft | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 打开页面即检测（用户 2026-09-25 要求）：拉清单的同时对每个已登记服务打一次它自己的
  // `/models`，结果直接写在卡片上——可用性不该靠人想起来去点按钮才知道。
  const testOne = async (id: string) => {
    setTestResults((current) => ({ ...current, [id]: t("正在检测…") }));
    try {
      const result = await apiClient.testModelProvider(id);
      setTestResults((current) => ({
        ...current,
        [id]: result.ok
          ? t("可连接：{0} 个模型", result.models.length)
          : t("连不上：{0}", result.error ?? ""),
      }));
    } catch (caught) {
      setTestResults((current) => ({
        ...current,
        [id]: caught instanceof Error ? caught.message : String(caught),
      }));
    }
  };
  const load = async () => {
    try {
      const rows = await apiClient.listModelProviders();
      setProviders(rows);
      setError("");
      for (const provider of rows) void testOne(provider.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  // Load once; `load` closes over the client, which the store swaps only for tests.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 首次进入读一次，不随 apiClient 身份重跑
  useEffect(() => {
    void load();
  }, []);

  const draftFor = (provider: ModelProviderResponse): ProviderDraft =>
    drafts[provider.id] ?? draftOf(provider);
  const patchDraft = (id: string, patch: Partial<ProviderDraft>) =>
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? draftOf(providers?.find((p) => p.id === id) as ModelProviderResponse)),
        ...patch,
      },
    }));

  const run = async (id: string, action: () => Promise<void>, done: string) => {
    setSaving(true);
    setNotes((current) => ({ ...current, [id]: "" }));
    try {
      await action();
      await load();
      // The pickers read the merged list, so a declared name must show up there immediately.
      await refreshModels();
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setNotes((current) => ({ ...current, [id]: t(done) }));
    } catch (caught) {
      setNotes((current) => ({
        ...current,
        [id]: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      setSaving(false);
    }
  };

  const card = (provider: ModelProviderResponse) => {
    const draft = draftFor(provider);
    const parsed = parseModels(draft);
    const changed =
      draft.name !== provider.name ||
      draft.baseUrl !== provider.base_url ||
      draft.apiKey !== "" ||
      JSON.stringify(parsed.ok ? parsed.models : null) !==
        JSON.stringify(
          provider.models.map((m) => ({ name: m.name, context_window: m.context_window })),
        );
    return (
      <li key={provider.id}>
        <div className="qq-access-row">
          <strong>{provider.name}</strong>
          <small className="hint">{provider.base_url}</small>
          <span className="hint">
            {provider.has_api_key ? t("已保存密钥") : t("尚未保存密钥")} ·{" "}
            {t("{0} 个模型", provider.models.length)}
            {testResults[provider.id] ? ` · ${testResults[provider.id]}` : ""}
          </span>
        </div>
        <div className="qq-access-controls">
          <label>
            <span>{t("名称")}</span>
            <input
              aria-label={t("供应商名称")}
              disabled={saving}
              value={draft.name}
              onChange={(event) => patchDraft(provider.id, { name: event.target.value })}
            />
          </label>
          <label>
            <span>{t("地址")}</span>
            <input
              aria-label={t("供应商地址")}
              disabled={saving}
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => patchDraft(provider.id, { baseUrl: event.target.value })}
            />
          </label>
          <label>
            <span>{t("密钥")}</span>
            <input
              aria-label={t("供应商密钥")}
              type="password"
              disabled={saving}
              value={draft.apiKey}
              placeholder={provider.has_api_key ? t("已保存（留空则不修改）") : t("尚未保存")}
              onChange={(event) => patchDraft(provider.id, { apiKey: event.target.value })}
            />
          </label>
        </div>
        <div className="qq-access-controls">
          <span className="hint">{t("模型与上下文窗口")}</span>
          {draft.models.map((entry, index) => (
            <span key={entry.id} className="model-provider-model-row">
              <input
                aria-label={t("模型名")}
                disabled={saving}
                value={entry.name}
                placeholder={t("模型名")}
                onChange={(event) =>
                  patchDraft(provider.id, {
                    models: draft.models.map((row, i) =>
                      i === index ? { ...row, name: event.target.value } : row,
                    ),
                  })
                }
              />
              <input
                aria-label={t("上下文窗口")}
                disabled={saving}
                inputMode="numeric"
                value={entry.window}
                placeholder="65536"
                onChange={(event) =>
                  patchDraft(provider.id, {
                    models: draft.models.map((row, i) =>
                      i === index ? { ...row, window: event.target.value } : row,
                    ),
                  })
                }
              />
            </span>
          ))}
          <button
            type="button"
            disabled={saving || draft.models.length >= MODEL_PROVIDER_MODEL_LIMIT}
            onClick={() =>
              patchDraft(provider.id, {
                models: [
                  ...draft.models,
                  { id: `new-${Date.now()}-${draft.models.length}`, name: "", window: "" },
                ],
              })
            }
          >
            {t("添加模型")}
          </button>
        </div>
        <div className="qq-access-controls">
          <button
            type="button"
            disabled={saving || !changed || !parsed.ok || draft.name.trim() === ""}
            onClick={() =>
              void run(
                provider.id,
                async () => {
                  await apiClient.updateModelProvider(provider.id, {
                    name: draft.name.trim(),
                    base_url: draft.baseUrl.trim(),
                    ...(draft.apiKey === "" ? {} : { api_key: draft.apiKey }),
                    ...(parsed.ok ? { models: parsed.models } : {}),
                    expected_revision: provider.revision,
                  });
                },
                "已保存",
              )
            }
          >
            {t("保存")}
          </button>
          {provider.has_api_key && (
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void run(
                  provider.id,
                  async () => {
                    await apiClient.updateModelProvider(provider.id, {
                      api_key: null,
                      expected_revision: provider.revision,
                    });
                  },
                  "已清除密钥",
                )
              }
            >
              {t("清除密钥")}
            </button>
          )}
          <button type="button" disabled={saving} onClick={() => void testOne(provider.id)}>
            {t("重新检测")}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              void run(provider.id, () => apiClient.deleteModelProvider(provider.id), "已删除")
            }
          >
            {t("删除")}
          </button>
          {notes[provider.id] && <span className="hint">{notes[provider.id]}</span>}
        </div>
      </li>
    );
  };

  return (
    <>
      <p className="settings-note">
        {t(
          "在这里登记 OpenAI 兼容的外部模型服务；登记的模型会出现在所有「选择模型」的下拉里。每个模型必须手填上下文窗口——外部服务不报这个数，没填就不会被 QQ 链路调用。",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <SettingsGroup
        id="external-api-providers"
        title="已登记的服务"
        note="密钥只写不读：这里只会显示是否已保存；保存与删除都按修订号比较交换。"
      >
        {providers === null ? (
          <p className="hint" role="status">
            {t("正在读取…")}
          </p>
        ) : providers.length === 0 ? (
          <p className="hint">{t("还没有登记任何外部服务。")}</p>
        ) : (
          <ul className="qq-access-list">{providers.map((provider) => card(provider))}</ul>
        )}
      </SettingsGroup>

      <SettingsGroup
        id="external-api-new"
        title="新建"
        note="填名称、地址，按需要填密钥；保存后模型清单会出现在上面的卡片里。"
      >
        <div className="qq-access-controls">
          <label>
            <span>{t("名称")}</span>
            <input
              aria-label={t("新供应商名称")}
              disabled={saving || loading}
              value={creating?.name ?? ""}
              onChange={(event) =>
                setCreating({
                  name: event.target.value,
                  baseUrl: creating?.baseUrl ?? "",
                  apiKey: creating?.apiKey ?? "",
                  models: creating?.models ?? [],
                })
              }
            />
          </label>
          <label>
            <span>{t("地址")}</span>
            <input
              aria-label={t("新供应商地址")}
              disabled={saving || loading}
              placeholder="https://api.example.com/v1"
              value={creating?.baseUrl ?? ""}
              onChange={(event) =>
                setCreating({
                  name: creating?.name ?? "",
                  baseUrl: event.target.value,
                  apiKey: creating?.apiKey ?? "",
                  models: creating?.models ?? [],
                })
              }
            />
          </label>
          <label>
            <span>{t("密钥")}</span>
            <input
              aria-label={t("新供应商密钥")}
              type="password"
              disabled={saving || loading}
              value={creating?.apiKey ?? ""}
              onChange={(event) =>
                setCreating({
                  name: creating?.name ?? "",
                  baseUrl: creating?.baseUrl ?? "",
                  apiKey: event.target.value,
                  models: creating?.models ?? [],
                })
              }
            />
          </label>
          <button
            type="button"
            disabled={
              saving ||
              creating === null ||
              creating.name.trim() === "" ||
              !/^https?:\/\//.test(creating.baseUrl.trim())
            }
            onClick={() =>
              void run(
                "new",
                async () => {
                  if (creating === null) return;
                  await apiClient.createModelProvider({
                    name: creating.name.trim(),
                    base_url: creating.baseUrl.trim(),
                    ...(creating.apiKey === "" ? {} : { api_key: creating.apiKey }),
                    models: [],
                  });
                  setCreating(null);
                },
                "已登记",
              )
            }
          >
            {t("登记这个服务")}
          </button>
          {notes.new && <span className="hint">{notes.new}</span>}
        </div>
        <p className="hint">
          {t(
            "登记的模型默认不参与任何用途；到「默认模型」或助手里把某个用途的模型选成它的名字即可。",
          )}
        </p>
      </SettingsGroup>
    </>
  );
}
