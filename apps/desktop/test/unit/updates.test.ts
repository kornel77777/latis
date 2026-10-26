import { describe, expect, it, vi } from "vitest";
import { isNewer, parseVersion, UpdateChecker } from "../../src/main/updates";

describe("isNewer", () => {
  it.each([
    ["0.2.0", "0.1.0", true],
    ["v0.1.1", "0.1.0", true],
    ["1.0.0", "0.9.9", true],
    ["0.1.0", "0.1.0", false],
    ["0.1.0", "0.2.0", false],
    ["0.10.0", "0.9.0", true],
    ["0.2.0", "0.2.0-beta.1", true],
    ["0.2.0-beta.2", "0.2.0-beta.1", true],
    ["0.2.0-beta.10", "0.2.0-beta.9", true],
    ["0.2.0-beta.1", "0.2.0", false],
    ["latest", "0.1.0", false],
  ])("%s over %s → %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });

  it("parses tags with a v and build metadata", () => {
    expect(parseVersion("v1.2.3+abc")).toEqual({ parts: [1, 2, 3], pre: null });
    expect(parseVersion("nope")).toBeNull();
  });
});

const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("UpdateChecker", () => {
  const page = "https://github.com/kornel77777/latis/releases/tag/v0.2.0";

  it("offers a newer release and tells listeners", async () => {
    const onChange = vi.fn();
    const c = new UpdateChecker({
      current: "0.1.0",
      feed: "https://example.test/latest",
      fetch: reply(200, { tag_name: "v0.2.0", html_url: page, name: "Latis 0.2", published_at: "2026-11-01T00:00:00Z" }),
      onChange,
    });
    const s = await c.check();
    expect(s.available).toEqual({ version: "0.2.0", url: page, name: "Latis 0.2", publishedAt: "2026-11-01T00:00:00Z" });
    expect(s.error).toBeNull();
    expect(onChange).toHaveBeenCalledWith(s);
  });

  it("offers nothing for the same version, a 404 (no releases) or a link off GitHub", async () => {
    const same = await new UpdateChecker({
      current: "0.2.0",
      feed: "x",
      fetch: reply(200, { tag_name: "v0.2.0", html_url: page }),
    }).check();
    expect(same.available).toBeNull();
    const none = await new UpdateChecker({ current: "0.1.0", feed: "x", fetch: reply(404) }).check();
    expect(none).toMatchObject({ available: null, error: null });
    const elsewhere = await new UpdateChecker({
      current: "0.1.0",
      feed: "x",
      fetch: reply(200, { tag_name: "v0.2.0", html_url: "https://evil.example/latis.dmg" }),
    }).check();
    expect(elsewhere.available).toBeNull();
  });

  it("reports failures without throwing", async () => {
    const s = await new UpdateChecker({ current: "0.1.0", feed: "x", fetch: reply(500) }).check();
    expect(s.error).toBe("GitHub answered 500");
    const offline = await new UpdateChecker({
      current: "0.1.0",
      feed: "x",
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }).check();
    expect(offline.error).toBe("offline");
  });
});
