import { describe, expect, it } from "vitest";
import { cardCsp, parseOrigins } from "../../src/main/cards/cards";

describe("card network allowlist (§12.1)", () => {
  it("accepts exact https origins (and http only for localhost)", () => {
    expect(parseOrigins(["https://api.example.com", "http://localhost:3000"])).toEqual([
      "https://api.example.com",
      "http://localhost:3000",
    ]);
  });

  it("refuses paths, plain http, wildcards and junk", () => {
    expect(() => parseOrigins(["https://api.example.com/v1"])).toThrow(/bare origin/);
    expect(() => parseOrigins(["http://example.com"])).toThrow(/https/);
    expect(() => parseOrigins(["https://*.example.com"])).toThrow();
    expect(() => parseOrigins("https://example.com")).toThrow(/list/);
  });

  it("puts only the granted origins in connect-src; none by default", () => {
    expect(cardCsp([])).toContain("connect-src 'none'");
    expect(cardCsp(["https://a.example"])).toContain("connect-src https://a.example;");
    expect(cardCsp([])).toContain("default-src 'self' card:");
  });
});
