import { HelpCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

/**
 * Page-purpose help. Hover and focus reveal the description, a click pins it
 * open, and a second click, an outside press or Escape closes it again.
 */
export function WorkspaceHelp({ title, description }: { title: string; description: string }) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  const pinned = useRef(false);
  const helpButton = useRef<HTMLButtonElement>(null);
  return (
    <Tooltip
      disableHoverableContent
      open={helpOpen}
      onOpenChange={(open) => {
        if (!pinned.current) setHelpOpen(open);
      }}
    >
      <TooltipTrigger asChild>
        <button
          ref={helpButton}
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={t("hints.field.learnAbout", { "0": title })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            pinned.current = !pinned.current;
            setHelpOpen(pinned.current);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              pinned.current = false;
              setHelpOpen(false);
            }
          }}
        >
          <HelpCircle className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        onPointerDownOutside={(event) => {
          if (event.target instanceof Node && helpButton.current?.contains(event.target)) return;
          pinned.current = false;
          setHelpOpen(false);
        }}
        onEscapeKeyDown={() => {
          pinned.current = false;
          setHelpOpen(false);
        }}
      >
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
