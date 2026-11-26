import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureDirSecure, resolveConfigDir } from "./config.ts";
import type { TunnelMode } from "./types.ts";

export type BackgroundServiceKind = "launchagent" | "systemd" | "windows-startup" | "unsupported";

export interface LaunchAgentStatus {
  kind: BackgroundServiceKind;
  supported: boolean;
  label: string;
  plistPath: string;
  servicePath: string;
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
  serviceDir?: string;
  platform?: string;
  skipLaunchctl?: boolean;
  skipServiceControl?: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeVbs(value: string): string {
  return value.replaceAll('"', '""');
}

function assertNoControlChars(value: string | undefined, fieldName: string): void {
  if (value && /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid control characters in service ${fieldName}`);
  }
}

function validateServiceOptions(options: InstallLaunchAgentOptions): void {
  assertNoControlChars(options.projectRoot, "projectRoot");
  assertNoControlChars(options.configDir, "configDir");
  assertNoControlChars(options.profile, "profile");
  assertNoControlChars(options.publicUrl, "publicUrl");
  assertNoControlChars(options.bunPath, "bunPath");
}

export function getServiceLabel(profile?: string): string {
  if (!profile) return "com.gemination.agent";
  const safe = profile.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `com.gemination.agent.${safe}`;
}

export function getSystemdUnitName(profile?: string): string {
  if (!profile) return "gemination.service";
  const safe = profile.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `gemination-${safe}.service`;
}

export function getLaunchAgentsDir(overrideDir?: string): string {
  return overrideDir ? resolve(overrideDir) : join(homedir(), "Library", "LaunchAgents");
}

export function getLaunchAgentPlistPath(profile?: string, overrideDir?: string): string {
  return join(getLaunchAgentsDir(overrideDir), `${getServiceLabel(profile)}.plist`);
}

export function getSystemdUserDir(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(xdgConfig, "systemd", "user");
}

export function getWindowsStartupDir(overrideDir?: string): string {
  if (overrideDir) return resolve(overrideDir);
  const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function getBackgroundServiceFilePath(options: {
  profile?: string;
  platform?: string;
  launchAgentsDir?: string;
  serviceDir?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const customDir = options.serviceDir ?? options.launchAgentsDir;
  if (platform === "darwin") {
    return getLaunchAgentPlistPath(options.profile, customDir);
  }
  if (platform === "linux") {
    return join(getSystemdUserDir(customDir), getSystemdUnitName(options.profile));
  }
  if (platform === "win32") {
    const safe = options.profile ? `-${options.profile.replace(/[^a-zA-Z0-9._-]/g, "_")}` : "";
    return join(getWindowsStartupDir(customDir), `Gemination${safe}.vbs`);
  }
  return join(customDir ? resolve(customDir) : homedir(), "gemination.service");
}

function buildServiceProgramArgs(options: InstallLaunchAgentOptions): {
  bunBin: string;
  programArgs: string[];
} {
  validateServiceOptions(options);
  const bunBin = options.bunPath ?? process.execPath ?? Bun.which("bun") ?? "bun";
  const cliPath = resolve(options.projectRoot, "src", "cli.ts");
  const cliTunnelFlag: "tailscale" | "quick" | "none" =
    options.tunnelMode === "tailscale"
      ? "tailscale"
      : options.tunnelMode === "quick"
        ? "quick"
        : "none";

  const useProfileFlag =
    Boolean(options.profile)
    && resolve(options.configDir) === resolve(resolveConfigDir({ profile: options.profile }));

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

  return { bunBin, programArgs };
}

export function renderLaunchAgentPlist(options: InstallLaunchAgentOptions): string {
  const label = getServiceLabel(options.profile);
  const { bunBin, programArgs } = buildServiceProgramArgs(options);
  const logDir = join(options.configDir, "logs");
  const stdoutLog = join(logDir, "service.out.log");
  const stderrLog = join(logDir, "service.err.log");

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

function systemdQuote(arg: string): string {
  return `"${arg
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$")}"`;
}

export function renderSystemdUserUnit(options: InstallLaunchAgentOptions): string {
  const { bunBin, programArgs } = buildServiceProgramArgs(options);
  const logDir = join(options.configDir, "logs");
  const stdoutLog = join(logDir, "service.out.log");
  const stderrLog = join(logDir, "service.err.log");
  const execStart = programArgs.map(systemdQuote).join(" ");
  const pathEnv = [dirname(bunBin), join(homedir(), ".bun", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const safePathEnv = pathEnv.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");

  return `[Unit]
Description=Gemination Gemini Web MCP Connector${options.profile ? ` (${options.profile})` : ""}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${resolve(options.projectRoot)}
Environment=GEMINATION_SERVICE_MODE=1
Environment="PATH=${safePathEnv}"
ExecStart=${execStart}
Restart=on-failure
RestartSec=3
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}

[Install]
WantedBy=default.target
`;
}

function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function renderWindowsStartupVbs(options: InstallLaunchAgentOptions): string {
  const { programArgs } = buildServiceProgramArgs(options);
  const workDir = resolve(options.projectRoot);
  const cmdLine = programArgs.map(quoteCmdArg).join(" ");
  return [
    "Set WshShell = CreateObject(\"WScript.Shell\")",
    `WshShell.CurrentDirectory = "${escapeVbs(workDir)}"`,
    `Set env = WshShell.Environment("PROCESS")`,
    `env("GEMINATION_SERVICE_MODE") = "1"`,
    `WshShell.Run "${escapeVbs(cmdLine)}", 0, False`,
    "",
  ].join("\r\n");
}

function getGuiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

export function getBackgroundServiceStatus(options: {
  configDir: string;
  profile?: string;
  launchAgentsDir?: string;
  serviceDir?: string;
  platform?: string;
  skipLaunchctl?: boolean;
  skipServiceControl?: boolean;
}): LaunchAgentStatus {
  const platform = options.platform ?? process.platform;
  const kind: BackgroundServiceKind =
    platform === "darwin"
      ? "launchagent"
      : platform === "linux"
        ? "systemd"
        : platform === "win32"
          ? "windows-startup"
          : "unsupported";
  const label =
    platform === "linux" ? getSystemdUnitName(options.profile) : getServiceLabel(options.profile);
  const servicePath = getBackgroundServiceFilePath(options);
  const logDir = join(options.configDir, "logs");
  const supported = kind !== "unsupported";
  const installed = supported && existsSync(servicePath);
  const skipCtrl = Boolean(options.skipServiceControl ?? options.skipLaunchctl);
  let checked = false;
  let loaded = false;

  if (platform === "darwin" && installed && !skipCtrl) {
    checked = true;
    const res = Bun.spawnSync(["launchctl", "print", `${getGuiDomain()}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
    });
    loaded = res.exitCode === 0;
  } else if (platform === "linux" && installed && !skipCtrl && Bun.which("systemctl")) {
    checked = true;
    const res = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", label], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3_000,
    });
    loaded = res.exitCode === 0;
  } else if (platform === "win32" && installed) {
    checked = false;
    loaded = false;
  }

  return {
    kind,
    supported,
    label,
    plistPath: servicePath,
    servicePath,
    installed,
    checked,
    loaded,
    stdoutLogPath: join(logDir, "service.out.log"),
    stderrLogPath: join(logDir, "service.err.log"),
  };
}

