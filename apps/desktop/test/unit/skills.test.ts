import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Skills, projectSkillsDir } from "../../src/main/skills";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lattiz-skills-"));
  const user = join(dir, "skills");
  const project = join(dir, "shop");
  mkdirSync(user, { recursive: true });
  mkdirSync(projectSkillsDir(project), { recursive: true });
  writeFileSync(join(user, "review.md"), "---\ndescription: Careful code review\n---\nReview for bugs first.\n");
  writeFileSync(join(user, "tests.md"), "# Tests\n\nWrite tests before fixing.\n");
  mkdirSync(join(user, "release"));
  writeFileSync(join(user, "release", "SKILL.md"), "---\nname: release\ndescription: Ship it\n---\nBump, tag, push.\n");
  writeFileSync(join(projectSkillsDir(project), "review.md"), "Project review rules.\n");
  return { skills: new Skills(user), project };
}

describe("skills", () => {
  it("lists user, folder and project skills; the project's win on a name clash", () => {
    const { skills, project } = setup();
    expect(skills.list(null).map((s) => [s.name, s.description])).toEqual([
      ["release", "Ship it"],
      ["review", "Careful code review"],
      ["tests", "Write tests before fixing."],
    ]);
    expect(skills.list(project).find((s) => s.name === "review")!.source).toBe("project");
  });

  it("expands /name for known skills only, leaving other slash words alone", () => {
    const { skills, project } = setup();
    expect(skills.expand("look at /src/auth and /crash", null)).toBe("look at /src/auth and /crash");
    const out = skills.expand("/review the login page /tests", null);
    expect(out).toBe(
      '<skill name="review">\nReview for bugs first.\n</skill>\n\n<skill name="tests">\n# Tests\n\nWrite tests before fixing.\n</skill>\n\nthe login page',
    );
    expect(skills.expand("/review", project)).toBe('<skill name="review">\nProject review rules.\n</skill>\n\nFollow the skill above.');
  });
});
