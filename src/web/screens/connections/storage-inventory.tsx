import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useSuperstringStore } from "../../store";

export function StorageInventory() {
  const { t, i18n } = useTranslation();
  const {
    qqStorageUsage: data,
    qqStorageLoading: loading,
    qqStorageSaving: saving,
    qqStorageRemoved: removed,
    loadQqStorage: load,
    runQqStorageCleanup: cleanup,
  } = useSuperstringStore();
  useEffect(() => {
    void load();
  }, [load]);
  const number = new Intl.NumberFormat(i18n.language);
  const date = (seconds: number | null) =>
    seconds === null
      ? "—"
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "medium" }).format(
          new Date(seconds * 1000),
        );
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
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.storage.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? t("connections.storage.retention", { "0": data.retention.days })
              : t("connections.common.loading")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={loading} onClick={() => void load()}>
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
          <Button variant="outline" disabled={saving || !data} onClick={() => void cleanup()}>
            <Trash2 />
            {t("connections.storage.clean")}
          </Button>
        </div>
      </div>
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
            <div>
              <h3 className="font-semibold">{t("connections.storage.sweep")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("connections.storage.lastSweep", {
                  "0": date(data.sweep.last_swept_at_seconds),
                  "1": data.sweep.tracked,
                })}
              </p>
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
      {removed && (
        <section className="rounded-lg bg-muted p-4" role="status">
          <h3 className="font-medium">{t("connections.storage.cleaned")}</h3>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {Object.entries(removed).map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-muted-foreground">
                  {t(`connections.storage.removed.${key}`)}
                </dt>
                <dd className="mt-1 font-mono">{number.format(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