export const getLaunchAgentStatus = getBackgroundServiceStatus;

export function installBackgroundService(options: InstallLaunchAgentOptions): LaunchAgentStatus {
  const platform = options.platform ?? process.platform;
  const skipCtrl = Boolean(options.skipServiceControl ?? options.skipLaunchctl);
  const logDir = join(options.configDir, "logs");
  ensureDirSecure(options.configDir);
  ensureDirSecure(logDir);

  if (platform === "darwin") {
    const agentsDir = getLaunchAgentsDir(options.serviceDir ?? options.launchAgentsDir);
    mkdirSync(agentsDir, { recursive: true });
    const plistPath = getBackgroundServiceFilePath({ ...options, platform });
    const label = getServiceLabel(options.profile);
    const domain = getGuiDomain();

    if (!skipCtrl) {
      Bun.spawnSync(["launchctl", "bootout", `${domain}/${label}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    writeFileSync(plistPath, renderLaunchAgentPlist(options), "utf8");

    if (!skipCtrl) {
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

    return getBackgroundServiceStatus(options);
  }

  if (platform === "linux") {
    const unitDir = getSystemdUserDir(options.serviceDir ?? options.launchAgentsDir);
    mkdirSync(unitDir, { recursive: true });
    const unitPath = getBackgroundServiceFilePath({ ...options, platform });
    const unitName = getSystemdUnitName(options.profile);
    writeFileSync(unitPath, renderSystemdUserUnit(options), "utf8");

    if (!skipCtrl && Bun.which("systemctl")) {
      Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
      const en = Bun.spawnSync(["systemctl", "--user", "enable", "--now", unitName], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (en.exitCode !== 0) {
        const errText = Buffer.from(en.stderr).toString("utf8").trim();
        throw new Error(`systemctl --user enable 실패: ${errText || `exit ${en.exitCode}`}`);
      }
    }
    return getBackgroundServiceStatus(options);
  }

  if (platform === "win32") {
    const startupDir = getWindowsStartupDir(options.serviceDir ?? options.launchAgentsDir);
    mkdirSync(startupDir, { recursive: true });
    const vbsPath = getBackgroundServiceFilePath({ ...options, platform });
    writeFileSync(vbsPath, renderWindowsStartupVbs(options), "utf8");
    return getBackgroundServiceStatus(options);
  }

  throw new Error(`현재 OS(${platform})에서는 백그라운드 자동 시작 등록을 지원하지 않습니다.`);
}

export const installLaunchAgent = installBackgroundService;

export function uninstallBackgroundService(options: {
  configDir: string;
  profile?: string;
  launchAgentsDir?: string;
  serviceDir?: string;
  platform?: string;
  skipLaunchctl?: boolean;
  skipServiceControl?: boolean;
}): { removed: boolean; status: LaunchAgentStatus } {
  const platform = options.platform ?? process.platform;
  const skipCtrl = Boolean(options.skipServiceControl ?? options.skipLaunchctl);
  const servicePath = getBackgroundServiceFilePath(options);
  const existed = existsSync(servicePath);

  if (platform === "darwin" && !skipCtrl) {
    const label = getServiceLabel(options.profile);
    Bun.spawnSync(["launchctl", "bootout", `${getGuiDomain()}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } else if (platform === "linux" && !skipCtrl && Bun.which("systemctl")) {
    const unitName = getSystemdUnitName(options.profile);
    Bun.spawnSync(["systemctl", "--user", "disable", "--now", unitName], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  if (existed) {
    rmSync(servicePath, { force: true });
  }

  if (platform === "linux" && !skipCtrl && Bun.which("systemctl")) {
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
  }

  return {
    removed: existed,
    status: getBackgroundServiceStatus(options),
  };
}

export const uninstallLaunchAgent = uninstallBackgroundService;

export function readServiceLogTail(logPath: string, maxLines = 20): string {
  if (!existsSync(logPath)) return "";
  try {
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}
