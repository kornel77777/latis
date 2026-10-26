// The always-ask list (§9.8 AC3): command patterns that need the user's approval in every mode, Full-auto included.

/** What a fresh install starts with (Settings → Permissions). */
export const DEFAULT_ALWAYS_ASK = ["git push", "rm -rf", "npm publish", "pnpm publish", "git reset --hard", "sudo"];

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHORT_FLAGS = /^-[a-zA-Z]+$/;

/**
 * Splits a shell command into simple commands, each a list of words. Quotes are honoured; `;`, `&&`, `||`, `|`, `&`,
 * newlines, parentheses, `$(` and backticks all start a new command. Not a full shell parser: it only has to find
 * where each command starts.
 */
export function shellCommands(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
      continue;
    }
    // Command substitution runs even inside double quotes.
    if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      if (c === "$") i++;
      endCommand();
      quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (";&|()\n".includes(c)) endCommand();
    else if (/\s/.test(c)) endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  // `sh -c '…'`, `bash -lc '…'` and `eval …` run another command line: look inside it too.
  return out.flatMap((w) => {
    const inner: string[][] = [];
    for (let i = 0; i < w.length; i++) {
      const name = basename(w[i]!);
      if (SHELLS.has(name)) {
        const flag = w.findIndex((x, j) => j > i && SHORT_FLAGS.test(x) && x.includes("c"));
        if (flag > 0 && w[flag + 1] !== undefined) inner.push(...shellCommands(w[flag + 1]!));
      } else if (name === "eval") inner.push(...shellCommands(w.slice(i + 1).join(" ")));
    }
    return [w, ...inner];
  });
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

const shortLetters = (words: string[]) =>
  new Set(
    words
      .filter((w) => SHORT_FLAGS.test(w))
      .join("")
      .replaceAll("-", "")
      .toLowerCase(),
  );

const LONG_FOR: Record<string, string> = { r: "--recursive", f: "--force" };

/** Does one simple command match one pattern? The pattern's first word names the program; the rest may come in any order. */
function matchesWords(words: string[], pattern: string[]): boolean {
  const [program, ...rest] = pattern;
  if (!program) return false;
  return words.some((w, i) => {
    if (basename(w) !== program) return false;
    const after = words.slice(i + 1);
    const letters = shortLetters(after);
    return rest.every((p) => {
      if (SHORT_FLAGS.test(p)) {
        return [...p.slice(1).toLowerCase()].every((l) => letters.has(l) || (LONG_FOR[l] !== undefined && after.includes(LONG_FOR[l])));
      }
      if (p.startsWith("--")) return after.some((a) => a === p || a.startsWith(`${p}=`) || a.startsWith(`${p}-`));
      return after.includes(p);
    });
  });
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `pattern` as whole words somewhere in `line` (so `sudo` doesn't match `pseudo`). */
const containsWords = (line: string, pattern: string) => new RegExp(`(^|[\\s;&|()'"\`/])${escape(pattern)}($|[\\s;&|()'"\`])`).test(line);

/**
 * The first always-ask pattern that `command` matches, or null. Matching errs towards asking: a pattern matches
 * when any command in the line (including inside `sh -c` and `$(…)`) starts its program with the pattern's words
 * in any order (`rm -rf` also catches `rm -fr`, `rm -r -f` and `sudo rm -Rf`), or when the line contains the pattern
 * as text.
 */
export function matchAlwaysAsk(command: string, patterns: readonly string[]): string | null {
  const commands = shellCommands(command);
  const line = squash(command);
  for (const raw of patterns) {
    const pattern = squash(raw);
    if (!pattern) continue;
    if (containsWords(line, pattern)) return raw;
    const words = shellCommands(pattern)[0] ?? [];
    if (commands.some((c) => matchesWords(c, words))) return raw;
  }
  return null;
}
