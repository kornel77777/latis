// `lattiz-mcp`: the stdio shim for agents that only speak MCP over stdio (SPEC §10.1). Lattiz starts
// it with ELECTRON_RUN_AS_NODE=1 and LATTIZ_MCP_URL / LATTIZ_MCP_TOKEN set; it forwards each JSON-RPC
// line to the running app's Workspace MCP server and writes the replies back.
import { createInterface } from "node:readline";

const url = process.env.LATTIZ_MCP_URL;
const token = process.env.LATTIZ_MCP_TOKEN;

function write(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function forward(line: string) {
  let msg: { id?: string | number; method?: string };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const fail = (message: string) => {
    if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
  };
  if (!url || !token) return fail("lattiz-mcp needs LATTIZ_MCP_URL and LATTIZ_MCP_TOKEN (Lattiz sets them for its own chats).");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: line,
    });
    if (res.status === 202) return; // a notification
    const text = await res.text();
    if (!res.ok) return fail(`Lattiz answered ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as unknown;
    for (const m of Array.isArray(body) ? body : [body]) write(m);
  } catch (err) {
    fail(`Lattiz isn't reachable (${err instanceof Error ? err.message : String(err)}). Is the app still running?`);
  }
}

// Requests run concurrently (wait_for_chats blocks), replies go out as they finish.
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) void forward(line);
});
