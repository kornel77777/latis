import { describe, expect, it } from "vitest";
import { StatusDetector, stripAnsi } from "../../src/main/agents/adapters/terminal/detector";

describe("stripAnsi", () => {
  it("removes colours, cursor moves and OSC titles, and turns lone CRs into new lines", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07> \x1b[2K")).toBe("ok\n> ");
    expect(stripAnsi("50%\r100%")).toBe("50%\n100%");
  });
});

describe("StatusDetector", () => {
  it("is working while output flows and idle after 1.5 s of silence", () => {
    const d = new StatusDetector();
    expect(d.data("thinking…", 0)).toBe("working");
    expect(d.tick(1000)).toBeNull();
    expect(d.data("still going", 1200)).toBeNull();
    expect(d.tick(2600)).toBeNull();
    expect(d.tick(2800)).toBe("idle");
  });

  it("waits for the prompt regex before calling it idle when one is given", () => {
    const d = new StatusDetector({ promptRegex: /^>\s*$/ });
    d.data("working on it\n", 0);
    expect(d.tick(2000)).toBeNull();
    d.data("done\n> ", 2100);
    expect(d.tick(3700)).toBe("idle");
  });

  it("needs you when output looks like an approval prompt, and works again once answered", () => {
    const d = new StatusDetector();
    d.data("Run `npm install`?\nAllow this command? (y/n) ", 0);
    expect(d.state).toBe("needs-you");
    expect(d.tick(5000)).toBeNull();
    expect(d.lastLine()).toBe("Allow this command? (y/n)");
    expect(d.input(6000)).toBe("working");
  });

  it("ignores the terminal echoing the user's typing", () => {
    const d = new StatusDetector();
    d.input(0);
    expect(d.data("h", 10)).toBeNull();
    expect(d.state).toBe("idle");
    expect(d.data("a long burst of real agent output that arrives later", 500)).toBe("working");
  });
});
