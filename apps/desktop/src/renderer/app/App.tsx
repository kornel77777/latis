import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { CanvasView } from "../canvas/CanvasView";
import { FocusView } from "../canvas/FocusView";
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
  const resolved = useResolvedTheme(theme);
  useAppearance(
    useWorkspace((s) => s.prefs?.appearance),
    resolved,
  );

  useEffect(() => {
    subscribeToMain();
    void useWorkspace.getState().load();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        // §8.8 command palette.
        e.preventDefault();
        useWorkspace.setState((s) => ({ paletteOpen: !s.paletteOpen }));
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useWorkspace.getState().toggleSidebar();
      } else if (mod && e.code === "Backquote") {
        e.preventDefault();
        useWorkspace.getState().toggleDock();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        // §9.7 dock browser.
        e.preventDefault();
        useWorkspace.setState({ dockOpen: true, dockTab: "Browser" });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        // §8.7 distraction-free.
        e.preventDefault();
        useWorkspace.setState((s) => ({ zen: !s.zen }));
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "r") {
        // §8.9: Review Inbox.
        e.preventDefault();
        const s = useWorkspace.getState();
        if (s.reviewPanel.open) s.closeReview();
        else s.openReview();
      } else if (e.ctrlKey && e.key.toLowerCase() === "j") {
        // §8.6: Ctrl+J next item, Ctrl+Shift+J previous (Ctrl on every OS, like the spec).
        e.preventDefault();
        useWorkspace.getState().jumpAttention(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        <ReviewPanel />
        <Onboarding />
        <PerfOverlay />
        <Announcer />
        <Palette />
      </div>
    </ReactFlowProvider>
  );
}
