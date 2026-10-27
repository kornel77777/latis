import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LattizApi } from "@lattiz/shared";
import { launch, tempDataDir } from "./helpers";

// M5 exit criterion against real agents: scenario S4 (SPEC §3) with Claude Code as the Conductor.
// Opt-in, spends real usage (a Conductor turn plus three short reviews):
//   LATTIZ_LIVE=1 pnpm e2e -- e2e/live-m5.spec.ts
test.skip(!process.env.LATTIZ_LIVE, "set LATTIZ_LIVE=1 to run against real agents");
test.setTimeout(1_200_000);

type Api = { lattiz: LattizApi };

test("live S4: Claude Code conducts three reviewers of the auth module and writes where they agree", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# shop\n\nA tiny shop. Auth lives in src/auth.\n");
  writeFileSync(
    join(repo, "src", "auth", "login.ts"),
    `import { users } from "./users";

// Logs a user in and returns a session token.
export function login(email: string, password: string): string | null {
  const user = users.find((u) => u.email == email);
  if (!user) return null;
  if (user.password !== password) return null; // passwords are stored as plain text
  return Buffer.from(email + ":" + Date.now()).toString("base64");
}
`,
  );
  writeFileSync(
    join(repo, "src", "auth", "users.ts"),
    `export const users = [
  { email: "admin@shop.test", password: "admin123", role: "admin" },
  { email: "ann@shop.test", password: "hunter2", role: "customer" },
];
`,
  );
  writeFileSync(
    join(repo, "src", "auth", "session.ts"),
    `export function isValid(token: string): boolean {
  const [email, ts] = Buffer.from(token, "base64").toString().split(":");
  return Boolean(email) && Date.now() - Number(ts) < 1000 * 60 * 60 * 24 * 365;
}
`,
  );

  const { app, page } = await launch(dataDir, { LATTIZ_SKIP_CONDUCTOR: "0" });
  const agents = await page.evaluate(() => (globalThis as unknown as Api).lattiz.invoke("agents:list", {}));
  const ready = agents.filter((a) => a.installed && a.signedIn && a.kind === "structured" && a.id !== "fake").map((a) => a.id);
  test.skip(!ready.includes("claude-code"), "needs Claude Code signed in");

  const conductor = page.locator("[data-testid='chat-card']", { has: page.getByTestId("conductor-badge") });
  await expect(conductor).toBeVisible({ timeout: 30_000 });
  await expect(conductor).toHaveAttribute("data-agent", "claude-code");

  const pick = ["claude-code", "codex", "gemini"].filter((a) => ready.includes(a));
  const who = pick.length >= 3 ? "one Claude Code, one Codex and one Gemini chat" : `three chats using ${pick.join(" and ")}`;
  const prompt =
    `Have three agents each review the auth module in ${repo} (src/auth) from different angles and summarise where they agree. ` +
    `Use ${who}. Keep each review short (under 200 words) and tell them not to change any files.`;
  await conductor.getByTestId("composer").fill(prompt);
  await conductor.getByTestId("composer").press("Enter");

  await expect(conductor).toHaveAttribute("data-status", /done|error/, { timeout: 1_100_000 });
  const state = await page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("canvas:load"));
  const c = state.chats.find((x) => x.role === "conductor")!;
  const reviewers = state.chats.filter((x) => x.spawnedBy === c.id);
  const note = state.nodes.find((n) => n.type === "note");
  const transcript = await page.evaluate(
    async (id) => (globalThis as unknown as Api).lattiz.invoke("chat:transcript", { chatId: id }),
    c.id,
  );
  const tools = transcript.events.flatMap((e) => (e.event.type === "tool.started" ? [e.event.name] : []));
  const durationMs = transcript.events.flatMap((e) => (e.event.type === "turn.completed" ? [e.event.durationMs] : []));

  console.log(
    JSON.stringify(
      {
        conductorStatus: c.status,
        reviewers: reviewers.map((r) => ({ agent: r.agentId, title: r.title, status: r.status, mode: r.permissionMode })),
        tools,
        durationMs,
        note: note?.data.text,
      },
      null,
      2,
    ),
  );

  expect(c.status).toBe("done");
  expect(reviewers).toHaveLength(3);
  expect(reviewers.every((r) => r.status === "done" && r.cwd === repo)).toBe(true);
  expect(tools.filter((t) => t.endsWith("spawn_chat"))).toHaveLength(3);
  expect(tools.some((t) => t.endsWith("wait_for_chats"))).toBe(true);
  expect(tools.some((t) => t.endsWith("create_note"))).toBe(true);
  expect(String(note?.data.text ?? "").length).toBeGreaterThan(100);
  await page.screenshot({ path: join(dataDir, "live-m5.png") });
  console.log(`screenshot: ${join(dataDir, "live-m5.png")}`);
  await app.close();
});

