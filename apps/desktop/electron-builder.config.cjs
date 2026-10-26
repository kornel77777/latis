// electron-builder config (SPEC §17 M7). Signing switches on from the environment, so the same
// config makes unsigned local builds and signed release builds:
//   macOS:   CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12)
//            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (notarization)
//   Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (Authenticode .pfx), or CSC_LINK on a Windows runner
const macSigned = Boolean(process.env.CSC_LINK) && process.platform === "darwin";
const winSigned = Boolean(process.env.WIN_CSC_LINK || (process.platform === "win32" && process.env.CSC_LINK));
const notarize = macSigned && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.latis.app",
  productName: "Latis",
  directories: { output: "release", buildResources: "build" },
  files: [
    "out/**",
    "package.json",
    // Latis drives the user's installed `claude`; the SDK's bundled CLI binaries (~260 MB each) don't ship.
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  asarUnpack: [
    "**/*.node",
    // node-pty execs its spawn-helper binary, which can't run from inside the asar.
    "**/node_modules/node-pty/**",
  ],
  // The app reads this to know whether it may auto-update (main/updates.ts): unsigned builds don't.
  // latisPersonal (LATIS_PERSONAL=1 pnpm package): a build for your own machine, where the chat-view Claude may
  // run on your Claude sign-in. Release builds never set it (DECISIONS 2026-10-26).
  extraMetadata: { latisSigned: macSigned || winSigned, latisPersonal: process.env.LATIS_PERSONAL === "1" },
  // §13: refuse a modified app. RunAsNode stays on: the latis-mcp shim, the demo agent and card
  // refresh scripts run as Electron-as-Node child processes.
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    // Playwright drives Electron through the inspector, so test builds (LATIS_TEST_PACKAGE=1) keep it.
    enableNodeCliInspectArguments: process.env.LATIS_TEST_PACKAGE === "1",
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  // Writing the fuses changes the Electron binary and breaks its ad-hoc signature, and Apple
  // Silicon won't start an app whose signature is broken. Unsigned builds get re-signed ad hoc.
  afterSign: (context) => {
    if (context.electronPlatformName !== "darwin" || macSigned) return;
    const app = require("node:path").join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    require("node:child_process").execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  },

  publish: [{ provider: "github", owner: "kornel77777", repo: "latis", releaseType: "draft" }],
  mac: {
    category: "public.app-category.developer-tools",
    target: ["dmg", "zip"],
    ...(macSigned
      ? {
          hardenedRuntime: true,
          entitlements: "build/entitlements.mac.plist",
          entitlementsInherit: "build/entitlements.mac.plist",
          notarize,
        }
      : { identity: null }),
  },
  win: { target: ["nsis"] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  // The package is "@latis/desktop"; Linux needs a file-safe program name.
  linux: { target: ["AppImage", "deb"], category: "Development", maintainer: "Kornel Omori", executableName: "latis" },
};
