import { memo, useEffect, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, getBezierPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { CalendarClock, Check, ListOrdered, Pause, Play, ScrollText, Square, Trash2, Workflow, X } from "lucide-react";
import type { EdgeMode, FlowInfo, FlowSchedule } from "@latis/shared";
import { Button, Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { useZoomLevel } from "./zoom";

// Flows on the canvas (§11): the flow frame with its controls, Start nodes, edges with their
// modes, connect handles, and the dialogs for approvals, the run log, the brief and the schedule.

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

const MODE_LABEL: Record<EdgeMode, string> = { every: "", free: "free", wait_all: "wait for all", approval: "approval" };
const MODE_HINT: Record<EdgeMode, string> = {
  every: "Every output goes along",
  free: "Shared: the first idle target takes it",
  wait_all: "The target waits for all its wait-for-all inputs",
  approval: "Waits for you to keep, send back or drop it",
};

/** Whether a node sits inside a flow frame (and so gets connect handles). */
export function useInFlow(nodeId: string): boolean {
  return useWorkspace((s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return Boolean(n?.parentId && s.nodes.find((p) => p.id === n.parentId)?.type === "flow");
  });
}

export function FlowHandles({ nodeId, input = true }: { nodeId: string; input?: boolean }) {
  const inFlow = useInFlow(nodeId);
  if (!inFlow) return null;
  return (
    <>
      {input && <Handle type="target" position={Position.Left} className="latis-handle" />}
      <Handle type="source" position={Position.Right} className="latis-handle" />
    </>
  );
}

const call = <T,>(p: Promise<T>, then?: (v: T) => void) =>
  void p.then((v) => then?.(v)).catch((err: unknown) => useWorkspace.getState().toast(errorText(err)));

const setFlow = (f: FlowInfo) => useWorkspace.setState((s) => ({ flows: { ...s.flows, [f.id]: f } }));

function scheduleText(s: FlowSchedule | null): string {
  if (!s) return "Not scheduled";
  if (s.every === "hourly") return `Hourly at :${s.at.slice(3)}`;
  if (s.every === "daily") return `Daily at ${s.at}`;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][s.weekday ?? 1];
  return `${day}s at ${s.at}`;
}

const STATUS_TEXT = { running: "Running", paused: "Paused", done: "Done", stopped: "Stopped", error: "Error" } as const;

export const FlowFrame = memo(function FlowFrame({ id, data, selected }: NodeProps<FlowNode>) {
  const flowId = String((data as { flowId?: string }).flowId ?? "");
  const flow = useWorkspace((s) => s.flows[flowId]);
  const level = useZoomLevel();
  const run = flow?.run;
  const live = run && (run.status === "running" || run.status === "paused");
  if (!flow) return null;
  const open = (kind: "log" | "approvals" | "schedule" | "brief") => useWorkspace.setState({ flowDialog: { flowId, kind } });

  if (level === "tile")
    return (
      <section
        aria-label={`Flow ${flow.name}`}
        data-testid="flow-frame"
        className="h-full w-full rounded-panel border-2 border-dashed border-accent/50 bg-accent/5"
      >
        <header className="latis-frame-drag flex items-center gap-5 px-8 py-6">
          <Workflow size={48} className="text-accent" />
          <span className="truncate text-[56px] font-semibold text-text-1">{flow.name}</span>
          {live && <span className="text-[40px] text-text-2">{STATUS_TEXT[run.status]}</span>}
        </header>
      </section>
    );

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={480} minHeight={300} />
      <section
        aria-label={`Flow ${flow.name}`}
        data-testid="flow-frame"
        data-flow-id={flowId}
        data-run={run?.status ?? "none"}
        className="h-full w-full rounded-panel border border-dashed border-accent/50 bg-accent/[0.03]"
      >
        <header className="latis-frame-drag flex h-12 cursor-grab items-center gap-2 px-3 active:cursor-grabbing">
          <Workflow size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate text-[13px] font-semibold text-text-1">{flow.name}</span>
          <span className="text-[12px] text-text-3" data-testid="flow-status">
            {run ? STATUS_TEXT[run.status] : "Not run yet"}
            {live && run.handoffs ? ` · ${run.handoffs} handoff${run.handoffs === 1 ? "" : "s"}` : ""}
          </span>
          <div className="nodrag ml-auto flex items-center gap-1">
            {run?.approvals.length ? (
              <Button size="sm" variant="primary" onClick={() => open("approvals")} data-testid="flow-approvals">
                <Check size={12} /> {run.approvals.length} to approve
              </Button>
            ) : null}
            {run?.loopCheck && (
              <>
                <span className="text-[12px] text-state-needs-you">Many handoffs in a row.</span>
                <Button size="sm" variant="secondary" onClick={() => call(latis.invoke("flow:loop", { flowId, continue: true }), setFlow)}>
                  Continue
                </Button>
              </>
            )}
            <button
              className="flex h-7 items-center gap-1 rounded-control px-2 text-[12px] text-text-2 hover:bg-surface-2 hover:text-text-1"
              onClick={() => open("schedule")}
              data-testid="flow-schedule"
            >
              <CalendarClock size={12} /> {scheduleText(flow.schedule)}
            </button>
            {!live ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => call(latis.invoke("flow:start", { flowId }), setFlow)}
                data-testid="flow-start"
              >
                <Play size={12} /> Start
              </Button>
            ) : run.status === "running" ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Pause"
                onClick={() => call(latis.invoke("flow:control", { flowId, action: "pause" }), setFlow)}
              >
                <Pause size={13} />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Resume"
                onClick={() => call(latis.invoke("flow:control", { flowId, action: "resume" }), setFlow)}
              >
                <Play size={13} />
              </Button>
            )}
            {live && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Stop"
                onClick={() => call(latis.invoke("flow:control", { flowId, action: "stop" }), setFlow)}
              >
                <Square size={12} />
              </Button>
            )}
            <Button size="icon" variant="ghost" aria-label="Run log" onClick={() => open("log")} data-testid="flow-log">
              <ScrollText size={13} />
            </Button>
            <Menu
              trigger={
                <Button size="icon" variant="ghost" aria-label="Flow menu">
                  <ListOrdered size={13} />
                </Button>
              }
            >
              <MenuItem onSelect={() => open("brief")}>Brief and name…</MenuItem>
              <MenuItem onSelect={() => open("schedule")}>Schedule…</MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => void useWorkspace.getState().deleteNodes([id])}>
                <Trash2 size={13} /> Delete flow
              </MenuItem>
            </Menu>
          </div>
        </header>
      </section>
    </>
  );
});

