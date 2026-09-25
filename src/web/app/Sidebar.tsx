import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { ConversationList } from "../features/conversations/ConversationList";
import { translateNotice, useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Field } from "../ui/Field";
import { HeadingIcon, Icon, NewSessionButtonIcon, NewSessionDialogIcon } from "../ui/icons";
import { localTime } from "../ui/local-time";
import { PrimaryNavigation } from "./PrimaryNavigation";

export function Sidebar({ version }: { version: string }) {
  const t = useI18n();
  const agents = useSuperstringStore((state) => state.agents);
  const feedback = useSuperstringStore((state) => state.feedback);
  const error = useSuperstringStore((state) => state.error);
  const openSettings = useSuperstringStore((state) => state.openSettings);
  const createSession = useSuperstringStore((state) => state.createSession);
  const setNotice = useSuperstringStore((state) => state.setNotice);
  const [dialog, setDialog] = useState(false);
  const [custom, setCustom] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (custom) titleInput.current?.focus();
  }, [custom]);
  const activeAgents = agents.filter((agent) => agent.is_active);
  const noActiveAgent = activeAgents.length === 0;
  const openDialog = () => {
    setDialog(true);
    setCustom(false);
    setTitle("");
    setNotice({ feedback: "", error: null });
  };
  const closeDialog = () => {
    if (creating) return;
    setDialog(false);
    setCustom(false);
    setTitle("");
  };
  const create = async (name: string) => {
    setCreating(true);
    const created = await createSession(name);
    setCreating(false);
    if (!created) return;
    setDialog(false);
    setCustom(false);
    setTitle("");
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="brand">
          <HeadingIcon name="brand" />
          <strong>superstring</strong>
        </div>
        <div className="version">v{version}</div>
        <PrimaryNavigation />
        {noActiveAgent && (
          <p className="sidebar-empty">
            {t("当前没有启用的助手，无法新建对话；请到设置中启用或新建助手。")}
          </p>
        )}
        <Dialog.Root open={dialog} onOpenChange={(open) => (open ? openDialog() : closeDialog())}>
          <Dialog.Trigger asChild>
            <button className="primary new-session" type="button" disabled={creating}>
              <NewSessionButtonIcon />
              <span>{t("新建任务")}</span>
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="run-inspector-overlay" />
            <Dialog.Content className="new-dialog new-session-modal">
              <Dialog.Title className="new-dialog-title">
                <NewSessionDialogIcon />
                <span>{t("新建任务")}</span>
              </Dialog.Title>
              <Dialog.Description>{t("请选择任务名称方式")}</Dialog.Description>
              {!custom ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={creating}
                    onClick={() => void create(t("新会话 {0}", localTime()))}
                  >
                    {t("暂时使用默认名称")}
                  </button>
                  <button type="button" disabled={creating} onClick={() => setCustom(true)}>
                    {t("使用自定义名称")}
                  </button>
                </>
              ) : (
                <>
                  <Field label={t("任务名称")}>
                    <input
                      ref={titleInput}
                      aria-label={t("任务名称")}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.nativeEvent.isComposing &&
                          title.trim() &&
                          !creating
                        ) {
                          event.preventDefault();
                          void create(title);
                        }
                      }}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder={t("请输入任务名称")}
                      disabled={creating}
                    />
                  </Field>
                  <button
                    type="button"
                    className="primary"
                    disabled={creating || !title.trim()}
                    onClick={() => void create(title)}
                  >
                    {creating ? t("正在创建…") : t("确认创建")}
                  </button>
                </>
              )}
              <button type="button" disabled={creating} onClick={closeDialog}>
                {t("取消")}
              </button>
              {(feedback || error) && (
                <div className="dialog-status">{translateNotice(error ?? feedback)}</div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <ConversationList />
      </div>
      <button
        className="settings-button"
        type="button"
        aria-label={t("设置")}
        title={t("设置")}
        onClick={openSettings}
      >
        <Icon name="settings" />
        <span className="visually-hidden">{t("设置")}</span>
      </button>
    </aside>
  );
}
