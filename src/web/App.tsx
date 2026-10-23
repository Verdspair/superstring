import { motion, useReducedMotion } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./components/ui/sheet";
import { BrandLogo } from "./design-system/BrandLogo";
import { DesignSystemProvider } from "./design-system/Providers";

import { getDesktopHost } from "./desktop-host";
import { useLocale } from "./i18n";
import { startConversationChanges } from "./services/conversation-changes";
import { startChunkPreload } from "./state/preload-orchestrator";
import { PRELOAD_REGISTRY, WORKSPACE_LOADERS } from "./state/preload-registry";
import type { Page, SettingsView } from "./state/types";
import { hasUnsavedDrafts } from "./state/unsaved-changes";
import { useSuperstringStore } from "./store";
import { activeSpace, type SpaceId } from "./workspace/navigation";
import type { SettingsRoute } from "./workspace/settings-routes";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

const ConversationWorkspace = lazy(WORKSPACE_LOADERS.conversations);
const AssistantWorkspace = lazy(WORKSPACE_LOADERS.assistants);
const LibraryWorkspace = lazy(WORKSPACE_LOADERS.library);
const ConnectionWorkspace = lazy(WORKSPACE_LOADERS.connections);
const CapabilitiesWorkspace = lazy(WORKSPACE_LOADERS.capabilities);
const SchemesWorkspace = lazy(WORKSPACE_LOADERS.schemes);
const ModelServices = lazy(WORKSPACE_LOADERS.models);
const Preferences = lazy(WORKSPACE_LOADERS.preferences);

