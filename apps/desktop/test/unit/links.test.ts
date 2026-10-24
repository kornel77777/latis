import { describe, expect, it } from "vitest";
import { linkAction, openLink } from "../../src/main/security/links";

describe("external links (§13)", () => {
  it("opens web and mail links, asks for other apps, blocks code and files", () => {
    expect(linkAction("https://example.com/x")).toBe("open");
    expect(linkAction("mailto:a@b.c")).toBe("open");
    expect(linkAction("vscode://file/x")).toBe("confirm");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ms-msdt:/id", "not a url"])
      expect(linkAction(bad)).toBe("block");
  });

  it("only opens a confirm-scheme link when the user agrees", async () => {
    const opened: string[] = [];
    const deps = (yes: boolean) => ({ openExternal: async (u: string) => void opened.push(u), confirm: async () => yes });
    expect(await openLink("slack://open", deps(false))).toBe(false);
    expect(await openLink("slack://open", deps(true))).toBe(true);
    expect(await openLink("javascript:void 0", deps(true))).toBe(false);
    expect(opened).toEqual(["slack://open"]);
  });
});
