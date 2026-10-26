import { memo, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  FolderOpen,
  FolderSearch,
  Maximize2,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, StatusDot } from "@latis/ui";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { AgentMenuItems } from "./AgentMenuItems";
import { useZoomLevel } from "./zoom";

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
  const startChat = useWorkspace((s) => s.startChat);
  const [renaming, setRenaming] = useState(false);
  const level = useZoomLevel();
  const { updateProject, locateProject, deleteNodes, focusNode, newTerminal } = useWorkspace.getState();
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
  // Zoomed out (§8.4): a big readable label instead of a toolbar nobody can hit.
  if (level === "tile") {
    return (
      <>
        <NodeResizer isVisible={selected} minWidth={520} minHeight={320} />
        <section
          aria-label={`Project ${project.name}`}
          data-testid="project-frame"
          className="h-full w-full rounded-panel border-2"
          style={{
            borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
            background: `color-mix(in srgb, ${color} 5%, transparent)`,
          }}
        >
          <header className="latis-frame-drag flex cursor-grab items-center gap-5 px-8 py-6 active:cursor-grabbing">
            <span className="h-8 w-8 rounded-control" style={{ background: color }} />
            <span className="text-[56px] font-semibold text-text-1">{project.name}</span>
            {counts[0]! > 0 && (
              <span className="flex items-center gap-3 text-[36px] text-text-2">
                <StatusDot status="working" className="!h-6 !w-6" /> {counts[0]}
              </span>
            )}
            {counts[1]! > 0 && (
              <span className="flex items-center gap-3 text-[36px] text-text-2">
                <StatusDot status="needs-you" className="!h-6 !w-6" /> {counts[1]}
              </span>
            )}
          </header>
        </section>
      </>
    );
  }
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
          <span className="h-2.5 w-2.5 rounded-control" style={{ background: color }} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={project.name}
              aria-label="Project name"
              className="nodrag w-48 rounded-control border border-line-strong bg-bg-1 px-1.5 text-[14px] font-semibold text-text-1 outline-none"
              onBlur={(e) => {
                setRenaming(false);
                const name = e.currentTarget.value.trim();
                if (name && name !== project.name) void updateProject(project.id, { name });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span className="text-[14px] font-semibold text-text-1" onDoubleClick={() => setRenaming(true)} data-testid="frame-name">
              {project.name}
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-text-3" title={project.folderPath}>
            {project.folderPath}
          </span>
          {project.folderMissing && (
            <span className="nodrag flex items-center gap-1.5 text-[11.5px] text-state-error">
              <AlertTriangle size={12} /> Folder missing
              <Button size="sm" variant="secondary" onClick={() => void locateProject(project.id)} data-testid="frame-locate">
                <FolderSearch size={12} /> Locate…
              </Button>
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
              <AgentMenuItems
                includeDemo={useWorkspace.getState().demoInProjects}
                onPick={(agentId) => void startChat(agentId, project.id)}
              />
            </Menu>
            <Button size="icon" variant="ghost" aria-label="Terminal in this project" onClick={() => void newTerminal(project.id)}>
              <SquareTerminal size={14} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open folder"
              onClick={() => void window.latis.invoke("project:reveal", { projectId: project.id })}
            >
              <FolderOpen size={14} />
            </Button>
            <Button size="icon" variant="ghost" aria-label="Fit project" onClick={() => focusNode(project.frameNodeId)}>
              <Maximize2 size={13} />
            </Button>
            <Menu
              trigger={
                <Button size="icon" variant="ghost" aria-label="Project menu" data-testid="frame-menu">
                  <MoreHorizontal size={15} />
                </Button>
              }
            >
              <MenuItem onSelect={() => setRenaming(true)}>
                <Pencil size={13} /> Rename
              </MenuItem>
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <Palette size={12} /> Colour
                </span>
              </MenuLabel>
              <div className="flex gap-1.5 px-2 pb-1.5" role="group" aria-label="Project colour">
                {Object.entries(PROJECT_COLORS).map(([name, hex]) => (
                  <button
                    key={name}
                    aria-label={name}
                    aria-pressed={project.color === name}
                    onClick={() => void updateProject(project.id, { color: name })}
                    className="h-5 w-5 rounded-control border-2"
                    style={{ background: hex, borderColor: project.color === name ? "var(--text-1)" : "transparent" }}
                  />
                ))}
              </div>
              <MenuItem onSelect={() => useWorkspace.getState().tidyUp()}>
                <Maximize2 size={13} /> Tidy up
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => void deleteNodes([project.frameNodeId])}>
                <Trash2 size={13} /> Remove project from canvas
              </MenuItem>
            </Menu>
          </div>
        </header>
      </section>
    </>
  );
});
