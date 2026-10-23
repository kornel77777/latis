import type { LineTransport } from "./transport";

// Minimal JSON-RPC peer over a line transport. Codex's app-server omits the
// "jsonrpc" field; ACP requires it (docs/adapters/codex.md, docs/adapters/acp.md).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Incoming params are untyped JSON; adapters narrow them with their own types. */
export type Params = Record<string, unknown>;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Frame {
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RequestHandler = (method: string, params: Params, id: number | string) => Promise<unknown>;
export type NotificationHandler = (method: string, params: Params) => void;

export class JsonRpcPeer {
  private nextId = 0;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private unsub: () => void;
  private closed = false;

  constructor(
    private readonly transport: LineTransport,
    private readonly handlers: { request: RequestHandler; notification: NotificationHandler },
    private readonly opts: { jsonrpc: boolean },
  ) {
    this.unsub = transport.onLine((line) => this.receive(line));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`connection closed (${method})`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write({ id, method, ...(params !== undefined && { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined && { params }) });
  }

  /** Rejects everything still waiting; later responses are ignored. */
  close(reason = "connection closed"): void {
    this.closed = true;
    this.unsub();
    for (const p of this.pending.values()) p.reject(new Error(`${reason} (${p.method})`));
    this.pending.clear();
  }

  private write(frame: object): void {
    this.transport.send(JSON.stringify(this.opts.jsonrpc ? { jsonrpc: "2.0", ...frame } : frame));
  }

  private receive(line: string): void {
    let m: Frame;
    try {
      m = JSON.parse(line) as Frame;
    } catch {
      return; // agents sometimes log to stdout; protocol frames are JSON only
    }
    if (typeof m !== "object" || m === null) return;
    if (m.method !== undefined && m.id !== undefined) {
      const id = m.id;
      this.handlers
        .request(m.method, m.params ?? {}, id)
        .then((result) => this.write({ id, result: result ?? null }))
        .catch((err: unknown) => {
          const e = err instanceof RpcError ? err : new RpcError(err instanceof Error ? err.message : String(err), -32603);
          this.write({ id, error: { code: e.code, message: e.message } });
        });
    } else if (m.method !== undefined) {
      this.handlers.notification(m.method, m.params ?? {});
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new RpcError(m.error.message, m.error.code, m.error.data));
      else p.resolve(m.result);
    }
  }
}
