import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { translateNotice, useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Field } from "../ui/Field";
import { NewSessionButtonIcon, NewSessionDialogIcon } from "../ui/icons";
import { localTime } from "../ui/local-time";

export function NewSessionDialog() {
  const t = useI18n();
  const agents = useSuperstringStore((state) => state.agents);
  const feedback = useSuperstringStore((state) => state.feedback);
  const error = useSuperstringStore((state) => state.error);
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
    <>
      {noActiveAgent && (
        <p className="sidebar-empty text-xs text-muted-foreground">
          {t("当前没有启用的助手，无法新建对话；请到设置中启用或新建助手。")}
        </p>
      )}
      <Dialog open={dialog} onOpenChange={(open) => (open ? openDialog() : closeDialog())}>
        <DialogTrigger asChild>
          <Button className="new-session w-full" type="button" disabled={creating}>
            <NewSessionButtonIcon />
            <span>{t("新建任务")}</span>
          </Button>
        </DialogTrigger>

        <DialogContent showCloseButton={!creating} className="new-dialog new-session-modal">
          <DialogTitle className="new-dialog-title flex items-center gap-2 [&>svg]:size-5">
            <NewSessionDialogIcon />
            <span>{t("新建任务")}</span>
          </DialogTitle>
          <DialogDescription>{t("请选择任务名称方式")}</DialogDescription>
          {!custom ? (
            <>
              <Button
                type="button"
                disabled={creating}
                onClick={() => void create(t("新会话 {0}", localTime()))}
              >
                {t("暂时使用默认名称")}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={creating}
                onClick={() => setCustom(true)}
              >
                {t("使用自定义名称")}
              </Button>
            </>
          ) : (
            <>
              <Field label={t("任务名称")}>
                <Input
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
              <Button
                type="button"
                disabled={creating || !title.trim()}
                onClick={() => void create(title)}
              >
                {creating ? t("正在创建…") : t("确认创建")}
              </Button>
            </>
          )}
          <Button variant="outline" type="button" disabled={creating} onClick={closeDialog}>
            {t("取消")}
          </Button>
          {(feedback || error) && (
            <div className="dialog-status text-sm text-muted-foreground">
              {translateNotice(error ?? feedback)}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
