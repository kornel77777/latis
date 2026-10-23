/// <reference lib="dom" />

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, tempDataDir } from "./helpers";

// M5: orchestration. The demo agent plays the Conductor; its script calls the real Workspace MCP
// server through the `latis-mcp` stdio shim, and the chats it starts are demo chats too.

type Api = { latis: LatisApi };
const conductorEnv = { LATIS_SKIP_CONDUCTOR: "0", LATIS_CONDUCTOR_AGENT: "fake", LATIS_DEMO_IN_PROJECTS: "1" };

test("S4: the Conductor spawns three reviewers, waits, reads and writes a summary note", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# shop\n");
  writeFileSync(join(repo, "src", "auth", "login.ts"), "export const login = () => true;\n");
  const { app, page } = await launch(dataDir, conductorEnv);

  const conductor = page.locator("[data-testid='chat-card']", { has: page.getByTestId("conductor-badge") });
  await expect(conductor).toBeVisible({ timeout: 15_000 });
  await expect(conductor.getByTestId("conductor-intro")).toBeVisible();
  await conductor.getByTestId("composer").fill(`/conduct ${repo}`);
  await conductor.getByTestId("composer").press("Enter");

  // Three chats appear in a new project frame for the folder, each titled by the Conductor.
  // Off-screen cards aren't rendered, so this reads the canvas data rather than the DOM.
  const load = () => page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  await expect
    .poll(async () => (await load()).chats.flatMap((c) => (c.spawnedBy ? [c.title] : [])).sort(), { timeout: 20_000 })
    .toEqual(["Auth: readability", "Auth: security", "Auth: tests"]);
  expect((await load()).nodes.filter((n) => n.type === "frame")).toHaveLength(1);

  // The Conductor waited for all three, then wrote the note and finished.
  await expect.poll(async () => (await load()).chats.find((c) => c.role === "conductor")?.status, { timeout: 30_000 }).toBe("done");
  const state = await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  const reviewers = state.chats.filter((c) => c.spawnedBy);
  expect(reviewers).toHaveLength(3);
  expect(reviewers.every((c) => c.status === "done" && c.cwd === repo)).toBe(true);
  const note = state.nodes.find((n) => n.type === "note");
  expect(String(note?.data.text)).toContain("# Auth review: where they agree");
  expect(String(note?.data.text)).toContain("timed out: false");

  // Each tool call shows as a step in the Conductor's own transcript (§10.1 guardrails).
  const transcript = await page.evaluate(
    async (id) => (globalThis as unknown as Api).latis.invoke("chat:transcript", { chatId: id }),
    state.chats.find((c) => c.role === "conductor")!.id,
  );
  const tools = transcript.events.flatMap((e) => (e.event.type === "tool.started" ? [e.event.name] : []));
  expect(tools).toEqual([
    "latis.spawn_chat",
    "latis.spawn_chat",
    "latis.spawn_chat",
    "latis.wait_for_chats",
    "latis.read_chat",
    "latis.create_note",
  ]);
  // The demo agent streams its reply without a final message event.
  const said = transcript.events.map((e) => (e.event.type === "message.delta" ? e.event.text : "")).join("");
  expect(said).toContain("The summary is in the note");
  const failed = transcript.events.filter((e) => e.event.type === "tool.completed" && e.event.status !== "ok");
  expect(failed).toHaveLength(0);

  // The Conductor is pinned: deleting it does nothing, and there's still exactly one after a restart.
  const deleted = await page.evaluate(
    async (nodeId) => (globalThis as unknown as Api).latis.invoke("canvas:delete", { nodeIds: [nodeId] }),
    state.chats.find((c) => c.role === "conductor")!.nodeId,
  );
  expect(deleted.deleted).toEqual([]);
  await expect(conductor).toBeVisible();
  await app.close();

  const again = await launch(dataDir, conductorEnv);
  await expect(again.page.getByTestId("conductor-badge")).toHaveCount(1, { timeout: 15_000 });
  const after = await again.page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  expect(after.chats.filter((c) => c.role === "conductor")).toHaveLength(1);
  await again.app.close();
});

test("skills: /name suggests and sends the skill; connections: add one and attach it to a chat", async () => {
  const dataDir = tempDataDir();
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  writeFileSync(join(dataDir, "skills", "conventions.md"), "---\ndescription: House style\n---\nUse tabs. Name things plainly.\n");
  const { app, page } = await launch(dataDir);
  await page.getByTestId("empty-demo").click();
  const card = page.getByTestId("chat-card").first();
  const composer = card.getByTestId("composer");
  await composer.fill("/conv");
  await expect(card.getByTestId("skill-suggestions")).toContainText("House style");
  await composer.press("Tab");
  await expect(composer).toHaveValue("/conventions ");
  await composer.pressSequentially("tidy the code /review");
  await composer.press("Enter");
  // The transcript shows what was typed; the agent got the skill's text (the demo echoes it).
  await expect(card.getByTestId("transcript")).toContainText("/conventions tidy the code /review");
  await expect(card.getByTestId("transcript")).toContainText("Use tabs. Name things plainly.", { timeout: 15_000 });

  // A connection that isn't shared can be attached per chat from the ⋯ menu.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await page.getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "Add connection" }).click();
  const form = page.getByTestId("connection-form");
  await form.getByLabel("Name").fill("files");
  await form.getByLabel("Command").fill("npx");
  await form.getByLabel("Arguments").fill("-y\n@modelcontextprotocol/server-filesystem");
  await form.getByText("Share with every chat").click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("connection")).toContainText("npx -y @modelcontextprotocol/server-filesystem");
  await page.keyboard.press("Escape");

  await expect(card).toHaveAttribute("data-status", "done");
  await card.getByRole("button", { name: "Chat menu" }).click();
  await page.getByRole("menuitem", { name: "files" }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"))).chats[0]!.connections.length,
    )
    .toBe(1);
  await app.close();
});
