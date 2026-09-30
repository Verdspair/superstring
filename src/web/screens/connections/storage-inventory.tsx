// QQ 数据与保留（ADR0018 §11.1）：只读摘要 + 保留设置 + 手动的分类清理工作区。
//
// 判定都在服务端：`expired` 用服务端时钟、`protected` 是服务端的保全规则，界面只负责展示与
// 选择。清理先预览后确认，确认执行的是预览时冻结的请求快照；取消不产生任何写入。

import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  QqConversationKind,
  QqStorageCategory,
  QqStorageStatusFilter,
} from "../../../shared/contracts/qq-storage";
import { AlertDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { AlertDialogFooter } from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import {
  qqStorageDaysChanged,
  qqStorageDaysValid,
  qqStorageItemCleanable,
} from "../../features/qq/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { useSuperstringStore } from "../../store";

const CATEGORIES: readonly QqStorageCategory[] = [
  "observation_text",
  "media_notes",
  "speech",
  "sends",
  "nicknames",
];
const STATUS_FILTERS: readonly QqStorageStatusFilter[] = ["all", "live", "expired"];
const statusLabels: Record<QqStorageStatusFilter, string> = {
  all: "connections.all",
  live: "connections.storage.manage.statusLive",
  expired: "connections.storage.nicknames.expired",
};

/** 保留设置卡片：数字以原文存在 store 草稿里，保存只发一条 storage PUT。 */
function StorageRetentionCard() {
  const { t } = useTranslation();
  const settings = useSuperstringStore((s) => s.qqStorageSettings);
  const saving = useSuperstringStore((s) => s.qqStorageSaving);
  const save = useSuperstringStore((s) => s.saveQqStorageSettings);
  const [draft, setDraft] = useQqInput("storage");
  if (!settings) return null;
  const value = draft ?? { source: settings, days: String(settings.retention_days) };
  const dirty = qqStorageDaysChanged(value.days, value.source.retention_days);
  const invalid = draft !== null && !qqStorageDaysValid(value.days);
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h3 className="font-medium">{t("connections.storage.manage.retentionTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("connections.storage.manage.retentionNote")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("connections.storage.manage.manualNote")}
        </p>
      </div>
      <Field
        label="connections.storage.manage.retentionDays"
        info="connections.storage.manage.retentionDaysInfo"
      >
        <Input
          className="w-32"
          inputMode="numeric"
          value={value.days}
          disabled={saving}
          aria-invalid={invalid || undefined}
          onChange={(event) => setDraft({ source: value.source, days: event.target.value })}
        />
      </Field>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          {t("connections.storage.manage.retentionInvalid")}
        </p>
      )}
      <Button
        disabled={saving || !dirty}
        onClick={() =>
          void save().then((ok) => {
            if (ok) setDraft(null);
          })
        }
      >
        {t("connections.storage.manage.saveRetention")}
      </Button>
    </section>
  );
}

