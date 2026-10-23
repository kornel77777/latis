import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { eventChannels, invokeChannels, type IpcResult, type LatisApi } from "@latis/shared";

// Sandboxed preload: exposes exactly one object, `window.latis`, and only for
// channels in the IPC contract. Payload validation happens in main and renderer.

const invokeSet = new Set<string>(invokeChannels);
const eventSet = new Set<string>(eventChannels);

const api: LatisApi = {
  async invoke(channel, ...req) {
    if (!invokeSet.has(channel)) throw new Error(`unknown channel ${channel}`);
    const result = (await ipcRenderer.invoke(channel, req[0])) as IpcResult<never>;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  on(channel, listener) {
    if (!eventSet.has(channel)) throw new Error(`unknown channel ${channel}`);
    // Renderer-side store validates the payload against the contract before use.
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld("latis", api);
