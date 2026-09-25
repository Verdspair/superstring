import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Sidebar } from "./Sidebar";

const compactQuery = "(max-width: 760px)";

/** The same directory is mounted once: inline on desktop, in a Radix dialog on narrow screens. */
export function ResponsiveSidebar({ version }: { version: string }) {
  const t = useI18n();
  const [compact, setCompact] = useState(() => window.matchMedia?.(compactQuery).matches ?? false);
  const [open, setOpen] = useState(false);
  const destination = useSuperstringStore(
    (state) =>
      `${state.page}:${state.settingsView}:${state.settingsRoute}:${state.currentConversationId}`,
  );
  useEffect(() => {
    const query = window.matchMedia?.(compactQuery);
    if (!query) return;
    const changed = () => setCompact(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    // Only a committed destination closes navigation; a cancelled draft confirmation keeps it open.
    if (destination) setOpen(false);
  }, [destination]);
  if (!compact) return <Sidebar version={version} />;
  return (
    <div className="mobile-navigation-bar">
      <strong>superstring</strong>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button type="button">{t("会话与导航")}</button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="run-inspector-overlay" />
          <Dialog.Content className="mobile-navigation-dialog">
            <Dialog.Title className="visually-hidden">{t("会话与导航")}</Dialog.Title>
            <Dialog.Description className="visually-hidden">
              {t("选择会话或打开功能设置。")}
            </Dialog.Description>
            <Sidebar version={version} />
            <Dialog.Close asChild>
              <button type="button" className="mobile-navigation-close">
                {t("关闭导航")}
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
