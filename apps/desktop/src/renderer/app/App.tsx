import { useEffect } from "react";
import { builtInCommands } from "../commands/list";
import { setCommands, useCommandKeys } from "../commands/registry";
import { ReactFlowProvider } from "@xyflow/react";
import { CanvasView } from "../canvas/CanvasView";
import { FocusView } from "../canvas/FocusView";
import { LatticeView } from "../lattice/LatticeView";
import { subscribeToMain, useWorkspace } from "../stores/workspace";
import { Dock } from "./Dock";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { IsolateDialog, MergeDialog, TimelineDialog } from "../changes/ChangeDialogs";
import { ReviewPanel } from "../changes/ReviewPanel";
import { Announcer } from "./Announcer";
import { Onboarding } from "./Onboarding";
import { PerfOverlay } from "./PerfOverlay";
import { Palette } from "../palette/Palette";
import { HandoffDialog } from "../chat/Later";
import { CardLibrary } from "../canvas/CardLibrary";
import { FlowDialogs, FlowTemplates } from "../canvas/flows";
import { SettingsDialog } from "./Settings";
import { Toasts } from "./Toasts";
import { useAppearance } from "./useAppearance";
import { useResolvedTheme } from "./useResolvedTheme";

export function App() {
  const ready = useWorkspace((s) => s.ready);
  const loadError = useWorkspace((s) => s.loadError);
  const theme = useWorkspace((s) => s.theme);
  const sidebarOpen = useWorkspace((s) => s.sidebarOpen);
  const dockOpen = useWorkspace((s) => s.dockOpen);
  const zen = useWorkspace((s) => s.zen);
  const view = useWorkspace((s) => s.views.find((v) => v.id === s.activeView));
  const lattice = useWorkspace((s) => s.prefs?.layoutMode === "lattice");
  const resolved = useResolvedTheme(theme);
  useAppearance(
    useWorkspace((s) => s.prefs?.appearance),
    resolved,
  );

  useEffect(() => {
    subscribeToMain();
    void useWorkspace.getState().load();
  }, []);

  useEffect(() => setCommands(builtInCommands()), []);
  // Every shortcut goes through the command registry (Settings → Commands).
  useCommandKeys();

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {sidebarOpen && !zen && <Sidebar />}
          {loadError ? (
            <div className="m-auto max-w-md text-center text-[13px] text-text-2">Latis couldn't load your workspace: {loadError}</div>
          ) : ready && view ? (
            <FocusView view={view} />
          ) : ready && lattice ? (
            <LatticeView />
          ) : ready ? (
            <CanvasView />
          ) : (
            <div className="flex-1 bg-bg-1" aria-busy="true" />
          )}
          {dockOpen && <Dock />}
        </div>
        {!zen && <StatusBar />}
        <Toasts />
        <SettingsDialog />
        <IsolateDialog />
        <MergeDialog />
        <TimelineDialog />
        <HandoffDialog />
        <CardLibrary />
        <FlowDialogs />
        <FlowTemplates />
        <ReviewPanel />
        <Onboarding />
        <PerfOverlay />
        <Announcer />
        <Palette />
      </div>
    </ReactFlowProvider>
  );
}
