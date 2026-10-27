import { ipcMain, type WebContents } from "electron";
import {
  eventContract,
  invokeContract,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRes,
  type IpcResult,
} from "@lattiz/shared";
import type { z } from "zod";

type Handlers = {
  [C in InvokeChannel]: (req: z.output<(typeof invokeContract)[C]["req"]>) => InvokeRes<C> | Promise<InvokeRes<C>>;
};

/** Registers every invoke channel; requests are validated on receipt and failures returned as data. */
export function registerHandlers(handlers: Handlers): void {
  for (const channel of Object.keys(invokeContract) as InvokeChannel[]) {
    const schema = invokeContract[channel];
    ipcMain.handle(channel, async (_e, raw: unknown): Promise<IpcResult<unknown>> => {
      const parsed = schema.req.safeParse(raw);
      if (!parsed.success) {
        console.warn(`[ipc] invalid ${channel} request dropped`, parsed.error.issues);
        return { ok: false, error: "invalid request" };
      }
      try {
        // Each handler is keyed to its own channel; TS can't correlate the union here.
        const handler = handlers[channel] as (req: unknown) => unknown;
        return { ok: true, value: await handler(parsed.data) };
      } catch (err) {
        console.error(`[ipc] ${channel} failed`, err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

export function emit<C extends EventChannel>(target: WebContents | undefined, channel: C, payload: EventPayload<C>): void {
  if (!target || target.isDestroyed()) return;
  const parsed = eventContract[channel].safeParse(payload);
  if (!parsed.success) {
    console.warn(`[ipc] invalid ${channel} event dropped`, parsed.error.issues);
    return;
  }
  target.send(channel, parsed.data);
}
