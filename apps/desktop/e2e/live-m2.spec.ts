import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// M2 exit criteria against real agents (SPEC §17): S2 steering, S3 permission round-trip from the
// Inbox, and six chats across three agents running at once within the frame budget.
// Opt-in, spends real tokens on cheap models:
//   LATIS_LIVE=1 [LATIS_AGENT_PATH=<dir with codex>] [LATIS_LIVE_ACP="<acp agent command>"] pnpm e2e -- e2e/live-m2.spec.ts
// LATIS_LIVE_ACP adds a third agent through a manifest when Gemini isn't signed in.
test.skip(!process.env.LATIS_LIVE, "set LATIS_LIVE=1 to run against real agents");
test.setTimeout(420_000);

type Api = { latis: LatisApi };
const MODELS: Record<string, { model: string; reasoning?: string }> = {
  "claude-code": { model: "haiku" },
  codex: { model: "gpt-6-luna", reasoning: "low" },
  "acp:live": { model: "haiku" },
  gemini: { model: "default" },
};

async function setup() {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "live-repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# live repo\n\nA tiny project for Latis live tests.\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const acp = process.env.LATIS_LIVE_ACP;
  if (acp) {
    const [command, ...args] = acp.split(" ");
    mkdirSync(join(dataDir, "agents"));
    writeFileSync(
      join(dataDir, "agents", "live.json"),
      JSON.stringify({ id: "acp:live", displayName: "ACP agent", protocol: "acp", command, args, hue: "violet" }),
    );
  }
  const { app, page } = await launch(dataDir);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await expect(page.getByTestId("project-frame")).toContainText("live-repo");
  return { app, page, dataDir };
}

async function chatWith(page: Page, agentId: string, mode?: "full-auto"): Promise<Locator> {
  const before = await page.getByTestId("chat-card").count();
  // The title bar's New chat targets the only project and stays on screen however the canvas is panned.
  await page.getByTestId("new-chat").click();
  const name = (await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("agents:list", {}))).find(
    (a) => a.id === agentId,
  )!.displayName;
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByTestId("chat-card")).toHaveCount(before + 1);
  const card = page.getByTestId("chat-card").nth(before);
  const chatId = (await card.getAttribute("data-chat-id"))!;
  const opts = { chatId, ...MODELS[agentId], ...(mode && { permissionMode: mode }) };
  await page.evaluate((o) => (globalThis as unknown as Api).latis.invoke("chat:setOptions", o), opts);
  return card;
}

async function send(card: Locator, text: string) {
  await card.getByTestId("composer").fill(text);
  await card.getByTestId("send").click();
}

async function readyAgents(page: Page): Promise<string[]> {
  const list = await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("agents:list", {}));
  return list.filter((a) => a.kind === "structured" && a.id !== "fake" && a.installed && a.signedIn).map((a) => a.id);
}

async function close(app: ElectronApplication) {
  await app.close();
}

test("live S3: a real Codex approval answered from the Inbox", async () => {
  const { app, page } = await setup();
  test.skip(!(await readyAgents(page)).includes("codex"), "Codex isn't installed and signed in");
  const card = await chatWith(page, "codex");
  await send(card, "Run the shell command `node --version` and tell me what it printed. Nothing else.");
  await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 90_000 });
  await page.getByRole("tab", { name: /Inbox/ }).click();
  const item = page.getByTestId("inbox-item").filter({ hasText: "Run a command" });
  await expect(item).toContainText("node --version");
  await item.getByRole("button", { name: "Allow" }).click();
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 120_000 });
  await expect(card.getByTestId("assistant-message").last()).toContainText(/v\d+/);
  await close(app);
});

test("live S2: steer Claude Code mid-turn without stopping it", async () => {
  const { app, page } = await setup();
  test.skip(!(await readyAgents(page)).includes("claude-code"), "Claude Code isn't signed in");
  const card = await chatWith(page, "claude-code", "full-auto");
  await send(card, "Run the shell command `sleep 5 && echo first`, then run `echo second`, then reply with a one-line summary.");
  await expect(card.getByTestId("step").first()).toBeVisible({ timeout: 90_000 });
  await send(card, "Change of plan: instead of `echo second`, run `echo STEERED`.");
  await expect(card.getByTestId("steer-message")).toBeVisible();
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 120_000 });
  // One turn, and the agent followed the correction.
  await expect(card.getByTestId("transcript")).toContainText("STEERED");
  await close(app);
});

test("live: six chats across three agents stream at once within the frame budget", async () => {
  const { app, page } = await setup();
  const ready = (await readyAgents(page)).filter((id) => id in MODELS);
  test.skip(ready.length < 3, `needs three ready agents, have: ${ready.join(", ")}`);
  const agents = ready.slice(0, 3);
  const cards: Locator[] = [];
  for (const id of [...agents, ...agents]) cards.push(await chatWith(page, id));
  // Zoom out so all six cards render while they stream.
  await page.keyboard.press("Shift+1");

  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __frames: number[];
      __sampling: boolean;
      requestAnimationFrame: (cb: (t: number) => void) => number;
    };
    g.__frames = [];
    g.__sampling = true;
    let last = 0;
    const tick = (t: number) => {
      if (last) g.__frames.push(t - last);
      last = t;
      if (g.__sampling) g.requestAnimationFrame(tick);
    };
    g.requestAnimationFrame(tick);
  });
  const prompt = "Without using any tools, write three short paragraphs about why small commits are easier to review.";
  const ids = await Promise.all(cards.map((c) => c.getAttribute("data-chat-id")));
  // All six at once through the API (the composer path is covered elsewhere); main announces each turn.
  await page.evaluate(
    ([chatIds, text]) =>
      Promise.all(chatIds.map((chatId) => (globalThis as unknown as Api).latis.invoke("chat:send", { chatId: chatId!, text }))),
    [ids, prompt] as const,
  );
  for (const c of cards) await expect(c).toHaveAttribute("data-completed-turns", "1", { timeout: 240_000 });
  const frames = await page.evaluate(() => {
    const g = globalThis as unknown as { __frames: number[]; __sampling: boolean };
    g.__sampling = false;
    return g.__frames;
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  const over32 = frames.filter((f) => f > 32).length;
  const memKb = await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0));
  console.log(
    `[perf] agents=${agents.join(",")} frames=${frames.length} p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms >32ms=${over32} memory=${Math.round(memKb / 1024)}MB`,
  );
  expect(p95).toBeLessThan(32);
  expect(memKb / 1024).toBeLessThan(600 + 6 * 50);
  await close(app);
});
