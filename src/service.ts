import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureDirSecure, resolveConfigDir } from "./config.ts";
import type { TunnelMode } from "./types.ts";

export interface LaunchAgentStatus {
  supported: boolean;
  label: string;
  plistPath: string;
  installed: boolean;
  checked: boolean;
  loaded: boolean;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface InstallLaunchAgentOptions {
  projectRoot: string;
  configDir: string;
  port: number;
  tunnelMode: TunnelMode;
  publicUrl?: string;
  profile?: string;
  bunPath?: string;
  launchAgentsDir?: string;
  skipLaunchctl?: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function getServiceLabel(profile?: string): string {
  if (!profile) return "com.gemination.agent";
  const safe = profile.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `com.gemination.agent.${safe}`;
}

export function getLaunchAgentsDir(overrideDir?: string): string {
  return overrideDir ? resolve(overrideDir) : join(homedir(), "Library", "LaunchAgents");
}

export function getLaunchAgentPlistPath(profile?: string, overrideDir?: string): string {
  return join(getLaunchAgentsDir(overrideDir), `${getServiceLabel(profile)}.plist`);
}

export function renderLaunchAgentPlist(options: InstallLaunchAgentOptions): string {
  const label = getServiceLabel(options.profile);
  const bunBin = options.bunPath ?? process.execPath ?? Bun.which("bun") ?? "/opt/homebrew/bin/bun";
  const cliPath = resolve(options.projectRoot, "src", "cli.ts");
  const logDir = join(options.configDir, "logs");
  const stdoutLog = join(logDir, "service.out.log");
  const stderrLog = join(logDir, "service.err.log");

  const cliTunnelFlag: "tailscale" | "quick" | "none" =
    options.tunnelMode === "tailscale"
      ? "tailscale"
      : options.tunnelMode === "quick"
        ? "quick"
        : "none";

  const useProfileFlag =
    Boolean(options.profile) &&
    resolve(options.configDir) === resolve(resolveConfigDir({ profile: options.profile }));

  const programArgs = [
    bunBin,
    "run",
    cliPath,
    "serve",
    "--no-prompt",
    "--no-caffeinate",
    ...(useProfileFlag ? ["--profile", options.profile!] : ["--config-dir", options.configDir]),
    "--port",
    String(options.port),
    "--tunnel",
    cliTunnelFlag,
    ...(options.tunnelMode === "custom" && options.publicUrl ? ["--public-url", options.publicUrl] : []),
  ];

  const envEntries: Record<string, string> = {
    PATH: [
      dirname(bunBin),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Applications/Tailscale.app/Contents/MacOS",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    HOME: homedir(),
    GEMINATION_SERVICE_MODE: "1",
  };

  const argsXml = programArgs.map((arg) => `      <string>${escapeXml(arg)}</string>`).join("\n");
  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(resolve(options.projectRoot))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrLog)}</string>
  </dict>
</plist>
`;
}

function getGuiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

export function getLaunchAgentStatus(options: {
  configDir: string;
  profile?: string;
  launchAgentsDir?: string;
  skipLaunchctl?: boolean;
}): LaunchAgentStatus {
  const label = getServiceLabel(options.profile);
  const plistPath = getLaunchAgentPlistPath(options.profile, options.launchAgentsDir);
  const logDir = join(options.configDir, "logs");
  const supported = process.platform === "darwin";
  const installed = existsSync(plistPath);
  const checked = Boolean(supported && !options.skipLaunchctl && installed);
  let loaded = false;

  if (checked) {
    const res = Bun.spawnSync(["launchctl", "print", `${getGuiDomain()}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
    });
    loaded = res.exitCode === 0;
  }

  return {
    supported,
    label,
    plistPath,
    installed,
    checked,
    loaded,
    stdoutLogPath: join(logDir, "service.out.log"),
    stderrLogPath: join(logDir, "service.err.log"),
  };
}

export function installLaunchAgent(options: InstallLaunchAgentOptions): LaunchAgentStatus {
  if (process.platform !== "darwin") {
    throw new Error("백그라운드 자동 실행(LaunchAgent) 등록은 현재 macOS에서만 지원됩니다.");
  }

  const agentsDir = getLaunchAgentsDir(options.launchAgentsDir);
  const logDir = join(options.configDir, "logs");
  mkdirSync(agentsDir, { recursive: true });
  ensureDirSecure(options.configDir);
  ensureDirSecure(logDir);

  const plistPath = getLaunchAgentPlistPath(options.profile, options.launchAgentsDir);
  const label = getServiceLabel(options.profile);
  const domain = getGuiDomain();

  if (!options.skipLaunchctl) {
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  writeFileSync(plistPath, renderLaunchAgentPlist(options), "utf8");

  if (!options.skipLaunchctl) {
    const boot = Bun.spawnSync(["launchctl", "bootstrap", domain, plistPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (boot.exitCode !== 0) {
      const errText = Buffer.from(boot.stderr).toString("utf8").trim();
      throw new Error(`launchctl bootstrap 실패: ${errText || `exit ${boot.exitCode}`}`);
    }
    Bun.spawnSync(["launchctl", "kickstart", "-k", `${domain}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  return getLaunchAgentStatus({
    configDir: options.configDir,
    profile: options.profile,
    launchAgentsDir: options.launchAgentsDir,
    skipLaunchctl: options.skipLaunchctl,
  });
}

export function uninstallLaunchAgent(options: {
  configDir: string;
  profile?: string;
  launchAgentsDir?: string;
  skipLaunchctl?: boolean;
}): { removed: boolean; status: LaunchAgentStatus } {
  const plistPath = getLaunchAgentPlistPath(options.profile, options.launchAgentsDir);
  const label = getServiceLabel(options.profile);
  const existed = existsSync(plistPath);

  if (process.platform === "darwin" && !options.skipLaunchctl) {
    Bun.spawnSync(["launchctl", "bootout", `${getGuiDomain()}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  if (existed) {
    rmSync(plistPath, { force: true });
  }

  return {
    removed: existed,
    status: getLaunchAgentStatus({
      configDir: options.configDir,
      profile: options.profile,
      launchAgentsDir: options.launchAgentsDir,
      skipLaunchctl: options.skipLaunchctl,
    }),
  };
}

export function readServiceLogTail(logPath: string, lines = 25): string {
  if (!existsSync(logPath)) return "";
  try {
    return readFileSync(logPath, "utf8").split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}