test("live: Codex (HTTP) and Gemini (stdio shim) use the workspace tools after Give workspace tools", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "notes");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# notes\n");
  const { app, page } = await launch(dataDir);
  app.process().stdout?.on("data", (d: Buffer) => process.env.LATTIZ_DEBUG && console.log("[main]", d.toString().trim().slice(0, 400)));
  app.process().stderr?.on("data", (d: Buffer) => process.env.LATTIZ_DEBUG && console.log("[main!]", d.toString().trim().slice(0, 400)));
  const agents = await page.evaluate(() => (globalThis as unknown as Api).lattiz.invoke("agents:list", {}));
  const ready = agents.filter((a) => a.installed && a.signedIn).map((a) => a.id);
  // LATTIZ_LIVE_ONLY=codex limits the run (Gemini's free tier runs out of daily requests quickly).
  const only = process.env.LATTIZ_LIVE_ONLY?.split(",");
  const which = ["codex", "gemini"].filter((a) => ready.includes(a) && (!only || only.includes(a)));
  test.skip(!which.length, "needs Codex or Gemini signed in");

  const { stubFolderPicker } = await import("./helpers");
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  const results: Record<string, unknown> = {};
  for (const agentId of which) {
    const chatId = await page.evaluate(
      async (o) => {
        const api = (globalThis as unknown as Api).lattiz;
        const canvas = await api.invoke("canvas:load");
        const { chat } = await api.invoke("chat:create", {
          canvasId: canvas.id,
          projectId: canvas.projects[0]!.id,
          agentId: o.agentId,
          x: 0,
          y: 0,
        });
        await api.invoke("chat:setWorkspaceTools", { chatId: chat.id, on: true });
        await api.invoke("chat:send", {
          chatId: chat.id,
          text: "Call the lattiz list_projects tool, then create_note with title 'Hello from you' and the project's folder as the markdown. Reply with the note id only.",
        });
        return chat.id;
      },
      { agentId },
    );
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const st = (await page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("canvas:load"))).chats.find(
        (c) => c.id === chatId,
      )?.status;
      if (st && /done|error|needs-you/.test(st)) break;
      await page.waitForTimeout(2000);
    }
    const t = await page.evaluate(async (id) => (globalThis as unknown as Api).lattiz.invoke("chat:transcript", { chatId: id }), chatId);
    results[agentId] = {
      tools: t.events.flatMap((e) => (e.event.type === "tool.started" ? [e.event.name] : [])),
      failed: t.events
        .filter((e) => e.event.type === "tool.completed" && e.event.status !== "ok")
        .map((e) => JSON.stringify(e.event).slice(0, 300)),
      events: t.events.map((e) => JSON.stringify(e.event).slice(0, 200)),
      permissions: t.events.filter((e) => e.event.type === "permission.requested").map((e) => JSON.stringify(e.event).slice(0, 300)),
    };
  }
  const notes = (await page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("canvas:load"))).nodes.filter(
    (n) => n.type === "note",
  );
  console.log(JSON.stringify({ results, notes: notes.map((n) => n.data.text) }, null, 2));
  expect(notes).toHaveLength(which.length);
  await app.close();
});
