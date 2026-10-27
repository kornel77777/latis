// Records a real ACP (Agent Client Protocol) exchange into fixtures/acp/<name>.jsonl (SPEC §0.2, §16).
// Usage: node scripts/record-acp-stream.mjs <name> "<prompt>" --agent "<command> [args…]" [--deny] [--mode <modeId>]
//          [--model <value>] [--then "<second prompt>"] [--cancel] [--resume]
// Uses whatever account the agent is signed in with. Paths, ids and identities are scrubbed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [name, prompt, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const arg = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
if (!name || !prompt || !arg("--agent")) throw new Error('usage: record-acp-stream.mjs <name> <prompt> --agent "cmd args" [flags]');
const [command, ...args] = arg("--agent").split(" ");
const cwd = mkdtempSync(join(process.env.LATTIZ_TEST_TMP ?? tmpdir(), "lattiz-rec-"));
writeFileSync(join(cwd, "README.md"), "# Recording sandbox\n");

const lines = [];
const ids = new Map();
const scrub = (s) =>
  s
    .replaceAll(cwd, "<cwd>")
    .replaceAll(homedir(), "<home>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "user@example.com")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
      return ids.get(id);
    });
const record = (dir, msg) => lines.push(scrub(JSON.stringify({ dir, msg })));

let proc, nextId, pending;
function start() {
  proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"], detached: true });
  nextId = 0;
  pending = new Map();
  createInterface({ input: proc.stdout }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return; // agents sometimes log to stdout; ACP frames are JSON only
    }
    record("in", m);
    if (m.id !== undefined && !m.method) pending.get(m.id)?.(m);
    else if (m.id !== undefined) answer(m);
  });
}
const send = (m) => {
  record("out", m);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    send({ id, method, params });
  });

// Agent → client requests: answer like a user would.
function answer(m) {
  if (m.method === "session/request_permission") {
    const want = flag("--deny") ? ["reject_once", "reject_always"] : ["allow_once", "allow_always"];
    // In preference order, like the adapter (allow_always can fail, e.g. Gemini in an untrusted folder).
    const option = want.map((k) => m.params.options.find((o) => o.kind === k)).find(Boolean) ?? m.params.options[0];
    send({ id: m.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
  } else send({ id: m.id, error: { code: -32601, message: `Lattiz recorder doesn't implement ${m.method}` } });
}

const init = () =>
  request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "lattiz", title: "Lattiz", version: "0.0.0" },
  });

async function turn(sessionId, text) {
  const done = request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  if (flag("--cancel")) setTimeout(() => send({ method: "session/cancel", params: { sessionId } }), 4000);
  return done;
}

start();
await init();
const session = await request("session/new", { cwd, mcpServers: [] });
const sessionId = session.sessionId;
if (arg("--mode")) await request("session/set_mode", { sessionId, modeId: arg("--mode") });
const setModel = (sid) =>
  request("session/set_config_option", { sessionId: sid, configId: "model", value: arg("--model") }).catch(() =>
    request("session/set_model", { sessionId: sid, modelId: arg("--model") }),
  );
if (arg("--model")) await setModel(sessionId);
console.log("stop:", (await turn(sessionId, prompt)).stopReason);

if (arg("--then")) {
  if (flag("--resume")) {
    process.kill(-proc.pid, "SIGTERM");
    record("restart", {});
    start();
    await init();
    await request("session/load", { sessionId, cwd, mcpServers: [] });
    const setModel = (sid) =>
      request("session/set_config_option", { sessionId: sid, configId: "model", value: arg("--model") }).catch(() =>
        request("session/set_model", { sessionId: sid, modelId: arg("--model") }),
      );
    if (arg("--model")) await setModel(sessionId);
  }
  console.log("stop:", (await turn(sessionId, arg("--then"))).stopReason);
}
process.kill(-proc.pid, "SIGTERM");
const out = new URL(`../../../fixtures/acp/${name}.jsonl`, import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} lines to ${out.pathname}`);
