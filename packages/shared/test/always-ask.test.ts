import { describe, expect, it } from "vitest";
import { DEFAULT_ALWAYS_ASK, matchAlwaysAsk, shellCommands } from "../src";

const list = DEFAULT_ALWAYS_ASK;

describe("shellCommands", () => {
  it("splits on operators and honours quotes", () => {
    expect(shellCommands(`echo "a && b" && git push origin main; ls | wc -l`)).toEqual([
      ["echo", "a && b"],
      ["git", "push", "origin", "main"],
      ["ls"],
      ["wc", "-l"],
    ]);
  });

  it("looks inside sh -c, eval and command substitution", () => {
    const cmds = shellCommands(`/bin/zsh -lc 'mkdir b && rm -rf b'`);
    expect(cmds).toContainEqual(["rm", "-rf", "b"]);
    expect(shellCommands("eval git push")).toContainEqual(["git", "push"]);
    expect(shellCommands(`echo "$(git push)"`)).toContainEqual(["git", "push"]);
    expect(shellCommands("echo `npm publish`")).toContainEqual(["npm", "publish"]);
  });
});

describe("matchAlwaysAsk", () => {
  it.each([
    ["git push", "git push"],
    ["git -C repo push --force", "git push"],
    ["/usr/bin/git push origin main", "git push"],
    ["rm -fr build", "rm -rf"],
    ["rm -r -f build", "rm -rf"],
    ["rm -Rf build", "rm -rf"],
    ["rm --recursive --force build", "rm -rf"],
    ["sudo rm -rf /", "rm -rf"],
    ["cd pkg && npm publish --access public", "npm publish"],
    ["/bin/zsh -lc 'rm -rf build'", "rm -rf"],
    ['bash -c "git reset --hard HEAD~1"', "git reset --hard"],
    ["sudo apt install x", "sudo"],
  ])("%s → %s", (command, pattern) => {
    expect(matchAlwaysAsk(command, list)).toBe(pattern);
  });

  it.each([
    "git status",
    "echo pseudo-random",
    "git pushd",
    "rm -r build",
    "rm file.txt",
    "npm install",
    "git reset --soft HEAD~1",
    "ls -la",
    "pushd dir",
  ])("%s is not on the list", (command) => {
    expect(matchAlwaysAsk(command, list)).toBeNull();
  });

  it("errs towards asking when the pattern only appears as text", () => {
    expect(matchAlwaysAsk("echo 'then git push'", ["git push"])).toBe("git push");
  });

  it("ignores blank patterns and returns the user's spelling", () => {
    expect(matchAlwaysAsk("git push", ["", "  ", "git   push"])).toBe("git   push");
    expect(matchAlwaysAsk("anything", [])).toBeNull();
  });

  it("matches long flags with values and longer spellings", () => {
    expect(matchAlwaysAsk("git push --force-with-lease", ["git push --force"])).toBe("git push --force");
    expect(matchAlwaysAsk("git push --force=true", ["git push --force"])).toBe("git push --force");
    expect(matchAlwaysAsk("git push", ["git push --force"])).toBeNull();
  });
});