function Waiting({ bootstrap = false }: { bootstrap?: boolean }) {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const motionSkipped =
    shouldReduceMotion || (bootstrap && getDesktopHost()?.motionManaged === true);
  return (
    <div
      role="status"
      className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center select-none"
    >
      <motion.div
        initial={motionSkipped ? false : { scale: 0.88, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18, mass: 0.85 }}
        className="relative flex items-center justify-center"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-3 rounded-full bg-primary/10 blur-md dark:bg-primary/15"
        />
        <BrandLogo className="relative size-12 text-primary drop-shadow-[0_2px_8px_rgba(0,0,0,0.06)] dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]" />
      </motion.div>
      <strong className="text-xl tracking-tight">{t("brand.name")}</strong>
      <p className="text-sm text-muted-foreground">
        {t(bootstrap ? "workspace.loading_local_workspace" : "workspace.reading")}
      </p>
    </div>
  );
}
function WorkspaceReady({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const host = getDesktopHost();
    if (!host?.motionManaged) return;
    let frame = 0;
    let remaining = 2;
    const step = () => {
      remaining -= 1;
      if (remaining > 0) {
        frame = requestAnimationFrame(step);
        return;
      }
      void host.notifyWorkspaceReady().catch(() => console.warn("DESKTOP_WORKSPACE_READY_FAILED"));
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return null;
}

function Application() {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const [motionSettled, setMotionSettled] = useState(false);
  // Keep persisted language changes in sync across windows in every workspace.
  useLocale();
  const status = useSuperstringStore((s) => s.status);
  const directoryIds = useSuperstringStore((s) => s.directoryIds);
  const currentConversationId = useSuperstringStore((s) => s.currentConversationId);
  const sessionStateStorage = useSuperstringStore((s) => s.sessionStateStorage);
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const bootstrap = useSuperstringStore((s) => s.bootstrap);
  const unsaved = useSuperstringStore(hasUnsavedDrafts);
  const page = useSuperstringStore((s) => s.page);
  const settingsView = useSuperstringStore((s) => s.settingsView);
  const settingsRoute = useSuperstringStore((s) => s.settingsRoute);
  const space = useSuperstringStore(activeSpace);
  const [visitedSpaces, setVisitedSpaces] = useState<Set<SpaceId>>(() => new Set([space]));
  const lastNonPrefsRef = useRef<{
    page: Page;
    settingsView: SettingsView;
    settingsRoute: SettingsRoute;
  } | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const prevSpaceRef = useRef<SpaceId>(space);

  const isConversations = space === "conversations";
  const isAssistants = space === "assistants";
  const isCapabilities = space === "capabilities";
  const isSchemes = space === "schemes";
  const isLibrary = space === "library";
  const isConnections = space === "connections";
  const isModels = space === "models";
  const isPreferences = space === "preferences";

  useEffect(() => {
    if (space !== "preferences") {
      lastNonPrefsRef.current = { page, settingsView, settingsRoute };
    } else if (prevSpaceRef.current !== "preferences") {
      lastFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    prevSpaceRef.current = space;
  }, [space, page, settingsView, settingsRoute]);

  const closePreferences = () => {
    const prev = lastNonPrefsRef.current;
    const state = useSuperstringStore.getState();
    if (
      !prev ||
      (prev.page === "settings" && ["general", "appearance", "hub"].includes(prev.settingsView))
    ) {
      state.openChat();
      return;
    }
    if (prev.page === "chat") {
      state.requestPageNavigation("chat", prev.settingsView);
    } else if (prev.settingsView === "workspace") {
      state.openSettingsRoute(prev.settingsRoute);
    } else {
      state.requestPageNavigation("settings", prev.settingsView);
    }
  };

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the API disposes prewarm work owned by the previous client.
  useEffect(() => {
    if (status !== "ready") return;
    const current = activeSpace(useSuperstringStore.getState());
    const handle = startChunkPreload({
      currentSpace: current,
      items: PRELOAD_REGISTRY.map((entry) =>
        entry.space === "conversations" ? { ...entry, loadData: undefined } : entry,
      ),
    });
    return () => handle.cancel();
  }, [status, apiClient]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new API client must start its own bounded trace prewarm.
  useEffect(() => {
    if (status !== "ready" || !sessionStateStorage) return;
    const handle = startChunkPreload({
      currentSpace: "conversations",
      items: PRELOAD_REGISTRY.filter((entry) => entry.space === "conversations"),
    });
    return () => handle.cancel();
  }, [status, apiClient, sessionStateStorage]);

  useEffect(() => {
    if (status !== "ready") return;
    const cleanup = startConversationChanges(useSuperstringStore.getState().apiClient);
    return () => {
      cleanup();
    };
  }, [status]);

  useEffect(() => {
    setVisitedSpaces((prev) => {
      if (prev.has(space)) return prev;
      const next = new Set(prev);
      next.add(space);
      return next;
    });
  }, [space]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const hasCachedWorkspace = directoryIds.length > 0 && !!currentConversationId;
  if ((status === "loading" && !hasCachedWorkspace) || status === "idle")
    return (
      <div className="h-svh">
        <Waiting bootstrap />
      </div>
    );

  const motionSkipped = shouldReduceMotion || getDesktopHost()?.motionManaged === true;
  return (
    <motion.div
      data-slot="workspace-root-motion"
      initial={motionSkipped ? false : { scale: 0.82, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{
        type: "spring",
        stiffness: 260,
        damping: 18,
        mass: 0.85,
      }}
      onAnimationComplete={() => setMotionSettled(true)}
      style={motionSettled || shouldReduceMotion ? { transform: "none" } : undefined}
      className="h-svh min-h-0 w-full"
    >
      <WorkspaceShell>
        {(visitedSpaces.has("conversations") || isConversations) && (
          <div
            hidden={!isConversations}
            className={isConversations ? "h-full panel-enter" : "hidden"}
          >
            <Suspense fallback={<Waiting />}>
              <ConversationWorkspace active={isConversations} />
              <WorkspaceReady active={isConversations} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("assistants") || isAssistants) && (
          <div hidden={!isAssistants} className={isAssistants ? "h-full panel-enter" : "hidden"}>
            <Suspense fallback={<Waiting />}>
              <AssistantWorkspace active={isAssistants} />
              <WorkspaceReady active={isAssistants} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("capabilities") || isCapabilities) && (
          <div
            hidden={!isCapabilities}
            className={isCapabilities ? "h-full panel-enter" : "hidden"}
          >
            <Suspense fallback={<Waiting />}>
              <CapabilitiesWorkspace active={isCapabilities} />
              <WorkspaceReady active={isCapabilities} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("schemes") || isSchemes) && (
          <div hidden={!isSchemes} className={isSchemes ? "h-full panel-enter" : "hidden"}>
            <Suspense fallback={<Waiting />}>
              <SchemesWorkspace active={isSchemes} />
              <WorkspaceReady active={isSchemes} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("library") || isLibrary) && (
          <div hidden={!isLibrary} className={isLibrary ? "h-full panel-enter" : "hidden"}>
            <Suspense fallback={<Waiting />}>
              <LibraryWorkspace active={isLibrary} />
              <WorkspaceReady active={isLibrary} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("connections") || isConnections) && (
          <div hidden={!isConnections} className={isConnections ? "h-full panel-enter" : "hidden"}>
            <Suspense fallback={<Waiting />}>
              <ConnectionWorkspace active={isConnections} />
              <WorkspaceReady active={isConnections} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("models") || isModels) && (
          <div hidden={!isModels} className={isModels ? "h-full panel-enter" : "hidden"}>
            <Suspense fallback={<Waiting />}>
              <ModelServices active={isModels} />
              <WorkspaceReady active={isModels} />
            </Suspense>
          </div>
        )}
        {(visitedSpaces.has("preferences") || isPreferences) && (
          <Sheet
            open={isPreferences}
            onOpenChange={(next) => {
              if (!next) closePreferences();
            }}
          >
            <SheetContent
              side="right"
              showCloseButton
              className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-xl md:max-w-2xl"
              onCloseAutoFocus={(e) => {
                const target = [
                  lastFocusRef.current,
                  document.getElementById("workspace-navigation-trigger"),
                  document.getElementById("workspace-search-trigger"),
                ].find((el): el is HTMLElement => Boolean(el?.isConnected));
                if (target) {
                  e.preventDefault();
                  target.focus();
                }
              }}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{t("library.preferences")}</SheetTitle>
                <SheetDescription>
                  {t("library.language.color.and.desktop.behavior.changes.apply.immediately")}
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <Suspense fallback={<Waiting />}>
                  <Preferences active={isPreferences} />
                  <WorkspaceReady active={isPreferences} />
                </Suspense>
              </div>
            </SheetContent>
          </Sheet>
        )}
      </WorkspaceShell>
    </motion.div>
  );
}
export default function App() {
  return (
    <DesignSystemProvider>
      <Application />
    </DesignSystemProvider>
  );
}