/** The Start node (§11.1): the input a run starts with, optionally one task per line. */
export const StartNode = memo(function StartNode({ id, data, selected, parentId }: NodeProps<FlowNode> & { parentId?: string }) {
  const d = data as { title?: string; input?: string; oneTaskPerLine?: boolean };
  const flowId = useWorkspace((s) => {
    const parent = s.nodes.find((n) => n.id === (parentId ?? s.nodes.find((x) => x.id === id)?.parentId));
    return String((parent?.data as { flowId?: string } | undefined)?.flowId ?? "");
  });
  const live = useWorkspace((s) => ["running", "paused"].includes(s.flows[flowId]?.run?.status ?? ""));
  const [input, setInput] = useState(d.input ?? "");
  const [perLine, setPerLine] = useState(Boolean(d.oneTaskPerLine));
  const save = (next: { input?: string; oneTaskPerLine?: boolean }) =>
    call(latis.invoke("flow:setStart", { nodeId: id, input: next.input ?? input, oneTaskPerLine: next.oneTaskPerLine ?? perLine }));
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={180} />
      <article
        data-testid="start-node"
        className={cn(
          "flex h-full w-full flex-col rounded-card border bg-surface",
          selected ? "border-line-strong shadow-lift" : "border-line",
        )}
      >
        <header className="latis-drag flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-line px-3">
          <Play size={12} className="text-accent" />
          <span className="truncate text-[13px] font-semibold text-text-1">{d.title ?? "Start"}</span>
        </header>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => save({})}
          placeholder={perLine ? "One task per line…" : "What should the flow work on?"}
          aria-label="Flow input"
          className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-3 py-2 text-[13px] text-text-1 outline-none placeholder:text-text-3"
          data-testid="start-input"
        />
        <footer className="nodrag flex items-center gap-2 border-t border-line px-3 py-1.5 text-[12px] text-text-2">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={perLine}
              onChange={(e) => {
                setPerLine(e.target.checked);
                save({ oneTaskPerLine: e.target.checked });
              }}
              className="accent-[var(--accent)]"
            />
            One task per line
          </label>
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            disabled={live || !flowId}
            onClick={() => call(latis.invoke("flow:start", { flowId, input }), setFlow)}
            data-testid="start-run"
          >
            <Play size={11} /> Run
          </Button>
        </footer>
      </article>
      <FlowHandles nodeId={id} input={false} />
    </>
  );
});

