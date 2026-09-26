import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { version } from "../../../package.json";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { BrandLogo } from "../design-system/BrandLogo";
import { useSuperstringStore } from "../store";
import { activeSpace, ENVIRONMENT, openSpace, SPACES } from "./navigation";

export function ProductNavigation({ onSearch }: { onSearch: () => void }) {
  const { t } = useTranslation();
  const active = useSuperstringStore(activeSpace);
  return (
    <aside
      className="flex h-full min-h-0 w-20 shrink-0 flex-col items-center overflow-y-auto border-r bg-sidebar px-2 py-4 text-sidebar-foreground"
      aria-label={t("workspace.main_navigation")}
    >
      <button
        type="button"
        onClick={() => openSpace("conversations")}
        aria-label="Superstring"
        className="mb-5 rounded-xl p-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BrandLogo className="size-9" />
      </button>
      <nav className="w-full space-y-1.5" aria-label={t("workspace.workspace")}>
        {SPACES.map((space) => (
          <Button
            key={space.id}
            variant="ghost"
            onClick={() => openSpace(space.id)}
            aria-current={active === space.id ? "page" : undefined}
            className="relative h-16 w-full flex-col gap-1 text-[11px] font-medium aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-primary"
          >
            {active === space.id && (
              <motion.span
                layoutId="product-space"
                className="absolute inset-y-4 left-0 w-0.5 rounded-full bg-primary"
              />
            )}
            <space.icon className="size-5" />
            <span>{t(space.label)}</span>
          </Button>
        ))}
      </nav>
      <div className="mt-auto flex w-full flex-col gap-1 border-t pt-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mx-auto"
              aria-label={t("workspace.search_and_jump")}
              onClick={onSearch}
            >
              <Search />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("workspace.search_and_jump")} · ⌘K</TooltipContent>
        </Tooltip>
        {ENVIRONMENT.map((space) => (
          <Tooltip key={space.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mx-auto aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-primary"
                aria-label={t(space.label)}
                aria-current={active === space.id ? "page" : undefined}
                onClick={() => openSpace(space.id)}
              >
                <space.icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t(space.label)}</TooltipContent>
          </Tooltip>
        ))}
        <small className="pt-2 text-center font-mono text-[9px] text-muted-foreground">
          {version}
        </small>
      </div>
    </aside>
  );
}
