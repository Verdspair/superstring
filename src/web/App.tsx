import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrandLogo } from "./design-system/BrandLogo";
import { DesignSystemProvider } from "./design-system/Providers";
import { settingsHaveDrafts } from "./features/qq/draft-state";
import { useLocale } from "./i18n";
import { useSuperstringStore } from "./store";
import { activeSpace } from "./workspace/navigation";
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
  const bootstrap = useSuperstringStore((s) => s.bootstrap);
  const unsaved = useSuperstringStore(settingsHaveDrafts);
  const space = useSuperstringStore(activeSpace);
  const isConversations = space === "conversations";
  const [visitedConversations, setVisitedConversations] = useState(isConversations);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (isConversations) {
      setVisitedConversations(true);
    }
  }, [isConversations]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  if (status === "loading" || status === "idle")
    return (
      <div className="h-svh">
        <Waiting bootstrap />
      </div>
    );

  const OtherScreen = !isConversations
    ? {
        assistants: AssistantWorkspace,
        capabilities: CapabilitiesWorkspace,
        schemes: SchemesWorkspace,
        library: LibraryWorkspace,
        connections: ConnectionWorkspace,
        models: ModelServices,
        preferences: Preferences,
      }[space]
    : null;

  return (
    <WorkspaceShell>
      {(visitedConversations || isConversations) && (
        <div hidden={!isConversations} className={isConversations ? "h-full" : "hidden"}>
          <Suspense fallback={<Waiting />}>
            <ConversationWorkspace active={isConversations} />
          </Suspense>
        </div>
      )}
      {OtherScreen && (
        <Suspense fallback={<Waiting />}>
          <OtherScreen />
        </Suspense>
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
