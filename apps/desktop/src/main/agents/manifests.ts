import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PermissionModeSchema } from "@latis/shared";

// Agent manifests (SPEC §6.4): JSON files in <dataDir>/agents/*.json add ACP or
// terminal agents without an app release. Built-ins use the same shape.

export const AgentManifest = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9:._-]*$/, "lowercase letters, digits and : . _ - only")
    .max(64),
  displayName: z.string().min(1).max(40),
  protocol: z.enum(["acp", "terminal"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  detect: z.object({ versionArgs: z.array(z.string()).default(["--version"]) }).default({ versionArgs: ["--version"] }),
  login: z.object({ args: z.array(z.string()) }).optional(),
  /** Terminal protocol: the agent is idle when its last output line matches this. */
  promptRegex: z.string().optional(),
  /** Terminal protocol: output that means the agent is waiting for an approval. */
  approvalRegex: z.string().optional(),
  /** ACP: Latis permission mode → the agent's own mode id. */
  modes: z.partialRecord(PermissionModeSchema, z.string()).optional(),
  hue: z.string().default("violet"),
  installHint: z.string().optional(),
});
export type AgentManifest = z.infer<typeof AgentManifest>;

export const BUILT_IN_MANIFESTS: AgentManifest[] = [
  {
    id: "gemini",
    displayName: "Gemini CLI",
    protocol: "acp",
    command: "gemini",
    args: ["--acp"],
    detect: { versionArgs: ["--version"] },
    login: { args: [] },
    hue: "sky",
    installHint: "npm install -g @google/gemini-cli",
  },
  // Terminal-only until a structured mode is verified for each (SPEC §6.3).
  {
    id: "terminal:copilot",
    displayName: "Copilot CLI",
    protocol: "terminal",
    command: "copilot",
    args: [],
    detect: { versionArgs: ["--version"] },
    hue: "slate-blue",
    installHint: "npm install -g @github/copilot",
  },
  {
    id: "terminal:opencode",
    displayName: "OpenCode",
    protocol: "terminal",
    command: "opencode",
    args: [],
    detect: { versionArgs: ["--version"] },
    hue: "amber-sand",
    installHint: "npm install -g opencode-ai",
  },
  {
    id: "terminal:grok",
    displayName: "Grok CLI",
    protocol: "terminal",
    command: "grok",
    args: [],
    detect: { versionArgs: ["--version"] },
    hue: "violet",
    installHint: "npm install -g @vibe-kit/grok-cli",
  },
  {
    id: "terminal:aider",
    displayName: "Aider",
    protocol: "terminal",
    command: "aider",
    args: [],
    detect: { versionArgs: ["--version"] },
    promptRegex: "^>\\s*$",
    hue: "sky",
    installHint: "python -m pip install aider-install && aider-install",
  },
];

export interface ManifestLoad {
  manifests: AgentManifest[];
  /** File name → why it was skipped, shown in Settings → Agents. */
  errors: Record<string, string>;
}

/** Reads user manifests. A user manifest with a built-in's id replaces the built-in. */
export function loadManifests(dir: string, reserved: string[]): ManifestLoad {
  const errors: Record<string, string> = {};
  const user: AgentManifest[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    // No agents folder yet.
  }
  for (const file of files) {
    try {
      const parsed = AgentManifest.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) {
        errors[file] = parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`).join("; ");
      } else if (reserved.includes(parsed.data.id)) {
        errors[file] = `"${parsed.data.id}" is a built-in agent id`;
      } else {
        user.push(parsed.data);
      }
    } catch (err) {
      errors[file] = err instanceof Error ? err.message : String(err);
    }
  }
  const ids = new Set(user.map((m) => m.id));
  return { manifests: [...BUILT_IN_MANIFESTS.filter((m) => !ids.has(m.id)), ...user], errors };
}
