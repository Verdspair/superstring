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
  return (
    <div
      role="status"
      className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <BrandLogo className="size-12 text-primary" />
      <strong className="text-xl tracking-tight">{t("brand.name")}</strong>
      <p className="text-sm text-muted-foreground">
        {t(bootstrap ? "workspace.loading_local_workspace" : "workspace.reading")}
      </p>
    </div>
  );
}
function Application() {
  const { t } = useTranslation();
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

  return (
    <WorkspaceShell>
      {(visitedSpaces.has("conversations") || isConversations) && (
        <div hidden={!isConversations} className={isConversations ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <ConversationWorkspace active={isConversations} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("assistants") || isAssistants) && (
        <div hidden={!isAssistants} className={isAssistants ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <AssistantWorkspace active={isAssistants} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("capabilities") || isCapabilities) && (
        <div hidden={!isCapabilities} className={isCapabilities ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <CapabilitiesWorkspace active={isCapabilities} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("schemes") || isSchemes) && (
        <div hidden={!isSchemes} className={isSchemes ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <SchemesWorkspace active={isSchemes} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("library") || isLibrary) && (
        <div hidden={!isLibrary} className={isLibrary ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <LibraryWorkspace active={isLibrary} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("connections") || isConnections) && (
        <div hidden={!isConnections} className={isConnections ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <ConnectionWorkspace active={isConnections} />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("models") || isModels) && (
        <div hidden={!isModels} className={isModels ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <ModelServices active={isModels} />
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
              </Suspense>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </WorkspaceShell>
  );
}
export default function App() {
  return (
    <DesignSystemProvider>
      <Application />
    </DesignSystemProvider>
  );
}
