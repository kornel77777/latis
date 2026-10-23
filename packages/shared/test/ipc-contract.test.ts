import { describe, expect, it } from "vitest";
import { eventContract, invokeContract } from "../src";

describe("IPC contract", () => {
  it("validates requests at the boundary", () => {
    expect(invokeContract["chat:send"].req.safeParse({ chatId: "c", text: "" }).success).toBe(false);
    expect(invokeContract["chat:send"].req.safeParse({ chatId: "c", text: "hi" }).success).toBe(true);
    expect(invokeContract["canvas:saveViewport"].req.safeParse({ canvasId: "m", viewport: { x: 0, y: 0, zoom: 9 } }).success).toBe(false);
    expect(invokeContract["settings:setTheme"].req.safeParse("sepia").success).toBe(false);
    expect(invokeContract["canvas:load"].req.safeParse(undefined).success).toBe(true);
  });

  it("rejects malformed event payloads", () => {
    expect(eventContract["chat:status"].safeParse({ chatId: "c", status: "sleeping" }).success).toBe(false);
    expect(eventContract["chat:events"].safeParse({ chatId: "c", events: [{ seq: 1 }] }).success).toBe(false);
  });
});
