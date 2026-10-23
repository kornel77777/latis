import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { fixturesRoot, launch, stubFolderPicker, tempDataDir } from "./helpers";

// M2: Codex and Gemini (replayed), steering and the queue, the Inbox, terminals, terminal agents, onboarding.

const shots = process.env.LATIS_SCREENSHOTS;
const env = { LATIS_REPLAY: fixturesRoot };

/** Calls the preload API in the renderer (e2e has no DOM types, hence the globalThis cast). */
const ptySnapshot = (page: Page, id: string | null) =>
  page.evaluate(
    (ptyId) => (globalThis as unknown as { latis: LatisApi }).latis.invoke("pty:snapshot", { id: ptyId! }).then((r) => r.data),
    id,
  );
const ptyWrite = (page: Page, id: string | null, data: string) =>
  page.evaluate(([ptyId, d]) => (globalThis as unknown as { latis: LatisApi }).latis.invoke("pty:write", { id: ptyId!, data: d! }), [
    id,
    data,
  ] as const);

async function send(card: Locator, text: string) {
  await card.getByTestId("composer").fill(text);
  await card.getByTestId("send").click();
}

async function openRepo(page: Page, dataDir: string, app: Parameters<typeof stubFolderPicker>[0]) {
  const repo = join(dataDir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Recording sandbox\n");
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await expect(page.getByTestId("project-frame")).toContainText("repo");
  return repo;
}

async function newChat(page: Page, agent: RegExp): Promise<Locator> {
  const before = await page.getByTestId("chat-card").count();
  await page.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: agent }).click();
  await expect(page.getByTestId("chat-card")).toHaveCount(before + 1);
  return page.getByTestId("chat-card").nth(before);
}

