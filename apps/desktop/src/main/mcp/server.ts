import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PermissionModeSchema } from "@latis/shared";
import { ToolError, type WorkspaceService } from "./workspace";

// Workspace MCP server (SPEC §10.1): Streamable HTTP on 127.0.0.1, a random port, and a bearer
// token per chat, generated each launch. The token says which chat is calling, which is what
// placement and the guardrails need. Stateless: every POST gets a fresh server bound to its caller.

const BODY_LIMIT = 4 * 1024 * 1024;
/** wait_for_chats blocks; agents get this as their tool timeout. */
export const TOOL_TIMEOUT_SEC = 1800;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => unknown): Promise<Result> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `Latis couldn't do that: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof ToolError)) console.warn("[mcp] tool failed", err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Registers every workspace tool for one caller. */
export function registerTools(server: McpServer, ws: WorkspaceService, caller: string): void {
  const read = { readOnlyHint: true, openWorldHint: false };
  server.registerTool(
    "list_projects",
    { description: "Projects (folders) on the Latis canvas with their chat counts.", inputSchema: {}, annotations: read },
    () => run(() => ws.listProjects()),
  );
  server.registerTool(
    "list_chats",
    {
      description: "Chats on the canvas: id, title, agent, model, cwd, branch, status (idle/working/needs-you/done/error), last activity.",
      inputSchema: { project_id: z.string().optional(), status: z.enum(["idle", "working", "needs-you", "done", "error"]).optional() },
      annotations: read,
    },
    (a) => run(() => ws.listChats(a)),
  );
  server.registerTool(
    "read_chat",
    {
      description: "Recent messages of a chat (user and assistant) with a short summary of the steps it took.",
      inputSchema: { chat_id: z.string(), last_turns: z.number().int().min(1).max(50).default(3) },
      annotations: read,
    },
    (a) => run(() => ws.readChat(a.chat_id, a.last_turns)),
  );
  server.registerTool(
    "spawn_chat",
    {
      description:
        "Start a new chat with a coding agent in a folder and send it a first message. Returns its id right away; the agent works in the background (use wait_for_chats). " +
        "agent: claude-code, codex, gemini (or another installed agent id). own_copy: work in a separate git worktree so parallel chats don't clash.",
      inputSchema: {
        agent: z.string(),
        cwd: z.string().describe("Folder to work in; ~ is allowed. It becomes a project on the canvas if it isn't one."),
        prompt: z.string().min(1),
        model: z.string().optional(),
        own_copy: z.boolean().optional(),
        title: z.string().max(80).optional(),
        permission_mode: PermissionModeSchema.optional().describe("Only a stricter mode than yours is accepted."),
      },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.spawnChat(caller, a)),
  );
  server.registerTool(
    "send_message",
    {
      description:
        'Send a message to another chat. mode "queue" (default) delivers it after the current turn; "now" delivers it at the agent\'s next step.',
      inputSchema: { chat_id: z.string(), text: z.string().min(1), mode: z.enum(["queue", "now"]).default("queue") },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.sendMessage(a.chat_id, a.text, a.mode)),
  );
  server.registerTool(
    "wait_for_chats",
    {
      description:
        "Wait until none of these chats is working (finished, stopped, or waiting for the user), then return each one's status and final message.",
      inputSchema: {
        chat_ids: z.array(z.string()).min(1).max(20),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(TOOL_TIMEOUT_SEC - 30)
          .default(900),
      },
      annotations: read,
    },
    (a, extra) => run(() => ws.waitForChats(a.chat_ids, a.timeout_s, extra.signal)),
  );
  server.registerTool(
    "get_diff",
    {
      description: "Files a chat changed, as a diff stat plus the patch (truncated if large).",
      inputSchema: { chat_id: z.string() },
      annotations: read,
    },
    (a) => run(() => ws.getDiff(a.chat_id)),
  );
  server.registerTool(
    "create_note",
    {
      description: "Write a markdown note on the canvas (results, summaries, comparisons). Placed below near_chat_id, or below you.",
      inputSchema: { title: z.string().min(1).max(120), markdown: z.string(), near_chat_id: z.string().optional() },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.createNote(caller, a.title, a.markdown, a.near_chat_id)),
  );
  server.registerTool(
    "append_note",
    {
      description: "Add markdown to the end of a note created earlier.",
      inputSchema: { note_id: z.string(), markdown: z.string().min(1) },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.appendNote(a.note_id, a.markdown)),
  );
  server.registerTool(
    "focus",
    {
      description: "Open a focus view for the user showing these chats side by side (chat ids).",
      inputSchema: {
        node_ids: z.array(z.string()).min(1).max(12),
        layout: z.enum(["grid", "stage", "columns"]).optional(),
        name: z.string().max(60).optional(),
      },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.focus(a.node_ids, a.layout, a.name)),
  );
  server.registerTool(
    "create_card",
    {
      description:
        "Put a small HTML app (a card) on the canvas: a tracker, dashboard, calculator… One self-contained index.html (inline CSS/JS). " +
        "It runs sandboxed with NO network. Inside it, window.latis gives: data.get(key), data.set(key, value), data.list() (persisted), " +
        "refresh() (runs refresh_script, a Node .mjs that prints a JSON object merged into the data; the user approves it first), " +
        "ask(prompt), exportPdf(), theme.tokens (CSS vars --latis-surface, --latis-text, --latis-muted, --latis-accent, --latis-line are set for you).",
      inputSchema: {
        title: z.string().min(1).max(80),
        html: z.string().min(1).max(500_000),
        refresh_script: z.string().max(200_000).optional(),
        near_chat_id: z.string().optional(),
      },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.createCard(caller, a)),
  );
  server.registerTool(
    "update_card",
    {
      description: "Replace a card's HTML, refresh script or title. The card reloads; its data is kept.",
      inputSchema: {
        card_id: z.string(),
        html: z.string().max(500_000).optional(),
        refresh_script: z.string().max(200_000).optional(),
        title: z.string().max(80).optional(),
      },
      annotations: { openWorldHint: false },
    },
    (a) => run(() => ws.updateCard(a.card_id, a)),
  );
  server.registerTool(
    "tidy_canvas",
    { description: "Arrange the chats inside every project frame into tidy rows.", inputSchema: {}, annotations: { openWorldHint: false } },
    () => run(() => ws.tidy()),
  );
  server.registerTool(
    "close_chat",
    {
      description: "Close a chat you started. The user is asked to confirm first.",
      inputSchema: { chat_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    (a) => run(() => ws.closeChat(caller, a.chat_id)),
  );
}

export class WorkspaceMcpServer {
  private http: Server | null = null;
  private tokens = new Map<string, string>();
  private byChat = new Map<string, string>();
  port = 0;

  constructor(private readonly ws: WorkspaceService) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** The bearer token that identifies a chat to the server (kept for the app's lifetime). */
  tokenFor(chatId: string): string {
    let t = this.byChat.get(chatId);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.byChat.set(chatId, t);
      this.tokens.set(t, chatId);
    }
    return t;
  }

  private callerOf(req: IncomingMessage): string | undefined {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return undefined;
    const given = Buffer.from(m[1]!);
    for (const [token, chatId] of this.tokens) {
      const t = Buffer.from(token);
      if (t.length === given.length && timingSafeEqual(t, given)) return chatId;
    }
    return undefined;
  }

  start(): Promise<void> {
    this.http = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(0, "127.0.0.1", () => {
        this.port = (this.http!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): void {
    this.http?.close();
    this.http?.closeAllConnections();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const deny = (code: number, message: string) => {
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
    };
    // DNS rebinding: only our own host names.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return deny(403, "forbidden host");
    if (req.headers.origin) return deny(403, "browsers can't call this server");
    if (!req.url?.startsWith("/mcp")) return deny(404, "not found");
    const caller = this.callerOf(req);
    if (!caller) return deny(401, "missing or unknown token");
    if (req.method !== "POST") return deny(405, "stateless server: POST only");
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return deny(400, "invalid JSON");
    }
    const server = new McpServer({ name: "latis", version: "0.1.0" });
    registerTools(server, this.ws, caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.warn("[mcp] request failed", err);
      if (!res.headersSent) deny(500, "internal error");
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
