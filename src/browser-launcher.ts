import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDirSecure } from "./config.ts";
import { openInBrowser } from "./setup-wizard.ts";

export const GEMINI_WEB_URL = "https://gemini.google.com/app";

const MACOS_CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export interface BrowserProfileStatus {
  profileDir: string;
  initialized: boolean;
  chromePath: string | null;
  chromeAvailable: boolean;
}

export function findChromeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.GEMINATION_CHROME_BIN?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const fromPath = Bun.which(override);
    if (fromPath) return fromPath;
  }

  if (process.platform === "darwin") {
    for (const candidate of MACOS_CHROME_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  }

  for (const binName of ["google-chrome", "chromium", "chromium-browser"]) {
    const resolved = Bun.which(binName);
    if (resolved) return resolved;
  }

  return null;
}

export function getDedicatedBrowserProfileDir(configDir: string): string {
  return join(configDir, "browser-profile");
}

export function getUiWindowProfileDir(configDir: string): string {
  return join(configDir, "ui-window-profile");
}

export function getBrowserProfileStatus(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): BrowserProfileStatus {
  const profileDir = getDedicatedBrowserProfileDir(configDir);
  const chromePath = findChromeBinary(env);
  const initialized =
    existsSync(join(profileDir, "Default")) || existsSync(join(profileDir, "Local State"));
  return {
    profileDir,
    initialized,
    chromePath,
    chromeAvailable: Boolean(chromePath),
  };
}

function isHeadlessOrDisabled(): boolean {
  return (
    process.env.CI === "1"
    || process.env.CI === "true"
    || process.env.GEMINATION_NO_OPEN === "1"
  );
}

export function openDesktopAppWindow(url: string, configDir: string): {
  opened: boolean;
  mode: "chrome-app" | "system-browser" | "skipped";
} {
  if (isHeadlessOrDisabled()) {
    return { opened: false, mode: "skipped" };
  }

  const chrome = findChromeBinary();
  if (chrome) {
    const uiProfileDir = getUiWindowProfileDir(configDir);
    ensureDirSecure(configDir);
    if (!existsSync(uiProfileDir)) {
      mkdirSync(uiProfileDir, { recursive: true, mode: 0o700 });
    }
    try {
      const proc = Bun.spawn(
        [
          chrome,
          `--app=${url}`,
          `--user-data-dir=${uiProfileDir}`,
          "--window-size=1320,860",
          "--no-first-run",
          "--no-default-browser-check",
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        },
      );
      proc.unref();
      return { opened: true, mode: "chrome-app" };
    } catch {
      // Fallback to default browser below.
    }
  }

  const ok = openInBrowser(url);
  return { opened: ok, mode: ok ? "system-browser" : "skipped" };
}

export function openGeminiLoginWindow(
  configDir: string,
  options: { mode?: "dedicated" | "default"; url?: string } = {},
): {
  opened: boolean;
  usedMode: "dedicated-chrome" | "system-browser" | "skipped";
  profileDir: string;
} {
  const targetUrl = options.url ?? GEMINI_WEB_URL;
  const profileDir = getDedicatedBrowserProfileDir(configDir);

  if (isHeadlessOrDisabled()) {
    return { opened: false, usedMode: "skipped", profileDir };
  }

  const requestedMode = options.mode ?? "dedicated";
  const chrome = requestedMode === "dedicated" ? findChromeBinary() : null;

  if (requestedMode === "dedicated" && chrome) {
    ensureDirSecure(configDir);
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    }
    try {
      const proc = Bun.spawn(
        [
          chrome,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          targetUrl,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        },
      );
      proc.unref();
      return { opened: true, usedMode: "dedicated-chrome", profileDir };
    } catch {
      // Fall back to default browser.
    }
  }

  const ok = openInBrowser(targetUrl);
  return {
    opened: ok,
    usedMode: ok ? "system-browser" : "skipped",
    profileDir,
  };
}

export function resetDedicatedBrowserProfile(configDir: string): boolean {
  const profileDir = getDedicatedBrowserProfileDir(configDir);
  if (!existsSync(profileDir)) {
    return false;
  }
  rmSync(profileDir, { recursive: true, force: true });
  return true;
}

export function openTailscaleMacApp(): boolean {
  if (isHeadlessOrDisabled() || process.platform !== "darwin") {
    return false;
  }
  try {
    const proc = Bun.spawn(["open", "-a", "Tailscale"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
    return true;
  } catch {
    return false;
  }
}
