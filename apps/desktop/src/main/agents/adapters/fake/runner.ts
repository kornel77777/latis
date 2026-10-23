// Child-process entry for the FakeAdapter. Started with ELECTRON_RUN_AS_NODE=1;
// reads ToRunner lines on stdin, writes FromRunner lines on stdout.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { FromRunner, ToRunner } from "./protocol";
import { parseScript, playScript } from "./script";

const cwd = process.cwd();
const waiters = new Map<string, (d: "allow" | "deny") => void>();
let interrupted = false;
let busy = false;
const queue: Extract<ToRunner, { type: "turn" }>[] = [];

function send(msg: FromRunner): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function runTurn(turn: Extract<ToRunner, { type: "turn" }>): Promise<void> {
  busy = true;
  interrupted = false;
  const started = Date.now();
  try {
    const steps = parseScript(turn.script);
    for await (const event of playScript(steps, {
      userText: turn.text,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      async writeFile(rel, content) {
        const abs = resolve(cwd, rel);
        if (!abs.startsWith(cwd + sep)) throw new Error(`refusing to write outside cwd: ${rel}`);
        const existed = existsSync(abs);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        return existed ? "modified" : "created";
      },
      waitForResponse: (id) => new Promise((r) => waiters.set(id, r)),
      exit: (code) => process.exit(code),
      isInterrupted: () => interrupted,
    })) {
      send({ type: "event", event });
    }
    if (interrupted) send({ type: "event", event: { type: "turn.completed", status: "interrupted", durationMs: Date.now() - started } });
  } catch (err) {
    send({ type: "event", event: { type: "error", message: String(err), recoverable: true } });
    send({ type: "event", event: { type: "turn.completed", status: "error", durationMs: Date.now() - started } });
  } finally {
    busy = false;
    const next = queue.shift();
    if (next) void runTurn(next);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg: ToRunner;
  try {
    msg = ToRunner.parse(JSON.parse(line));
  } catch (err) {
    send({ type: "log", message: `bad input: ${String(err)}` });
    return;
  }
  if (msg.type === "turn") {
    if (busy) queue.push(msg);
    else void runTurn(msg);
  } else if (msg.type === "respond") {
    waiters.get(msg.requestId)?.(msg.decision);
    waiters.delete(msg.requestId);
  } else {
    interrupted = true;
    for (const [id, w] of waiters) {
      w("deny");
      waiters.delete(id);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