export function StorageInventory() {
  const { t, i18n } = useTranslation();
  const {
    qqStorageUsage: data,
    qqStorageLoading: loading,
    qqStorageSaving: saving,
    qqStorageItems: items,
    qqStorageItemsTotal: total,
    qqStorageItemsNextCursor: nextCursor,
    qqStorageItemsLoading: itemsLoading,
    qqStorageItemsError: itemsError,
    qqStorageCleanupRequest: cleanupRequest,
    qqStorageCleanupPreview: preview,
    qqStorageCleanupResult: result,
    qqStorageCleanupError: cleanupError,
    loadQqStorage: load,
    refreshQqStorage: refresh,
    loadQqStorageItems: loadItems,
    previewQqStorageCleanup: beginPreview,
    runQqStorageCleanupSelection: runCleanup,
    clearQqStorageCleanup: clearCleanup,
  } = useSuperstringStore();
  // 管理列表的筛选与翻页是页面局部状态；条目本身永远来自服务端游标读取。
  const [category, setCategory] = useState<QqStorageCategory>("observation_text");
  const [status, setStatus] = useState<QqStorageStatusFilter>("all");
  const [kind, setKind] = useState<QqConversationKind | "">("");
  const [peerInput, setPeerInput] = useState("");
  const [peer, setPeer] = useState("");
  const [trail, setTrail] = useState<(string | null)[]>([null]);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    // 隐式读取只填摘要与设置，不推进保留草稿基线。
    void load();
  }, [load]);
  const cursor = trail[position] ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 只作关闭结果对话框后的强制重读触发条件，effect 体无需读取。
  useEffect(() => {
    const controller = new AbortController();
    void loadItems(
      { category, status, kind: kind === "" ? null : kind, peerId: peer, cursor },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [category, status, kind, peer, cursor, reloadTick, loadItems]);
  // 卸载：作废在途清理操作并让 busy 归零，迟到响应不得再落地。
  useEffect(() => () => clearCleanup(), [clearCleanup]);
  const formatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "short",
    timeStyle: "medium",
  });
  const date = (seconds: number | null) =>
    seconds === null ? "—" : formatter.format(new Date(seconds * 1000));
  const instant = (value: string) => formatter.format(new Date(value));
  const number = new Intl.NumberFormat(i18n.language);
  const groups = data
    ? [
        { key: "observations", values: data.observations },
        { key: "speech", values: data.speech },
        { key: "sends", values: data.sends },
        { key: "nicknames", values: data.nicknames },
        { key: "stickers", values: data.stickers },
        { key: "media", values: data.media },
      ]
    : [];
  const resetPaging = () => {
    setTrail([null]);
    setPosition(0);
    setSelected([]);
  };
  const switchCategory = (next: QqStorageCategory) => {
    if (next === category) return;
    resetPaging();
    setCategory(next);
  };
  const switchStatus = (next: QqStorageStatusFilter) => {
    if (next === status) return;
    resetPaging();
    setStatus(next);
  };
  const switchKind = (next: QqConversationKind | "") => {
    if (next === kind) return;
    resetPaging();
    setKind(next);
  };
  const applyPeer = () => {
    resetPaging();
    setPeer(peerInput.trim());
  };
  const goNext = () => {
    if (!nextCursor) return;
    setTrail((previous) => {
      const next = [...previous];
      next[position + 1] = nextCursor;
      return next;
    });
    setPosition(position + 1);
    setSelected([]);
  };
  const goPrev = () => {
    if (position === 0) return;
    setPosition(position - 1);
    setSelected([]);
  };
  const toggleSelected = (id: string, checked: boolean) =>
    setSelected((previous) =>
      checked
        ? previous.includes(id)
          ? previous
          : [...previous, id]
        : previous.filter((value) => value !== id),
    );
  const openCategoryPreview = () => {
    setCleanupOpen(true);
    void beginPreview({ category });
  };
  const openSelectionPreview = () => {
    if (!selected.length) return;
    setCleanupOpen(true);
    void beginPreview({ category, ids: [...selected] });
  };
  const closeCleanup = () => {
    // 执行成功后的关闭顺带重读第一页：被移除的行不该继续留在列表里。
    const cleaned = result !== null;
    setCleanupOpen(false);
    clearCleanup();
    if (cleaned) {
      resetPaging();
      setReloadTick((value) => value + 1);
    }
  };
  const retryCleanup = () => {
    if (!cleanupRequest) return;
    // 预览成功但执行失败：原样重试执行；预览本身失败：重新预览同一份快照。
    void (preview ? runCleanup() : beginPreview(cleanupRequest));
  };
  return (
    <div className="space-y-8 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.storage.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? t("connections.storage.retention", { "0": data.retention.days })
              : t("connections.common.loading")}
          </p>
        </div>
        <Button variant="outline" disabled={loading || saving} onClick={() => void refresh()}>
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      <StorageRetentionCard />
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="font-semibold">{t("connections.storage.manage.cleanupTitle")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("connections.storage.manage.metaNote")}
          </p>
        </div>
        <Tabs
          value={category}
          onValueChange={(next) => switchCategory(next as QqStorageCategory)}
          className="min-w-0 max-w-full"
        >
          <TabsList
            aria-label={t("connections.storage.manage.categoryLabel")}
            className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal"
          >
            {CATEGORIES.map((value) => (
              <TabsTrigger key={value} value={value} disabled={saving}>
                {t(`connections.storage.removed.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="connections.storage.manage.statusLabel">
            <NativeSelect
              className="w-32"
              value={status}
              disabled={saving}
              onChange={(event) => switchStatus(event.target.value as QqStorageStatusFilter)}
            >
              {STATUS_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {t(statusLabels[value])}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="connections.storage.manage.kindLabel">
            <NativeSelect
              className="w-32"
              value={kind}
              disabled={saving}
              onChange={(event) => switchKind(event.target.value as QqConversationKind | "")}
            >
              <option value="">{t("connections.storage.manage.kindAny")}</option>
              <option value="group">{t("connections.kind.group")}</option>
              <option value="private">{t("connections.kind.private")}</option>
            </NativeSelect>
          </Field>
          <Field label="connections.storage.manage.peerFilter">
            <Input
              className="w-48"
              value={peerInput}
              disabled={saving}
              onChange={(event) => setPeerInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyPeer();
                }
              }}
            />
          </Field>
          <Button variant="outline" disabled={saving} onClick={applyPeer}>
            {t("connections.storage.manage.apply")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={saving || selected.length === 0}
            onClick={openSelectionPreview}
          >
            <Trash2 />
            {t("connections.storage.manage.cleanSelected")}
          </Button>
          <Button variant="outline" disabled={saving} onClick={openCategoryPreview}>
            <Trash2 />
            {t("connections.storage.manage.cleanCategory")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("connections.storage.manage.selectedCount", { "0": selected.length })}
          </span>
        </div>
        {itemsError && (
          <div
            className="flex flex-wrap items-center gap-2 text-sm text-destructive"
            aria-live="polite"
          >
            <span>{t("connections.storage.manage.itemsError", { "0": itemsError })}</span>
            <Button
              variant="outline"
              disabled={itemsLoading}
              onClick={() => setReloadTick((value) => value + 1)}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        )}
        {itemsLoading && !items.length && (
          <p className="text-sm text-muted-foreground">{t("connections.common.loading")}</p>
        )}
        {!itemsLoading && !itemsError && items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("connections.storage.manage.empty")}</p>
        )}
        {items.length > 0 && (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">{t("connections.storage.manage.select")}</span>
                    </TableHead>
                    <TableHead>{t("connections.storage.sweep.peer")}</TableHead>
                    <TableHead>{t("connections.storage.manage.columnAgent")}</TableHead>
                    <TableHead>{t("connections.storage.manage.columnStatus")}</TableHead>
                    <TableHead>{t("connections.storage.manage.createdAt")}</TableHead>
                    <TableHead>{t("connections.storage.manage.expiresAt")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={`${item.category}:${item.id}`}>
                      <TableCell>
                        {item.expired ? (
                          <Checkbox
                            checked={selected.includes(item.id)}
                            disabled={!qqStorageItemCleanable(item) || saving}
                            aria-label={t("connections.storage.manage.selectRow", {
                              "0": item.id,
                            })}
                            onCheckedChange={(next) => toggleSelected(item.id, next === true)}
                          />
                        ) : (
                          <span aria-hidden="true" className="text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t(`connections.kind.${item.kind}`)} {item.peer_id}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.agent_id ?? "—"}</TableCell>
                      <TableCell>
                        {item.expired ? (
                          <Badge variant="outline">
                            {t("connections.storage.nicknames.expired")}
                          </Badge>
                        ) : (
                          t("connections.storage.manage.statusLive")
                        )}
                        {item.protected && (
                          <Badge
                            variant="secondary"
                            title={t("connections.storage.manage.protectedHint")}
                          >
                            {t("connections.storage.manage.protected")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{instant(item.created_at)}</TableCell>
                      <TableCell className="text-xs">{instant(item.expires_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("connections.storage.manage.total", { "0": total })}</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  disabled={position === 0 || itemsLoading || saving}
                  onClick={goPrev}
                >
                  {t("connections.storage.manage.previousPage")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!nextCursor || itemsLoading || saving}
                  onClick={goNext}
                >
                  {t("connections.storage.manage.nextPage")}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {groups.map((group) => (
              <section key={group.key} className="space-y-3 rounded-lg border p-4">
                <h3 className="font-medium">{t(`connections.storage.${group.key}`)}</h3>
                <dl className="space-y-2">
                  {Object.entries(group.values).map(([key, value]) => (
                    <div className="flex justify-between gap-3 text-sm" key={key}>
                      <dt className="text-muted-foreground">
                        {t(`connections.storage.${group.key}.${key}`)}
                      </dt>
                      <dd className="font-mono tabular-nums">{number.format(value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <section className="space-y-3">
            <h3 className="font-semibold">{t("connections.storage.runtime")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {data.agent_runtime &&
                Object.entries(data.agent_runtime).map(([key, value]) => (
                  <div
                    className="flex items-center justify-between rounded-md bg-muted px-4 py-3 text-sm"
                    key={key}
                  >
                    <span>{t(`connections.storage.runtime.${key}`)}</span>
                    <Badge variant="outline">{number.format(value)}</Badge>
                  </div>
                ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("connections.storage.dispatch", {
                "0": data.dispatch.candidates,
                "1": data.dispatch.ready_now,
                "2": t(
                  data.dispatch.lease_held
                    ? "connections.storage.leased"
                    : "connections.storage.idle",
                ),
              })}
            </p>
          </section>
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{t("connections.storage.sweep")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("connections.storage.lastSweep", {
                    "0": date(data.sweep.last_swept_at_seconds),
                    "1": data.sweep.tracked,
                  })}
                </p>
              </div>
              {/* 深链只在运行观测里，这里保留一个入口而不复制追踪详情。 */}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  useSuperstringStore.getState().requestConversationView("activity", "global")
                }
              >
                {t("connections.storage.viewTraces")}
              </Button>
            </div>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {["peer", "decision", "observed", "ready", "checked"].map((key) => (
                      <TableHead key={key}>{t(`connections.storage.sweep.${key}`)}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.sweep.entries.map((entry) => (
                    <TableRow key={`${entry.kind}:${entry.peer_id}`}>
                      <TableCell>
                        {t(`connections.kind.${entry.kind}`)} {entry.peer_id}
                      </TableCell>
                      <TableCell>
                        {entry.outcome === "skipped"
                          ? t(`connections.sweep.${entry.reason}`)
                          : t("connections.sweep.queued")}
                      </TableCell>
                      <TableCell>{date(entry.observed_at_seconds)}</TableCell>
                      <TableCell>{date(entry.ready_at_seconds)}</TableCell>
                      <TableCell>{date(entry.decided_at_seconds)}</TableCell>
                    </TableRow>
                  ))}
                  {!data.sweep.entries.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                        {t("connections.storage.noSweep")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}
      {cleanupOpen && (
        <AlertDialog
          title={t(
            result ? "connections.storage.cleaned" : "connections.storage.manage.previewTitle",
          )}
          busy={saving}
          onCancel={closeCleanup}
        >
          <div className="space-y-2 text-sm">
            {saving && !preview && !result && !cleanupError && (
              <p className="text-muted-foreground">{t("connections.common.loading")}</p>
            )}
            {cleanupRequest && !result && (
              <p className="text-xs text-muted-foreground">
                {cleanupRequest.ids
                  ? t("connections.storage.manage.scopeSelected", {
                      "0": cleanupRequest.ids.length,
                    })
                  : t("connections.storage.manage.scopeCategory", {
                      "0": t(`connections.storage.removed.${cleanupRequest.category}`),
                    })}
              </p>
            )}
            {preview && !result && (
              <p>
                {t("connections.storage.manage.previewLine", {
                  "0": preview.removable,
                  "1": preview.matched,
                  "2": preview.expired,
                  "3": preview.protected,
                })}
              </p>
            )}
            {result && (
              <p>
                {t("connections.storage.manage.resultLine", {
                  "0": result.removed,
                  "1": result.matched,
                  "2": result.expired,
                  "3": result.protected,
                })}
              </p>
            )}
            {cleanupError && (
              <p role="alert" className="text-destructive">
                {cleanupError}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            {result ? (
              <Button type="button" variant="outline" data-dialog-cancel onClick={closeCleanup}>
                {t("connections.close")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-dialog-cancel
                  disabled={saving}
                  onClick={closeCleanup}
                >
                  {t("connections.cancel")}
                </Button>
                {cleanupError ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={saving || !cleanupRequest}
                    onClick={retryCleanup}
                  >
                    {t("capabilities.retry")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={saving || !preview}
                    onClick={() => void runCleanup()}
                  >
                    {t("connections.storage.manage.runCleanup")}
                  </Button>
                )}
              </>
            )}
          </AlertDialogFooter>
        </AlertDialog>
      )}
    </div>
  );
}
