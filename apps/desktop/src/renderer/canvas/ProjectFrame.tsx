import { memo } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { AlertTriangle, FolderOpen, Plus } from "lucide-react";
import { Button, Menu, StatusDot } from "@latis/ui";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { AgentMenuItems } from "./AgentMenuItems";

export const PROJECT_COLORS: Record<string, string> = {
  teal: "#5eead4",
  indigo: "#818cf8",
  amber: "#f6b94c",
  pink: "#f472b6",
  green: "#4ade80",
  sky: "#6cc4f0",
};

export const ProjectFrame = memo(function ProjectFrame({ data, selected }: NodeProps<FlowNode>) {
  const project = useWorkspace((s) => (data.projectId ? s.projects[data.projectId] : undefined));
  const createChat = useWorkspace((s) => s.createChat);
  const counts = useWorkspace(
    useShallow((s) => {
      const st = Object.values(s.chats)
        .filter((c) => c.summary.projectId === data.projectId)
        .map((c) => c.summary.status);
      return [st.filter((x) => x === "working").length, st.filter((x) => x === "needs-you").length];
    }),
  );
  if (!project) return null;
  const color = PROJECT_COLORS[project.color] ?? PROJECT_COLORS.teal!;
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={520} minHeight={320} />
      <section
        aria-label={`Project ${project.name}`}
        data-testid="project-frame"
        className="h-full w-full rounded-panel border"
        style={{
          borderColor: `color-mix(in srgb, ${color} ${selected ? 55 : 28}%, transparent)`,
          background: `color-mix(in srgb, ${color} 4%, transparent)`,
        }}
      >
        <header className="latis-frame-drag flex h-11 cursor-grab items-center gap-2 px-4 active:cursor-grabbing">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
          <span className="text-[14px] font-semibold text-text-1">{project.name}</span>
          <span className="truncate font-mono text-[11px] text-text-3" title={project.folderPath}>
            {project.folderPath}
          </span>
          {project.folderMissing && (
            <span className="flex items-center gap-1 text-[11.5px] text-state-error">
              <AlertTriangle size={12} /> Folder missing
            </span>
          )}
          {counts[0]! > 0 && (
            <span className="flex items-center gap-1 text-[11.5px] text-text-2">
              <StatusDot status="working" /> {counts[0]}
            </span>
          )}
          {counts[1]! > 0 && (
            <span className="flex items-center gap-1 text-[11.5px] text-text-2">
              <StatusDot status="needs-you" /> {counts[1]}
            </span>
          )}
          <div className="nodrag ml-auto flex items-center gap-1">
            <Menu
              trigger={
                <Button size="sm" variant="secondary" disabled={project.folderMissing} data-testid="frame-new-chat">
                  <Plus size={13} /> New chat
                </Button>
              }
            >
              <AgentMenuItems includeDemo={false} onPick={(agentId) => void createChat({ agentId, projectId: project.id })} />
            </Menu>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open folder"
              onClick={() => void window.latis.invoke("project:reveal", { projectId: project.id })}
            >
              <FolderOpen size={14} />
            </Button>
          </div>
        </header>
      </section>
    </>
  );
});
