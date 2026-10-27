import type { UpdateState } from "@lattiz/shared";

// "A new version is out" (SPEC §17 M7, DECISIONS 2026-10-26): Lattiz asks GitHub Releases for the latest
// release and links to it. Nothing is downloaded or installed; that needs signed builds (auto-update, later).

export const RELEASES_FEED = "https://api.github.com/repos/kornel77777/lattiz/releases/latest";
const RELEASES_PAGE = "https://github.com/kornel77777/lattiz/releases/";

type Version = { parts: [number, number, number]; pre: string | null };

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** True when `latest` is a newer version than `current` (a release beats its own pre-releases). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! > b.parts[i]!;
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

export interface UpdateCheckerOptions {
  current: string;
  /** The releases API URL (LATTIZ_UPDATE_FEED in tests). */
  feed: string;
  /** Pages a release may link to; anything else isn't offered. */
  pagePrefix?: string;
  fetch?: typeof fetch;
  onChange?: (s: UpdateState) => void;
}

export class UpdateChecker {
  private s: UpdateState;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: UpdateCheckerOptions) {
    this.s = { current: opts.current, available: null, checkedAt: null, error: null };
  }

  state(): UpdateState {
    return this.s;
  }

  async check(): Promise<UpdateState> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.feed, {
        headers: { accept: "application/vnd.github+json", "user-agent": `Lattiz/${this.opts.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      // No releases yet (or a private repo) is a 404: nothing to offer, not an error.
      if (res.status === 404) return this.set({ available: null, error: null });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; name?: unknown; published_at?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      const url = typeof body.html_url === "string" ? body.html_url : "";
      const page = this.opts.pagePrefix ?? RELEASES_PAGE;
      const available =
        isNewer(tag, this.opts.current) && url.startsWith(page)
          ? {
              version: tag.replace(/^v/, ""),
              url,
              name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : tag,
              publishedAt: typeof body.published_at === "string" ? body.published_at : null,
            }
          : null;
      return this.set({ available, error: null });
    } catch (err) {
      return this.set({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Checks shortly after launch and then every `everyMs`, while `enabled()` says so. */
  start(enabled: () => boolean, firstMs = 10_000, everyMs = 6 * 3600_000): void {
    const tick = () => {
      if (enabled()) void this.check();
    };
    setTimeout(tick, firstMs);
    this.timer = setInterval(tick, everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.s = { ...this.s, ...patch, checkedAt: Date.now() };
    this.opts.onChange?.(this.s);
    return this.s;
  }
}
