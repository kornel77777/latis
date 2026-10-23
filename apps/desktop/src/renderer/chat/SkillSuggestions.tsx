import { useEffect, useState } from "react";
import type { Skill } from "@latis/shared";
import { cn } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";

// `/name` in the composer attaches a skill (§9.14). While the word being typed starts with "/",
// matching skills show above the composer; Tab or Enter picks one.

const TOKEN = /(^|\s)\/([a-z0-9_-]*)$/i;

/** The partial skill name being typed at the end of the draft, or null. */
export function skillQuery(draft: string): string | null {
  const m = TOKEN.exec(draft);
  return m ? m[2]!.toLowerCase() : null;
}

export function useSkillSuggestions(draft: string, projectId: string | null) {
  const skills = useWorkspace((s) => s.skills[projectId ?? ""]);
  const [index, setIndex] = useState(0);
  const query = skillQuery(draft);
  useEffect(() => {
    if (query !== null)
      void useWorkspace
        .getState()
        .loadSkills(projectId)
        .catch(() => undefined);
  }, [query, projectId]);
  const matches: Skill[] = query === null ? [] : (skills ?? []).filter((s) => s.name.startsWith(query)).slice(0, 6);
  const pick = (skill: Skill) => draft.replace(TOKEN, (_all, pre: string) => `${pre}/${skill.name} `);
  return {
    matches,
    index: Math.min(index, Math.max(0, matches.length - 1)),
    setIndex,
    /** Handles the key if the list is open; returns the new draft when a skill was picked. */
    onKey(e: React.KeyboardEvent): string | null | undefined {
      if (!matches.length) return undefined;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return null;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        setIndex(0);
        return pick(matches[Math.min(index, matches.length - 1)]!);
      }
      return undefined;
    },
    pick,
  };
}

export function SkillSuggestions({ matches, index, onPick }: { matches: Skill[]; index: number; onPick: (skill: Skill) => void }) {
  if (!matches.length) return null;
  return (
    <ul
      role="listbox"
      aria-label="Skills"
      className="mb-1.5 overflow-hidden rounded-control border border-line bg-surface-2 py-1"
      data-testid="skill-suggestions"
    >
      {matches.map((s, i) => (
        <li
          key={s.path}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
          className={cn("flex cursor-pointer items-baseline gap-2 px-2.5 py-1 text-[12.5px]", i === index && "bg-surface")}
        >
          <span className="font-mono text-text-1">/{s.name}</span>
          <span className="truncate text-text-3">{s.description}</span>
          {s.source === "project" && <span className="ml-auto shrink-0 text-[11px] text-text-3">project</span>}
        </li>
      ))}
    </ul>
  );
}
