// Records a real `codex app-server` JSON-RPC exchange into fixtures/codex/<name>.jsonl (SPEC §0.2, §16).
// Usage: node scripts/record-codex-stream.mjs <name> "<prompt>" [--deny] [--model gpt-6-luna] [--mode auto-edit]
//          [--deny-matching "<regex>"] [--then "<second prompt>"] [--steer "<text>"] [--interrupt] [--resume] [--codex /path/to/codex]
// Uses whatever account Codex is signed in with. Paths, ids and identities are scrubbed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [name, prompt, ...rest] = process.argv.slice(2);
if (!name || !prompt) throw new Error("usage: record-codex-stream.mjs <name> <prompt> [flags]");
const flag = (f) => rest.includes(f);
const arg = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
const codex = arg("--codex") ?? process.env.LATTIZ_CODEX ?? "codex";
const cwd = mkdtempSync(join(process.env.LATTIZ_TEST_TMP ?? tmpdir(), "lattiz-rec-"));
writeFileSync(join(cwd, "README.md"), "# Recording sandbox\n");

// Same mapping as the adapter (docs/adapters/codex.md).
const MODES = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-auto": { approvalPolicy: "never", sandbox: "danger-full-access" },
  // Full-auto with an always-ask list: Codex asks about every command and Lattiz answers.
  "full-auto-guarded": { approvalPolicy: "untrusted", sandbox: "danger-full-access" },
};
const mode = MODES[arg("--mode") ?? "auto-edit"];

const lines = [];
const ids = new Map(); // real thread/turn/item ids -> stable placeholders, so fixtures diff cleanly
const scrubIds = (s) =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
    return ids.get(id);
  });
const scrub = (s) =>
  scrubIds(s.replaceAll(cwd, "<cwd>").replaceAll(homedir(), "<home>")).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "user@example.com");
const record = (dir, msg) => lines.push(scrub(JSON.stringify({ dir, msg })));

let proc, nextId, pending, onServer;
function start() {
  proc = spawn(codex, ["app-server"], { cwd, stdio: ["pipe", "pipe", "inherit"], detached: true });
  nextId = 0;
  pending = new Map();
  createInterface({ input: proc.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    record("in", m);
    if (m.id !== undefined && !m.method) pending.get(m.id)?.(m);
    else onServer?.(m);
  });
}
const send = (m) => {
  record("out", m);
  proc.stdin.write(JSON.stringify(m) + "\n");
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    send({ id, method, params });
  });

async function handshake() {
  await request("initialize", { clientInfo: { name: "lattiz", title: "Lattiz", version: "0.0.0" }, capabilities: null });
  send({ method: "initialized" });
}

async function turn(threadId, text, { steer, interrupt } = {}) {
  let turnId = null;
  let steered = false;
  const done = new Promise((resolve) => {
    onServer = (m) => {
      if (m.method === "turn/started") turnId = m.params.turn.id;
      if (m.id !== undefined && m.method) {
        // A server request (approval or question): answer like a user would.
        const denyMatching = arg("--deny-matching");
        const command = String(m.params?.command ?? "");
        const decision = flag("--deny") || (denyMatching && new RegExp(denyMatching).test(command)) ? "decline" : "accept";
        if (m.method === "item/tool/requestUserInput") {
          const answers = Object.fromEntries(m.params.questions.map((q) => [q.id, { answers: [q.options?.[0]?.label ?? "yes"] }]));
          send({ id: m.id, result: { answers } });
        } else send({ id: m.id, result: { decision } });
      }
      if (m.method === "item/started" && turnId && !steered && (steer || interrupt)) {
        steered = true;
        setTimeout(() => {
          if (steer)
            void request("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input: [{ type: "text", text: steer, text_elements: [] }],
            }).catch((e) => console.warn("steer failed", e.message));
          if (interrupt) void request("turn/interrupt", { threadId, turnId });
        }, 1500);
      }
      if (m.method === "turn/completed") resolve();
    };
  });
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    model: arg("--model") ?? "gpt-6-luna",
    effort: "low",
  });
  await done;
}

start();
await handshake();
const account = await request("account/read", { refreshToken: false });
await request("model/list", {});
console.log("account:", account.account?.type, account.account?.planType);
const { thread } = await request("thread/start", { cwd, ...mode });
await turn(thread.id, prompt, { steer: arg("--steer"), interrupt: flag("--interrupt") });

if (arg("--then")) {
  if (flag("--resume")) {
    // Restart the server and resume the thread, as Lattiz does after an app restart.
    process.kill(-proc.pid, "SIGTERM");
    record("restart", {});
    start();
    await handshake();
    await request("thread/resume", { threadId: thread.id, cwd, ...mode, excludeTurns: true });
  }
  await turn(thread.id, arg("--then"));
}
process.kill(-proc.pid, "SIGTERM");
const out = new URL(`../../../fixtures/codex/${name}.jsonl`, import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} lines to ${out.pathname}`);
