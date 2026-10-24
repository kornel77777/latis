// External links (SPEC §13): http(s) and mailto open in the system browser or mail app; other
// app schemes (vscode:, slack:…) ask first; schemes that can run code or read files never open.

const OPEN = new Set(["http:", "https:", "mailto:"]);
const BLOCK = new Set([
  "javascript:",
  "vbscript:",
  "data:",
  "blob:",
  "file:",
  "about:",
  "chrome:",
  "devtools:",
  "card:",
  "smb:",
  "ms-msdt:",
  "search-ms:",
]);

export type LinkAction = "open" | "confirm" | "block";

export function linkAction(url: string): LinkAction {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "block";
  }
  if (OPEN.has(u.protocol)) return "open";
  if (BLOCK.has(u.protocol) || !/^[a-z][a-z0-9+.-]*:$/i.test(u.protocol)) return "block";
  return "confirm";
}

export interface LinkDeps {
  openExternal(url: string): Promise<void>;
  confirm(message: string, detail: string): Promise<boolean>;
}

/** Opens a link the renderer asked for, by the rules above. */
export async function openLink(url: string, d: LinkDeps): Promise<boolean> {
  const action = linkAction(url);
  if (action === "block") return false;
  if (action === "confirm" && !(await d.confirm("Open this link in another app?", url.length > 300 ? `${url.slice(0, 300)}…` : url)))
    return false;
  await d.openExternal(url);
  return true;
}
