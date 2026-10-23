// Repo dashboard refresh: reads the card's data on stdin, asks the gh CLI, prints JSON.
import { execFileSync } from "node:child_process";

const data = JSON.parse(
  await new Promise((r) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => r(s || "{}"));
  }),
);
const repo = String(data.repo ?? "").trim();
const gh = (...args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 30000 }));
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.log(JSON.stringify({ error: "Type a repo as owner/name, then Refresh." }));
} else {
  try {
    const prs = gh("pr", "list", "--repo", repo, "--state", "open", "--limit", "8", "--json", "number,title");
    const issues = gh("issue", "list", "--repo", repo, "--state", "open", "--limit", "8", "--json", "number,title");
    console.log(JSON.stringify({ prs, issues, error: null, fetchedAt: Date.now() }));
  } catch (err) {
    console.log(
      JSON.stringify({
        error: `gh failed: ${
          String(err.stderr || err.message)
            .trim()
            .split("\n")[0]
        }`,
      }),
    );
  }
}
