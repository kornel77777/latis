/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // "tomorrow 09:00", or "in N h" when that's under 12 hours away.
  await expect(second.getByTestId("scheduled")).toContainText(/tomorrow|in \d+ h/);
  const due = (await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("schedule:list"))).find(
    (m) => !m.onReset,
  )!.fireAt;
  expect([new Date(due).getHours(), new Date(due).getMinutes(), new Date(due).getDate()]).toEqual([
    9,
    0,
    new Date(Date.now() + 86_400_000).getDate(),
  ]);
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

test("cards: a starter card runs isolated (no network, no Latis access), keeps its data, and refreshes only after approval", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 400, y: 300 } });
  await page.getByTestId("menu-new-card").click();
  await page.getByTestId("card-library").getByText("Habit tracker").click();
  const card = page.getByTestId("card");
  await expect(card).toHaveCount(1);
  const frame = page.frameLocator("[data-testid='card-frame']");
  await expect(frame.getByText("Read 20 minutes")).toBeVisible();
  await page.waitForTimeout(500); // the canvas pans to the new card first
  await frame.getByPlaceholder("New habit").fill("Stretch");
  await frame.getByRole("button", { name: "Add" }).click();
  await expect(frame.getByText("Stretch")).toBeVisible();

  // Isolation (§12.1): opaque origin, no network, nothing of Latis reachable.
  const f = page.frames().find((x) => x.url().startsWith("card://"))!;
  const probe = await f.evaluate(async () => {
    const tryIt = async (fn: () => unknown) => {
      try {
        await fn();
        return "allowed";
      } catch {
        return "blocked";
      }
    };
    return {
      origin: self.origin, // the security origin; location.origin is the URL's
      fetch: await tryIt(() => fetch("https://example.com")),
      storage: await tryIt(() => localStorage.getItem("x")),
      parentDom: await tryIt(() => (parent as unknown as { document: Document }).document.title),
      latisApi: await tryIt(() => {
        if (!(parent as unknown as { latis?: unknown }).latis) throw new Error("absent");
      }),
    };
  });
  expect(probe).toEqual({ origin: "null", fetch: "blocked", storage: "blocked", parentDom: "blocked", latisApi: "blocked" });

  // Its data survives a restart.
  await app.close();
  const again = await launch(dataDir);
  await expect(again.page.frameLocator("[data-testid='card-frame']").getByText("Stretch")).toBeVisible({ timeout: 10_000 });

  // The repo dashboard's refresh script runs only after the user approves it, and its output lands in the card.
  await again.page.locator(".react-flow__pane").click({ button: "right", position: { x: 900, y: 600 } });
  await again.page.getByTestId("menu-new-card").click();
  await again.page.getByTestId("card-library").getByText("Repo dashboard").click();
  await again.page.waitForTimeout(500);
  const asked: string[] = [];
  await again.app.evaluate(({ dialog }) => {
    (globalThis as unknown as { asked: string[] }).asked = [];
    dialog.showMessageBox = (async (...a: unknown[]) => {
      const o = a.find((x) => x && typeof x === "object" && "message" in (x as object)) as { message: string };
      (globalThis as unknown as { asked: string[] }).asked.push(o.message);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  const repo = again.page.frameLocator("[data-card-id] iframe").nth(1);
  await repo.getByPlaceholder("owner/repo").fill("not a repo");
  await repo.getByRole("button", { name: "Refresh" }).click();
  await expect(repo.getByText("Type a repo as owner/name, then Refresh.")).toBeVisible({ timeout: 15_000 });
  asked.push(...(await again.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)));
  expect(asked).toEqual(['Let "Repo dashboard" run its refresh script?']);
  // Approved once: the same script doesn't ask again.
  await repo.getByRole("button", { name: "Refresh" }).click();
  await again.page.waitForTimeout(1500);
  expect(await again.app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked.length)).toBe(1);

  // Export as PDF renders the card (with its data) to A4.
  const pdf = join(dataDir, "repo.pdf");
  await again.app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as typeof dialog.showSaveDialog;
  }, pdf);
  await again.page.getByRole("button", { name: "Card menu" }).last().click();
  await again.page.getByRole("menuitem", { name: "Export as PDF…" }).click();
  await expect.poll(() => existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString(), { timeout: 15_000 }).toBe("%PDF-");
  await again.app.close();
});

test("S6: the Daily digest flow runs on a schedule; watchers feed the writer; the digest waits for approval, then lands in the note", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir, { LATIS_DEMO_IN_PROJECTS: "1", LATIS_FLOW_AGENT: "fake" });
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 300, y: 200 } });
  await page.getByTestId("menu-new-flow").click();
  await page.getByTestId("flow-templates").getByText("Daily digest").click();
  const frame = page.getByTestId("flow-frame");
  await expect(frame).toContainText("Daily digest");
  await expect(page.getByTestId("flow-schedule")).toHaveText("Daily at 08:00");
  const state = await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  const flow = state.flows[0]!;
  expect(new Date(flow.nextRunAt!).getHours()).toBe(8);
  expect(state.edges.map((e) => e.mode).sort()).toEqual(["approval", "every", "every", "wait_all", "wait_all"]);
  expect(state.chats.map((c) => c.title).sort()).toEqual(["Watcher 1", "Watcher 2", "Writer"]);

  // Run it now (the demo agent's /review script answers each message).
  await page.evaluate(
    async (id) =>
      (globalThis as unknown as Api).latis.invoke("flow:start", { flowId: id, input: "Check dependency updates for shop /review" }),
    flow.id,
  );
  await expect(page.getByTestId("flow-approvals")).toHaveText(/1 to approve/, { timeout: 30_000 });
  const t = await page.evaluate(async () => {
    const api = (globalThis as unknown as Api).latis;
    const c = await api.invoke("canvas:load");
    return api.invoke("chat:transcript", { chatId: c.chats.find((x) => x.title === "Writer")!.id });
  });
  // The writer got both watchers' output in one message, with the brief and its job.
  expect(t.turns).toHaveLength(1);
  expect(t.turns[0]!.userText).toContain("Your job: Write a short morning digest");
  expect(t.turns[0]!.userText).toMatch(/## From Watcher 1[\s\S]*## From Watcher 2/);

  await page.getByTestId("flow-approvals").click();
  const approvals = page.getByTestId("approvals");
  await approvals.getByLabel("Output to approve").fill("Digest: two packages have updates.");
  await approvals.getByTestId("approve-keep").click();
  await expect(page.getByTestId("flow-status")).toHaveText("Done", { timeout: 10_000 });
  const after = await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  const note = after.nodes.find((n) => n.type === "note")!;
  expect(String(note.data.text)).toMatch(/^# Digest\n\n### From Writer · .+\n\nDigest: two packages have updates\./);
  expect(after.flows[0]!.run!.log.map((l) => l.text)).toEqual(
    expect.arrayContaining(["Started.", "You kept Writer's output for Digest.", "Done."]),
  );

  // The schedule can change; the next run follows it.
  await page.getByTestId("flow-schedule").click();
  await page.getByTestId("schedule-form").getByLabel("Repeat").selectOption("hourly");
  await page.getByTestId("schedule-form").getByLabel("Time").fill("00:15");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("flow-schedule")).toHaveText("Hourly at :15");
  const sched = await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"));
  expect(new Date(sched.flows[0]!.nextRunAt!).getMinutes()).toBe(15);
  await app.close();
});
