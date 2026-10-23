import { z } from "zod";
import { AgentEvent } from "@latis/shared";

// JSON-lines protocol between FakeAdapter (parent) and fake-runner (child),
// shaped like the stdio protocols real agent CLIs speak.

export const ToRunner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), text: z.string(), script: z.string() }),
  z.object({ type: z.literal("respond"), requestId: z.string(), decision: z.enum(["allow", "deny"]) }),
  z.object({ type: z.literal("interrupt") }),
]);
export type ToRunner = z.infer<typeof ToRunner>;

export const FromRunner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: AgentEvent }),
  z.object({ type: z.literal("log"), message: z.string() }),
]);
export type FromRunner = z.infer<typeof FromRunner>;
