import type { AgentInfo } from "@lattiz/shared";
import { scrub } from "./logs";

// "Report a problem" (docs/privacy.md): the user gets this text on their clipboard and a new-issue page;
// they read it and decide what to paste. Lattiz sends nothing itself.

export const ISSUES_NEW = "https://github.com/kornel77777/lattiz/issues/new";

export interface DiagnosticsInput {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
  agents: AgentInfo[];
  logTail: string;
}

export function diagnostics(d: DiagnosticsInput): string {
  const agents = d.agents
    .filter((a) => a.installed && a.id !== "fake")
    .map((a) => `- ${a.displayName}${a.version ? ` ${a.version}` : ""}: ${a.kind}${a.signedIn ? ", ready" : ", not ready"}`);
  return scrub(
    [
      `Lattiz ${d.version} · ${d.platform} ${d.osRelease} (${d.arch}) · Electron ${d.electron}`,
      "",
      "Agents:",
      ...(agents.length ? agents : ["- none installed"]),
      "",
      "Recent warnings and errors (paths, tokens, keys and emails removed):",
      "```",
      d.logTail || "(none)",
      "```",
    ].join("\n"),
  );
}

/** The new-issue page with only the version and OS filled in; the diagnostics are pasted by the user. */
export function issueUrl(version: string, platform: string): string {
  const body = [
    "**What happened?**",
    "",
    "**What did you expect?**",
    "",
    "**Steps to reproduce**",
    "",
    `Lattiz ${version} on ${platform}`,
    "",
    "<!-- Lattiz copied diagnostics to your clipboard. Read them, then paste them below if you're happy to share them. -->",
    "",
  ].join("\n");
  return `${ISSUES_NEW}?${new URLSearchParams({ body }).toString()}`;
}
