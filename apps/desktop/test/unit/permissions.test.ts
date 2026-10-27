import { describe, expect, it } from "vitest";
import type { Session } from "electron";
import { appUrlMatcher, lockDownPermissions } from "../../src/main/security/permissions";

type RequestHandler = (wc: unknown, permission: string, cb: (ok: boolean) => void, details: { requestingUrl: string }) => void;
type CheckHandler = (wc: unknown, permission: string, origin: string) => boolean;

function lock(devServer?: string) {
  let request: RequestHandler | null = null;
  let check: CheckHandler | null = null;
  const ses = {
    setPermissionRequestHandler: (h: RequestHandler) => (request = h),
    setPermissionCheckHandler: (h: CheckHandler) => (check = h),
  } as unknown as Session;
  lockDownPermissions(ses, appUrlMatcher(devServer));
  const ask = (permission: string, url: string) => {
    let granted: boolean | null = null;
    request!(null, permission, (ok) => (granted = ok), { requestingUrl: url });
    return granted;
  };
  return { ask, check: (permission: string, origin: string) => check!(null, permission, origin) };
}

describe("lockDownPermissions", () => {
  const app = "file:///Applications/Lattiz.app/Contents/Resources/app.asar/out/renderer/index.html";

  it("lets Lattiz's own page write to the clipboard and nothing else", () => {
    const { ask, check } = lock();
    expect(ask("clipboard-sanitized-write", app)).toBe(true);
    expect(check("clipboard-sanitized-write", "file:///")).toBe(true);
    for (const p of ["media", "geolocation", "notifications", "clipboard-read", "openExternal", "fullscreen"]) {
      expect(ask(p, app)).toBe(false);
      expect(check(p, "file:///")).toBe(false);
    }
  });

  it("gives cards and web pages nothing", () => {
    const { ask, check } = lock();
    expect(ask("clipboard-sanitized-write", "card://abc/index.html")).toBe(false);
    expect(ask("media", "card://abc/index.html")).toBe(false);
    expect(check("clipboard-sanitized-write", "https://example.com")).toBe(false);
  });

  it("treats the dev server as Lattiz while developing, but not look-alike hosts", () => {
    const { ask } = lock("http://localhost:5173");
    expect(ask("clipboard-sanitized-write", "http://localhost:5173/")).toBe(true);
    expect(ask("clipboard-sanitized-write", "http://localhost:51730/")).toBe(false);
    expect(lock().ask("clipboard-sanitized-write", "http://localhost:5173/")).toBe(false);
  });
});
