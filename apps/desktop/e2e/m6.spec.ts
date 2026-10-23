/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { fixturesRoot, launch, stubFolderPicker, tempDataDir } from "./helpers";

// M6: send later, limit handling and handoff (S5), with the demo agent hitting its limit
// and the replayed Codex taking over in the same worktree.

type Api = { latis: LatisApi };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const env = { LATIS_REPLAY: fixturesRoot };

test("S5: a chat hits its limit, continues with Codex in the same worktree; send later survives a restart", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# shop\n");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "add", "-A");
  run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "readme");
  const { app, page } = await launch(dataDir, env);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.evaluate(async () => {
    const api = (globalThis as unknown as Api).latis;
    const canvas = await api.invoke("canvas:load");
    await api.invoke("chat:create", { canvasId: canvas.id, projectId: canvas.projects[0]!.id, agentId: "fake", x: 0, y: 0, isolate: true });
  });
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");

  const first = page.locator("[data-testid='chat-card'][data-agent='fake']");
  await first.getByTestId("composer").fill("Build the cart /limit");
  await first.getByTestId("composer").press("Enter");
  const banner = first.getByTestId("limit-banner");
  await expect(banner).toContainText("Usage limit reached", { timeout: 15_000 });

  // "Send when it resets" schedules a nudge for the reset time.
  await banner.getByRole("button", { name: "Send when it resets" }).click();
  await expect(first.getByTestId("scheduled")).toContainText("when the limit resets");
  await expect(banner).toHaveCount(0);

  // Continue with Codex: the brief has the goal, what was done, the changed files and the TODOs.
  await first.getByRole("button", { name: "Model" }).click();
  await page.getByRole("menuitem", { name: "Continue with another agent…" }).click();
  const brief = page.getByLabel("Handoff brief");
  await expect(brief).toHaveValue(/## Original goal\nBuild the cart \/limit/);
  await expect(brief).toHaveValue(/I added the cart total in src\/cart\.ts/);
  await expect(brief).toHaveValue(/created `src\/cart\.ts`/);
  await expect(brief).toHaveValue(/- \[ \] Apply discount codes\n- \[ \] Tests for the cart/);
  await brief.fill(`${await brief.inputValue()}\n\nUse two decimals for money.`);
  await page.getByTestId("handoff").getByLabel("Agent").selectOption("codex");
  await page.getByTestId("handoff-start").click();

  const second = page.locator("[data-testid='chat-card'][data-agent='codex']");
  await expect(second.getByTestId("continued-from")).toContainText("Continued from");
  // The brief went out as the new chat's first message (the replayed Codex then asks to run a command).
  await expect(second).toHaveAttribute("data-status", /working|needs-you/, { timeout: 20_000 });
  const state = await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  const [a, b] = [state.chats.find((c) => c.agentId === "fake")!, state.chats.find((c) => c.agentId === "codex")!];
  expect(b.continuedFrom).toBe(a.id);
  expect(b.cwd).toBe(a.cwd);
  expect(b.worktree?.id).toBe(a.worktree?.id);
  expect(b.projectId).toBe(a.projectId);
  const t = await page.evaluate(async (id) => (globalThis as unknown as Api).latis.invoke("chat:transcript", { chatId: id }), b.id);
  expect(t.turns[0]!.userText).toContain("Use two decimals for money.");

  // Send later from the composer: tomorrow 09:00, still there after a restart, then cancelled.
  await second.getByTestId("composer").fill("Run the tests again");
  await second.getByTestId("send-later").click();
  await page.getByText("Tomorrow at 09:00").click();
  await page.getByLabel("Repeat").selectOption({ label: "Every day" });
  await page.getByTestId("schedule-send").click();
  await expect(second.getByTestId("scheduled")).toContainText("tomorrow");
  await expect(second.getByTestId("scheduled")).toContainText("repeats every day");
  await expect(second.getByTestId("composer")).toHaveValue("");
  await app.close();

  const again = await launch(dataDir, env);
  const list = await again.page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("schedule:list"));
  expect(list.map((m) => [m.text, m.onReset, m.repeatMs])).toEqual([
    ["Run the tests again", false, 86_400_000],
    ["Continue where you left off.", true, null],
  ]);
  const codexCard = again.page.locator("[data-testid='chat-card'][data-agent='codex']");
  await codexCard.getByRole("button", { name: "Cancel scheduled message" }).click();
  await expect(codexCard.getByTestId("scheduled")).toHaveCount(0);
  await again.app.close();
});
