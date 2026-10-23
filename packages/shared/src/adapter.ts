import type { AgentEvent, UsageWindow } from "./agent-events";

// Agent adapter layer (SPEC §6.1). All agents look identical to the rest of the app.

export type Unsubscribe = () => void;
export type PermissionMode = "read-only" | "ask" | "auto-edit" | "full-auto";

export interface AgentCapabilities {
  streaming: boolean;
  steering: boolean;
  images: boolean;
  resume: boolean;
  permissions: "native" | "emulated" | "none";
  plans: boolean;
  questions: boolean;
  subagents: boolean;
  mcp: boolean;
  reasoningLevels: boolean;
  usageReporting: boolean;
  nativeTerminal: boolean;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  binaryPath?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  account?: string;
  method?: "subscription" | "api-key" | "none";
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  reasoningLevels?: string[];
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Seconds a tool call may take before the agent gives up (wait_for_chats blocks). */
  toolTimeoutSec?: number;
  /** Latis's own server: its tools carry their guardrails in Latis, so the agent shouldn't ask per call. */
  trusted?: boolean;
}

export interface SessionOptions {
  cwd: string;
  /** The Latis chat this session belongs to. */
  chatId?: string;
  model?: string;
  reasoning?: string;
  permissionMode: PermissionMode;
  alwaysAsk: string[];
  systemPromptAppend?: string;
  mcpServers?: McpServerConfig[];
  env?: Record<string, string>;
}

export interface PtySpec {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface LoginHandle {
  pty: PtySpec;
  done: Promise<AuthStatus>;
}

export type UsageSnapshot = UsageWindow[];

export interface UserTurn {
  text: string;
  images?: { mime: string; dataBase64: string }[];
  fileRefs?: string[];
}

export type PermissionResponse = { kind: "permission"; decision: "allow-once" | "allow-chat" | "allow-project" | "deny"; reason?: string };
/** `answers` maps question text → chosen label(s), comma-separated for multi-select. */
export type QuestionAnswer = { kind: "answer"; text?: string; answers?: Record<string, string> };
export type PlanDecision = { kind: "plan"; approve: boolean; feedback?: string };
export type RequestResponse = PermissionResponse | QuestionAnswer | PlanDecision;

export interface AgentSession {
  id: string;
  nativeSessionId?: string;
  /** Terminal-only agents: the PTY the chat card shows. */
  ptyId?: string;
  send(turn: UserTurn): Promise<void>;
  steer?(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, response: RequestResponse): Promise<void>;
  setModel?(model: string, reasoning?: string): Promise<void>;
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  onEvent(listener: (e: AgentEvent) => void): Unsubscribe;
  /** Fires once if the underlying process dies unexpectedly. */
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  hue: string;
  capabilities: AgentCapabilities;
  detect(): Promise<DetectResult>;
  authStatus(): Promise<AuthStatus>;
  login?(): Promise<LoginHandle>;
  listModels(): Promise<ModelInfo[]>;
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession?(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession>;
  terminalCommand(opts: SessionOptions & { nativeSessionId?: string }): PtySpec;
  usage?(): Promise<UsageSnapshot>;
}
