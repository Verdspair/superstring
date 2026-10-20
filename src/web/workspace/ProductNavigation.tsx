import { cn } from "cn";
import { Search } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { version } from "../../../package.json";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useSuperstringStore } from "../store";
import { activeSpace, ENVIRONMENT, openSpace, SPACES } from "./navigation";

interface NavGroup {
  id: string;
  labelKey: string;
  spaceIds: readonly (typeof SPACES)[number]["id"][];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "daily",
    labelKey: "workspace.nav.daily",
    spaceIds: ["conversations", "assistants", "library"],
  },
  {
    id: "apps",
    labelKey: "workspace.nav.apps",
    spaceIds: ["schemes"],
  },
  {
    id: "system",
    labelKey: "workspace.nav.system",
    spaceIds: ["models", "capabilities", "connections"],
  },
] as const;

export function ProductNavigation({ onSearch }: { onSearch: () => void }) {
  const { t } = useTranslation();
  const active = useSuperstringStore(activeSpace);

  const spacesById = useMemo(() => {
    return new Map(SPACES.map((space) => [space.id, space]));
  }, []);

  return (
    <aside
      data-slot="product-navigation"
      className="flex h-full min-h-0 w-full shrink-0 flex-col items-stretch gap-[18px] overflow-y-auto border-r border-sidebar-border bg-sidebar px-[10px] py-[16px] text-sidebar-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label={t("workspace.main_navigation")}
    >
      <nav className="flex w-full flex-col gap-[18px]" aria-label={t("workspace.workspace")}>
        {NAV_GROUPS.map((group) => {
          const groupSpaces = group.spaceIds
            .map((id) => spacesById.get(id))
            .filter((space): space is (typeof SPACES)[number] => space !== undefined);

          return (
            <div key={group.id} className="flex w-full flex-col gap-[2px]">
              <div
                aria-hidden="true"
                className="px-[12px] pt-[4px] pb-[6px] text-[11px] font-semibold tracking-[0.06em] text-[var(--text-tertiary)] uppercase select-none"
              >
                {t(group.labelKey)}
              </div>
              {groupSpaces.map((space) => {
                const isCurrent = active === space.id;
                return (
                  <Tooltip key={space.id}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        onClick={() => openSpace(space.id)}
                        aria-current={isCurrent ? "page" : undefined}
                        className={cn(
                          "group relative flex h-auto min-h-[36px] w-full flex-row items-center justify-start gap-[10px] rounded-[6px] border border-transparent px-[12px] py-[6px] text-left min-w-0 whitespace-normal break-words text-[13.5px] font-medium leading-[1.5] whitespace-nowrap transition-colors",
                          "text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
                          "aria-[current=page]:rounded-l-none aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground aria-[current=page]:font-semibold",
                          "aria-[current=page]:hover:bg-sidebar-accent aria-[current=page]:hover:text-sidebar-accent-foreground",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
                        )}
                      >
                        {isCurrent && (
                          <motion.span
                            layoutId="product-space"
                            className="absolute inset-y-0 left-[-1px] w-[3px] rounded-none bg-sidebar-primary"
                          />
                        )}
                        <space.icon
                          aria-hidden="true"
                          className={cn(
                            "size-[17px] shrink-0",
                            isCurrent
                              ? "text-sidebar-accent-foreground"
                              : "text-muted-foreground group-hover:text-foreground",
                          )}
                        />
                        <span className="min-w-0 whitespace-normal break-words text-left leading-[1.5]">
                          {t(space.label)}
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{t(space.description)}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="mt-auto flex w-full shrink-0 flex-col items-stretch gap-[2px] border-t border-sidebar-border pt-[12px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              id="workspace-search-trigger"
              variant="ghost"
              size="icon"
              className="h-auto min-h-[36px] w-full justify-start gap-[10px] rounded-[6px] px-[12px] text-[13.5px] text-muted-foreground hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("workspace.search_and_jump")}
              onClick={onSearch}
            >
              <Search aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 whitespace-normal break-words text-[13.5px] font-medium">
                {t("workspace.search_and_jump")}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("workspace.search_with_shortcut")}</TooltipContent>
        </Tooltip>

        {ENVIRONMENT.map((space) => {
          const isCurrent = active === space.id;
          return (
            <Tooltip key={space.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "relative h-auto min-h-[36px] w-full justify-start gap-[10px] rounded-[6px] px-[12px] text-[13.5px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
                    "aria-[current=page]:hover:bg-sidebar-accent aria-[current=page]:hover:text-sidebar-accent-foreground",
                  )}
                  aria-label={t(space.label)}
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={() => openSpace(space.id)}
                >
                  {isCurrent && (
                    <motion.span
                      layoutId="product-space"
                      className="absolute inset-y-0 left-[-1px] w-[3px] rounded-none bg-sidebar-primary"
                    />
                  )}
                  <space.icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 whitespace-normal break-words text-[13.5px] font-medium">
                    {t(space.label)}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t(space.label)}</TooltipContent>
            </Tooltip>
          );
        })}

        <span className="pt-1.5 text-center font-mono text-[9px] text-muted-foreground/60 select-none">
          {version}
        </span>
      </div>
    </aside>
  );
}
