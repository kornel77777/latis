import { useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import { useWorkspace } from "../stores/workspace";

/** Canvas-aware commands shared by the title bar, sidebar, context menu and empty state. Needs ReactFlowProvider. */
export function useCanvasActions() {
  const flow = useReactFlow();

  /** Nearest free spot right of the viewport centre, or at a screen point. */
  const spot = useCallback(
    (size: { w: number; h: number }, screen?: { x: number; y: number }) => {
      if (screen) return flow.screenToFlowPosition(screen);
      const el = document.querySelector(".react-flow")?.getBoundingClientRect();
      const c = flow.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 });
      const pos = { x: c.x - size.w / 2, y: c.y - size.h / 2 };
      const roots = useWorkspace.getState().nodes.filter((n) => !n.parentId);
      const hit = () =>
        roots.some((n) => {
          const w = n.width ?? 400;
          const h = n.height ?? 400;
          return pos.x < n.position.x + w && pos.x + size.w > n.position.x && pos.y < n.position.y + h && pos.y + size.h > n.position.y;
        });
      for (let i = 0; i < 50 && hit(); i++) pos.x += size.w / 2 + 40;
      return pos;
    },
    [flow],
  );

  const openFolder = useCallback(
    (screen?: { x: number; y: number }) => useWorkspace.getState().openFolder(spot({ w: 1040, h: 700 }, screen)),
    [spot],
  );

  const newDemoChat = useCallback(
    (screen?: { x: number; y: number }) => {
      const p = spot({ w: 460, h: 600 }, screen);
      return useWorkspace.getState().createChat({ agentId: "fake", projectId: null, x: p.x, y: p.y });
    },
    [spot],
  );

  /** New chat for a real agent: in the selected node's project, else the only project, else ask for a folder first. */
  const newChat = useCallback(
    async (agentId: string) => {
      if (agentId === "fake" && !useWorkspace.getState().demoInProjects) return newDemoChat();
      const s = useWorkspace.getState();
      const selected = s.nodes.find((n) => n.selected);
      const fromSelection = selected?.data.projectId ?? (selected?.data.chatId ? s.chats[selected.data.chatId]?.summary.projectId : null);
      const projects = Object.values(s.projects);
      let projectId = fromSelection ?? (projects.length === 1 ? projects[0]!.id : null);
      if (!projectId) {
        if (projects.length > 1) {
          s.toast("Select a project frame (or a chat inside it) first, then start the chat.");
          return null;
        }
        projectId = (await openFolder())?.id ?? null;
        if (!projectId) return null;
      }
      await s.startChat(agentId, projectId);
      return null;
    },
    [newDemoChat, openFolder],
  );

  return { openFolder, newDemoChat, newChat };
}
