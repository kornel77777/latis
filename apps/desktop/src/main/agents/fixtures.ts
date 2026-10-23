// Fake agent scripts, bundled into the main build from fixtures/fake/*.jsonl.
const files = import.meta.glob<string>("../../../../../fixtures/fake/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const fakeScripts: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, body]) => [
    path
      .split("/")
      .pop()!
      .replace(/\.jsonl$/, ""),
    body,
  ]),
);
