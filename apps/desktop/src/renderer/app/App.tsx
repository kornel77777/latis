import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { CanvasView } from "../canvas/CanvasView";
import { subscribeToMain, useWorkspace } from "../stores/workspace";
import { Dock } from "./Dock";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Onboarding } from "./Onboarding";
import { SettingsDialog } from "./Settings";
import { Toasts } from "./Toasts";
import { useResolvedTheme } from "./useResolvedTheme";

export function App() {
  const ready = useWorkspace((s) => s.ready);
  const loadError = useWorkspace((s) => s.loadError);
  const theme = useWorkspace((s) => s.theme);
  const sidebarOpen = useWorkspace((s) => s.sidebarOpen);
  const dockOpen = useWorkspace((s) => s.dockOpen);
  useResolvedTheme(theme);

  useEffect(() => {
    subscribeToMain();
    void useWorkspace.getState().load();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useWorkspace.getState().toggleSidebar();
      } else if (mod && e.code === "Backquote") {
        e.preventDefault();
        useWorkspace.getState().toggleDock();
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
          {sidebarOpen && <Sidebar />}
          {loadError ? (
            <div className="m-auto max-w-md text-center text-[13px] text-text-2">Latis couldn't load your workspace: {loadError}</div>
          ) : ready ? (
            <CanvasView />
          ) : (
            <div className="flex-1 bg-bg-1" aria-busy="true" />
          )}
          {dockOpen && <Dock />}
        </div>
        <StatusBar />
        <Toasts />
        <SettingsDialog />
        <Onboarding />
      </div>
    </ReactFlowProvider>
  );
}
