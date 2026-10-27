import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Skill } from "@lattiz/shared";

// Skills (SPEC §9.14): reusable instructions as markdown. `<dataDir>/skills/*.md` for the user,
// `<project>/.lattiz/skills/*.md` for a project; `<name>/SKILL.md` folders work in both places.
// Typing /name in the composer sends the skill's text to the agent with the message.

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function projectSkillsDir(folder: string): string {
  return join(folder, ".lattiz", "skills");
}

function parse(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function describe(meta: Record<string, string>, body: string): string {
  if (meta.description) return meta.description;
  const line = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  return (line ?? "").trim().slice(0, 140);
}

function scan(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    let path: string | null = null;
    let name = "";
    if (e.isFile() && e.name.endsWith(".md")) {
      path = join(dir, e.name);
      name = e.name.slice(0, -3);
    } else if (e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md"))) {
      path = join(dir, e.name, "SKILL.md");
      name = e.name;
    }
    if (!path) continue;
    try {
      const { meta, body } = parse(readFileSync(path, "utf8"));
      const skillName = (meta.name && NAME.test(meta.name) ? meta.name : name).toLowerCase();
      if (NAME.test(skillName)) out.push({ name: skillName, description: describe(meta, body), source, path });
    } catch (err) {
      console.warn(`[skills] couldn't read ${path}`, err);
    }
  }
  return out;
}

export class Skills {
  constructor(readonly userDir: string) {}

  /** A project's skills win over the user's skills of the same name. */
  list(projectFolder: string | null): Skill[] {
    const project = projectFolder ? scan(projectSkillsDir(projectFolder), "project") : [];
    const names = new Set(project.map((s) => s.name));
    return [...project, ...scan(this.userDir, "user").filter((s) => !names.has(s.name))].sort((a, b) => a.name.localeCompare(b.name));
  }

  body(path: string): string {
    return parse(readFileSync(path, "utf8")).body;
  }

  /** Replaces /name tokens of known skills with the skills' text, which goes ahead of the message. */
  expand(text: string, projectFolder: string | null): string {
    const tokens = [...text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/gi)].map((m) => m[2]!.toLowerCase());
    if (!tokens.length) return text;
    const byName = new Map(this.list(projectFolder).map((s) => [s.name, s]));
    const used = [...new Set(tokens)].filter((t) => byName.has(t));
    if (!used.length) return text;
    const rest = text
      .replace(/(^|\s)\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/gi, (all, pre: string, n: string) => (byName.has(n.toLowerCase()) ? pre : all))
      .trim();
    const blocks = used.map((n) => `<skill name="${n}">\n${this.body(byName.get(n)!.path)}\n</skill>`);
    return `${blocks.join("\n\n")}\n\n${rest || "Follow the skill above."}`;
  }

  /** Copies a folder with a SKILL.md into the user's skills folder. */
  importFolder(src: string): Skill {
    if (!existsSync(join(src, "SKILL.md")) || !statSync(src).isDirectory()) throw new Error("That folder has no SKILL.md.");
    const name = basename(src).toLowerCase();
    if (!NAME.test(name)) throw new Error("Rename the folder to letters, digits, - or _ first.");
    const dest = join(this.userDir, name);
    if (existsSync(dest)) throw new Error(`You already have a skill called ${name}.`);
    mkdirSync(this.userDir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    return scan(this.userDir, "user").find((s) => s.name === name)!;
  }
}
