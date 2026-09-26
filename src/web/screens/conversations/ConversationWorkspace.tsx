import { PanelLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/ui/resizable";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";
import { selectedConversation } from "../../features/conversations/directory-state";
import { useIsMobile } from "../../hooks/use-mobile";
import { useSuperstringStore } from "../../store";
import { ConversationIndex } from "./ConversationIndex";
import { DirectConversation } from "./DirectConversation";
import { ExternalConversation } from "./ExternalConversation";
export function ConversationWorkspace() {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const conversation = useSuperstringStore(selectedConversation);
  const [directory, setDirectory] = useState(false);
  const selected = conversation?.id;
  useEffect(() => {
    if (selected) setDirectory(false);
  }, [selected]);
  const canvas = (trigger?: React.ReactNode) =>
    conversation?.channel === "onebot11" ? (
      <ExternalConversation key={conversation.id} conversation={conversation} directory={trigger} />
    ) : (
      <DirectConversation directory={trigger} />
    );
  if (mobile)
    return (
      <Sheet open={directory} onOpenChange={setDirectory}>
        <div className="h-full">
          {canvas(
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("workspace.open_conversation_index")}
              >
                <PanelLeft />
              </Button>
            </SheetTrigger>,
          )}
        </div>
        <SheetContent side="left" className="w-[min(22rem,100vw-2rem)] p-0" showCloseButton={false}>
          <SheetHeader className="sr-only">
            <SheetTitle>{t("workspace.conversation_index")}</SheetTitle>
            <SheetDescription>
              {t("workspace.search_select_or_create_a_conversation")}
            </SheetDescription>
          </SheetHeader>
          <ConversationIndex onSelected={() => setDirectory(false)} />
          <SheetClose asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("workspace.close_conversation_index")}
              className="absolute right-3 top-2"
            >
              <X />
            </Button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    );
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel id="conversation-index" defaultSize="310px" minSize="250px" maxSize="420px">
        <ConversationIndex />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="conversation-canvas" minSize="380px">
        {canvas()}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