test("Codex: diffs, approve from the Inbox (S3), and steering mid-turn (S2)", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir, env);
  await openRepo(page, dataDir, app);
  const card = await newChat(page, /^Codex/);
  await expect(card).toHaveAttribute("data-agent", "codex");

  // Auto-edit: Latis accepts the read and the in-folder patch itself; the edit shows as a diff.
  await send(card, "edit the heading /edit-file");
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  await expect(card.getByTestId("diff-stat").last()).toContainText("+2");
  await expect(card.getByTestId("permission")).toHaveCount(0);

  // S3: the command approval appears inline and in the Inbox; approve it from the Inbox.
  await send(card, "make hello.txt /write-and-run");
  await expect(card.getByTestId("permission").last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("inbox-count")).toHaveText("1");
  await page.getByRole("tab", { name: /Inbox/ }).click();
  const item = page.getByTestId("inbox-item").filter({ hasText: "Run a command" });
  await expect(item).toContainText("wc -l hello.txt");
  if (shots) await page.screenshot({ path: `${shots}/m2-inbox.png` });
  await item.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveAttribute("data-completed-turns", "2", { timeout: 15_000 });
  await expect(page.getByTestId("inbox-item").filter({ hasText: "Run a command" })).toHaveCount(0);

  // S2: while the turn runs, a correction is delivered at the next step without stopping it.
  await send(card, "fruits please /steer");
  await expect(card).toHaveAttribute("data-status", "working");
  await expect(card.getByTestId("assistant-message").last()).toContainText("fruits.txt", { timeout: 15_000 });
  await send(card, "Actually use vegetables instead of fruits, and name the file vegetables.txt.");
  await expect(card.getByTestId("steer-message")).toContainText("vegetables");
  await expect(card.getByTestId("permission-command").last()).toContainText("vegetables.txt", { timeout: 15_000 });
  await card.getByTestId("permission").last().getByTestId("allow-once").click();
  await expect(card).toHaveAttribute("data-completed-turns", "3", { timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/m2-steer.png` });

  // Ctrl+J pans to the Inbox's next item (the finished chat).
  await page.keyboard.press("Control+j");
  await app.close();
});

test("Gemini over ACP, and the queue for agents that can't steer", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir, env);
  await openRepo(page, dataDir, app);

  const gemini = await newChat(page, /^Gemini CLI/);
  await send(gemini, "write hello.txt");
  await expect(gemini).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  await expect(gemini.getByTestId("diff-stat").last()).toContainText("+1");

  // The demo agent can't steer: a message sent mid-turn waits as "Next step" and goes after the turn.
  await page.getByTestId("new-chat").click();
  await page.getByRole("menuitem", { name: /Demo agent/ }).click();
  const demo = page.locator("[data-testid='chat-card'][data-agent='fake']");
  await send(demo, "please /permission");
  await expect(demo.getByTestId("permission")).toBeVisible({ timeout: 15_000 });
  await send(demo, "and then this");
  await expect(demo.getByTestId("queue")).toContainText("and then this");
  await demo.getByTestId("permission").getByTestId("allow-once").click();
  await expect(demo).toHaveAttribute("data-completed-turns", "1", { timeout: 20_000 });
  // The queued message went out as the next turn on its own.
  await expect(demo.getByTestId("queue")).toHaveCount(0);
  await expect(demo.getByTestId("user-message").last()).toHaveText("and then this");
  await demo.getByTestId("permission").last().getByTestId("allow-once").click();
  await expect(demo).toHaveAttribute("data-completed-turns", "2", { timeout: 20_000 });
  await app.close();
});

test("terminal dock, open as terminal, and a terminal-only agent from a manifest", async () => {
  const dataDir = tempDataDir();
  mkdirSync(join(dataDir, "agents"), { recursive: true });
  const script = fileURLToPath(new URL("../../../fixtures/terminal/fake-agent.mjs", import.meta.url));
  writeFileSync(
    join(dataDir, "agents", "fake-term.json"),
    JSON.stringify({
      id: "terminal:fake",
      displayName: "Fake CLI",
      protocol: "terminal",
      command: process.execPath,
      args: [script],
      promptRegex: "^>\\s*$",
    }),
  );
  writeFileSync(join(dataDir, "agents", "broken.json"), "{ nope");
  const { app, page } = await launch(dataDir, env);
  await openRepo(page, dataDir, app);

  // Dock terminal in the project folder.
  await page.keyboard.press("Control+Backquote");
  await page.getByRole("button", { name: "Open a terminal" }).click();
  const term = page.getByTestId("terminal").first();
  await expect(term).toBeVisible();
  const ptyId = await term.getAttribute("data-pty");
  const snapshot = () => ptySnapshot(page, ptyId);
  await ptyWrite(page, ptyId, "echo latis-$((40+2))\r");
  await expect.poll(snapshot, { timeout: 10_000 }).toContain("latis-42");

  // A manifest agent runs as a terminal in its chat card; its approval prompt reaches the Inbox.
  const card = await newChat(page, /Fake CLI/);
  const inner = card.getByTestId("terminal");
  await expect(inner).toBeVisible();
  const agentPty = await inner.getAttribute("data-pty");
  const agentOut = () => ptySnapshot(page, agentPty);
  await expect.poll(agentOut, { timeout: 10_000 }).toContain("Fake agent ready.");
  await ptyWrite(page, agentPty, "go\r");
  await expect(card).toHaveAttribute("data-status", "needs-you", { timeout: 10_000 });
  await page.getByRole("tab", { name: /Inbox/ }).click();
  await expect(page.getByTestId("inbox-item").first()).toContainText("Allow this command? (y/n)");
  await ptyWrite(page, agentPty, "y\r");
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 10_000 });
  if (shots) await page.screenshot({ path: `${shots}/m2-terminals.png` });

  // A broken manifest is reported in Settings → Agents instead of breaking the list.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await expect(page.getByTestId("manifest-error")).toContainText("broken.json");
  await expect(page.locator("[data-testid='agent-card'][data-agent='terminal:fake']")).toContainText("runs in a terminal");
  await page.keyboard.press("Escape");

  // Open a structured chat as a terminal: it appears as a dock tab.
  const codex = await newChat(page, /^Codex/);
  await codex.getByRole("button", { name: "Chat menu" }).click();
  await page.getByRole("menuitem", { name: "Open as terminal" }).click();
  await expect(page.getByTestId("terminal-tab").filter({ hasText: "Codex ·" })).toBeVisible();
  await app.close();
});

test("first run: onboarding checks agents and starts chats in a sandbox project", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir, { ...env, LATIS_SKIP_ONBOARDING: "0" });
  const tour = page.getByTestId("onboarding");
  await expect(tour).toContainText("Welcome to Latis");
  await tour.getByTestId("onboarding-next").click();
  await expect(tour.locator("[data-agent='codex'] [data-testid='agent-state']")).toContainText("Signed in");
  await expect(tour.locator("[data-agent='claude-code'] [data-testid='agent-state']")).toContainText("Signed in");
  if (shots) await page.screenshot({ path: `${shots}/m2-onboarding.png` });
  await tour.getByTestId("onboarding-next").click();
  await tour.getByTestId("onboarding-sandbox").click();
  await expect(tour).toHaveCount(0);
  await expect(page.getByTestId("project-frame")).toContainText("sandbox-");
  const cards = page.getByTestId("chat-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByTestId("composer")).toHaveValue(/quick tour/);
  await app.close();

  // Finished once: not shown again.
  const again = await launch(dataDir, { ...env, LATIS_SKIP_ONBOARDING: "0" });
  await expect(again.page.getByTestId("chat-card")).toHaveCount(2);
  await expect(again.page.getByTestId("onboarding")).toHaveCount(0);
  await again.app.close();
});
