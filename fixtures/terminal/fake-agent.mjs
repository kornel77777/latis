// A tiny interactive CLI standing in for a terminal-only agent in e2e tests (SPEC §6.3).
// "go" → works for a moment, then asks "Allow this command? (y/n)"; "y" → finishes; "exit" quits.
import { createInterface } from "node:readline";

const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out("Fake agent ready.\n> ");
let waiting = false;
for await (const line of createInterface({ input: process.stdin })) {
  const cmd = line.trim();
  if (cmd === "exit") process.exit(0);
  if (waiting && cmd === "y") {
    waiting = false;
    out("Ran it. All done.\n> ");
  } else if (cmd === "go") {
    for (let i = 1; i <= 5; i++) {
      out(`working ${i}/5…\n`);
      await sleep(150);
    }
    waiting = true;
    out("Run `npm install`?\nAllow this command? (y/n) ");
  } else {
    out(`You said: ${cmd}\n> `);
  }
}