/** An edge with its mode (§11.2); click the label to change it or remove the edge. */
export function FlowEdgeView(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd } = props;
  const mode = ((props.data as { mode?: EdgeMode } | undefined)?.mode ?? "every") as EdgeMode;
  const waiting = useWorkspace((s) =>
    Object.values(s.flows).reduce((n, f) => n + (f.run?.approvals.filter((a) => a.edgeId === id).length ?? 0), 0),
  );
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const set = (m: EdgeMode | null) =>
    call(latis.invoke("flow:edge", { edgeId: id, mode: m }), () =>
      useWorkspace.setState((s) => ({
        flowEdges: m === null ? s.flowEdges.filter((e) => e.id !== id) : s.flowEdges.map((e) => (e.id === id ? { ...e, mode: m } : e)),
      })),
    );
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd && { markerEnd })}
        style={{
          stroke: mode === "approval" ? "var(--state-needs-you)" : "var(--accent)",
          strokeWidth: 1.5,
          strokeDasharray: mode === "free" ? "6 4" : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        >
          <Menu
            trigger={
              <button
                className={cn(
                  "rounded-control border bg-surface px-1.5 py-0.5 text-[10.5px] leading-none hover:border-line-strong",
                  waiting ? "border-state-needs-you text-state-needs-you" : "border-line text-text-3",
                )}
                aria-label={`Edge: ${mode}`}
                data-testid="edge-label"
              >
                {waiting ? `${waiting} waiting` : MODE_LABEL[mode] || "·"}
              </button>
            }
          >
            <MenuLabel>Send outputs</MenuLabel>
            {(Object.keys(MODE_HINT) as EdgeMode[]).map((m) => (
              <MenuItem key={m} onSelect={() => set(m)}>
                <span className="w-3">{m === mode && "●"}</span>
                <span>
                  <span className="block">
                    {m === "every" ? "Every" : m === "wait_all" ? "Wait for all" : m[0]!.toUpperCase() + m.slice(1)}
                  </span>
                  <span className="block text-[11px] text-text-3">{MODE_HINT[m]}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem danger onSelect={() => set(null)}>
              <X size={13} /> Remove
            </MenuItem>
          </Menu>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Approvals, run log, brief and schedule (§11.2, §11.3). */
export function FlowDialogs() {
  const dlg = useWorkspace((s) => s.flowDialog);
  const flow = useWorkspace((s) => (s.flowDialog ? s.flows[s.flowDialog.flowId] : undefined));
  const close = () => useWorkspace.setState({ flowDialog: null });
  if (!dlg || !flow) return null;
  const title = {
    log: `Run log · ${flow.name}`,
    approvals: "Waiting for your approval",
    schedule: `Schedule · ${flow.name}`,
    brief: "Flow",
  }[dlg.kind];
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={title} width={dlg.kind === "approvals" ? 640 : 520}>
      {dlg.kind === "log" && <RunLog flow={flow} />}
      {dlg.kind === "approvals" && <Approvals flow={flow} onDone={close} />}
      {dlg.kind === "schedule" && <ScheduleForm flow={flow} onDone={close} />}
      {dlg.kind === "brief" && <BriefForm flow={flow} onDone={close} />}
    </Dialog>
  );
}

function RunLog({ flow }: { flow: FlowInfo }) {
  const run = flow.run;
  if (!run) return <p className="text-[13px] text-text-3">This flow hasn&apos;t run yet.</p>;
  return (
    <div data-testid="run-log">
      <p className="mb-2 text-[12px] text-text-3">
        Started by {run.trigger} · {new Date(run.startedAt).toLocaleString()} · {STATUS_TEXT[run.status]}
      </p>
      <ol className="max-h-[50vh] overflow-y-auto text-[12.5px]">
        {run.log.map((l, i) => (
          <li key={i} className="flex gap-3 border-b border-line py-1 last:border-b-0">
            <span className="shrink-0 font-mono text-[11px] text-text-3">{new Date(l.at).toLocaleTimeString()}</span>
            <span className="text-text-1">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Approvals({ flow, onDone }: { flow: FlowInfo; onDone: () => void }) {
  const items = flow.run?.approvals ?? [];
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!items.length) onDone();
  }, [items.length, onDone]);
  const act = (approvalId: string, action: "keep" | "sendBack" | "drop") =>
    call(
      latis.invoke("flow:approve", {
        flowId: flow.id,
        approvalId,
        action,
        ...(texts[approvalId] !== undefined && { text: texts[approvalId] }),
        ...(feedback[approvalId] && { feedback: feedback[approvalId] }),
      }),
      setFlow,
    );
  return (
    <div className="flex flex-col gap-4" data-testid="approvals">
      {items.map((a) => (
        <div key={a.id} className="flex flex-col gap-2 rounded-panel border border-line p-3">
          <div className="text-[12px] text-text-3">
            {a.from} → {a.to}
          </div>
          <textarea
            value={texts[a.id] ?? a.text}
            onChange={(e) => setTexts((t) => ({ ...t, [a.id]: e.target.value }))}
            rows={8}
            aria-label="Output to approve"
            className="w-full rounded-control border border-line bg-bg-1 px-2 py-1.5 text-[12.5px] text-text-1 outline-none focus:border-line-strong"
          />
          <input
            value={feedback[a.id] ?? ""}
            onChange={(e) => setFeedback((f) => ({ ...f, [a.id]: e.target.value }))}
            placeholder="Feedback, if you send it back"
            aria-label="Feedback"
            className="h-8 rounded-control border border-line bg-bg-1 px-2 text-[12.5px] text-text-1"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => act(a.id, "keep")} data-testid="approve-keep">
              <Check size={12} /> Keep
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act(a.id, "sendBack")}>
              Send back
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(a.id, "drop")}>
              Drop
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ScheduleForm({ flow, onDone }: { flow: FlowInfo; onDone: () => void }) {
  const [every, setEvery] = useState<FlowSchedule["every"] | "off">(flow.schedule?.every ?? "off");
  const [at, setAt] = useState(flow.schedule?.at ?? "08:00");
  const [weekday, setWeekday] = useState(flow.schedule?.weekday ?? 1);
  const save = () =>
    call(
      latis.invoke("flow:update", {
        flowId: flow.id,
        schedule: every === "off" ? null : { every, at, ...(every === "weekly" && { weekday }) },
      }),
      (f) => {
        setFlow(f);
        onDone();
      },
    );
  const input = "h-8 rounded-control border border-line bg-bg-1 px-2 text-[13px] text-text-1";
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="schedule-form">
      <div className="flex items-center gap-2">
        <select value={every} onChange={(e) => setEvery(e.target.value as typeof every)} aria-label="Repeat" className={input}>
          <option value="off">Don&apos;t run on a schedule</option>
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </select>
        {every === "weekly" && (
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} aria-label="Day" className={input}>
            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        )}
        {every !== "off" && <input type="time" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Time" className={input} />}
      </div>
      <p className="text-[12px] text-text-3">
        Runs while Latis is open. A run missed while it was closed happens once when Latis next starts.
        {flow.nextRunAt ? ` Next: ${new Date(flow.nextRunAt).toLocaleString()}.` : ""}
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function BriefForm({ flow, onDone }: { flow: FlowInfo; onDone: () => void }) {
  const [name, setName] = useState(flow.name);
  const [brief, setBrief] = useState(flow.brief);
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-text-2">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 rounded-control border border-line bg-bg-1 px-2 text-text-1"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-text-2">Brief: goal and constraints, sent with every message any chat in the flow gets</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={5}
          className="rounded-control border border-line bg-bg-1 px-2 py-1.5 text-text-1"
        />
      </label>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={() =>
            call(latis.invoke("flow:update", { flowId: flow.id, name: name.trim(), brief }), (f) => {
              setFlow(f);
              onDone();
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** "New flow" (§11.5): one click on a template, editable afterwards. */
export function FlowTemplates() {
  const at = useWorkspace((s) => s.flowTemplatesAt);
  const [list, setList] = useState<{ id: string; title: string; description: string }[]>([]);
  useEffect(() => {
    if (at && !list.length) void latis.invoke("flow:templates").then(setList);
  }, [at, list.length]);
  const close = () => useWorkspace.setState({ flowTemplatesAt: null });
  const pick = (template: string) => {
    const ws = useWorkspace.getState();
    call(latis.invoke("flow:create", { canvasId: ws.canvasId, template, x: Math.round(at!.x), y: Math.round(at!.y) }), (r) => {
      ws.addFlow(r);
      close();
    });
  };
  return (
    <Dialog
      open={Boolean(at)}
      onOpenChange={(o) => !o && close()}
      title="New flow"
      description="Chats, notes and cards wired together. Start from a template, then change anything."
      width={600}
    >
      <div className="grid grid-cols-2 gap-2" data-testid="flow-templates">
        {list.map((t) => (
          <button
            key={t.id}
            onClick={() => pick(t.id)}
            className="flex items-start gap-2.5 rounded-panel border border-line p-3 text-left hover:border-line-strong hover:bg-surface-2"
          >
            <Workflow size={16} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="block text-[13px] font-medium text-text-1">{t.title}</span>
              <span className="block text-[12px] text-text-3">{t.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** A chat's job inside a flow (§11.1), shown under its header. */
export function ChatJob({ nodeId }: { nodeId: string }) {
  const inFlow = useInFlow(nodeId);
  const job = useWorkspace((s) => String((s.nodes.find((n) => n.id === nodeId)?.data as { job?: string } | undefined)?.job ?? ""));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(job);
  if (!inFlow) return null;
  if (editing)
    return (
      <form
        className="nodrag flex shrink-0 gap-1 border-b border-line bg-bg-1 px-3 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          call(latis.invoke("flow:setJob", { nodeId, job: text }), () =>
            useWorkspace.setState((s) => ({ nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, job: text } } : n)) })),
          );
        }}
      >
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Job"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text-1 outline-none"
        />
        <Button size="sm" variant="ghost" type="submit">
          Save
        </Button>
      </form>
    );
  return (
    <button
      className="nodrag shrink-0 truncate border-b border-line bg-bg-1 px-3 py-1 text-left text-[12px] text-text-2 hover:text-text-1"
      onClick={() => {
        setText(job);
        setEditing(true);
      }}
      title="This chat's job in the flow: added to every message it receives"
      data-testid="chat-job"
    >
      <span className="text-text-3">Job:</span> {job || "none. Click to give it one."}
    </button>
  );
}
