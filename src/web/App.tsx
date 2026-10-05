import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrandLogo } from "./design-system/BrandLogo";
import { DesignSystemProvider } from "./design-system/Providers";
import { settingsHaveDrafts } from "./features/qq/draft-state";
import { useLocale } from "./i18n";
import { useSuperstringStore } from "./store";
import { activeSpace, type SpaceId } from "./workspace/navigation";
import { WorkspaceShell } from "./workspace/WorkspaceShell";

const ConversationWorkspace = lazy(() =>
  import("./screens/conversations/ConversationWorkspace").then((m) => ({
    default: m.ConversationWorkspace,
  })),
);
const AssistantWorkspace = lazy(() =>
  import("./screens/assistants/AssistantWorkspace").then((m) => ({
    default: m.AssistantWorkspace,
  })),
);
const LibraryWorkspace = lazy(() =>
  import("./screens/library/LibraryWorkspace").then((m) => ({ default: m.LibraryWorkspace })),
);
const ConnectionWorkspace = lazy(() =>
  import("./screens/connections/ConnectionWorkspace").then((m) => ({
    default: m.ConnectionWorkspace,
  })),
);
const CapabilitiesWorkspace = lazy(() =>
  import("./screens/connections/CapabilitiesWorkspace").then((m) => ({
    default: m.CapabilitiesWorkspace,
  })),
);
const SchemesWorkspace = lazy(() =>
  import("./screens/connections/SchemesWorkspace").then((m) => ({
    default: m.SchemesWorkspace,
  })),
);
const ModelServices = lazy(() =>
  import("./screens/environment/ModelServices").then((m) => ({ default: m.ModelServices })),
);
const Preferences = lazy(() =>
  import("./screens/environment/Preferences").then((m) => ({ default: m.Preferences })),
);

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
  // Keep persisted language changes in sync across windows in every workspace.
  useLocale();
  const status = useSuperstringStore((s) => s.status);
  const directoryIds = useSuperstringStore((s) => s.directoryIds);
  const currentConversationId = useSuperstringStore((s) => s.currentConversationId);
  const bootstrap = useSuperstringStore((s) => s.bootstrap);
  const unsaved = useSuperstringStore(settingsHaveDrafts);
  const space = useSuperstringStore(activeSpace);
  const [visitedSpaces, setVisitedSpaces] = useState<Set<SpaceId>>(() => new Set([space]));
  const isConversations = space === "conversations";
  const isAssistants = space === "assistants";
  const isCapabilities = space === "capabilities";
  const isSchemes = space === "schemes";
  const isLibrary = space === "library";
  const isConnections = space === "connections";
  const isModels = space === "models";
  const isPreferences = space === "preferences";

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

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
            <AssistantWorkspace />
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
            <ConnectionWorkspace />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("models") || isModels) && (
        <div hidden={!isModels} className={isModels ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <ModelServices />
          </Suspense>
        </div>
      )}
      {(visitedSpaces.has("preferences") || isPreferences) && (
        <div hidden={!isPreferences} className={isPreferences ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <Preferences />
          </Suspense>
        </div>
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
