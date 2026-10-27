import type { Session } from "electron";

// §13: Electron grants web permissions (camera, microphone, location, notifications…) unless told otherwise.
// Lattiz's own pages only need to write to the clipboard; cards, which agents can write, get nothing.

const APP_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

export function lockDownPermissions(ses: Session, isAppUrl: (url: string) => boolean): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(APP_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => APP_PERMISSIONS.has(permission) && isAppUrl(origin));
}

/** Lattiz's renderer: its bundled files, or the dev server while developing. */
export function appUrlMatcher(devServer: string | undefined): (url: string) => boolean {
  const dev = devServer ? new URL(devServer).origin : null;
  return (url) => url.startsWith("file://") || (dev !== null && (url === dev || url.startsWith(`${dev}/`)));
}
