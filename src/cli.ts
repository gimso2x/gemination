#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GEMINI_WEB_URL, openDesktopAppWindow } from "./browser-launcher.ts";
import {
  DEFAULT_PORT,
  expandTilde,
  getConfigPath,
  loadConfig,
  normalizeRoots,
  resolveConfigDir,
  saveConfig,
} from "./config.ts";
import { startGeminationHttpServer } from "./http-server.ts";
import { acquireInstanceLock, readInstanceLock } from "./lock.ts";
import {
  detectLocalClients,
  isLocalMcpClientId,
  registerLocalClient,
  unregisterLocalClient,
} from "./mcp-clients.ts";
import { OAuthServer } from "./oauth.ts";
import { createKeepAwakeController } from "./power.ts";
import { ProcessManager } from "./process-manager.ts";
import { attachRuntimeHotkeys } from "./runtime-keys.ts";
import { getPlatformUiMeta, getTunnelInstallHint, tryCopyToClipboard } from "./platform.ts";
import { AuditLogger } from "./security.ts";
import {
  getBackgroundServiceStatus,
  installBackgroundService,
  readServiceLogTail,
  uninstallBackgroundService,
} from "./service.ts";
import {
  formatPermissionPresetLabel,
  isNativeFolderPickerAvailable,
  LinePrompt,
  openInBrowser,
  promptWorkspaceAndPermissions,
} from "./setup-wizard.ts";
import { createGeminationMcpServer } from "./tools.ts";
import { TunnelController } from "./tunnel-controller.ts";
import {
  findCloudflaredBinary,
  findTailscaleBinary,
  inspectTailscaleStatus,
  type PublicProbeResult,
} from "./tunnel.ts";
import { normalizeCustomPublicUrl, promptTunnelSelection } from "./tunnel-selector.ts";
import type { GeminationConfig, TailscaleFunnelPort } from "./types.ts";

interface ParsedArgs {
  command: string;
  subArgs: string[];
  roots: string[];
  port?: number;
  tunnel?: "tailscale" | "quick" | "none";
  funnelPort?: TailscaleFunnelPort;
  choose: boolean;
  noPrompt: boolean;
  publicUrl?: string;
  noShell: boolean;
  readOnly: boolean;
  noSecretShield: boolean;
  noCaffeinate: boolean;
  noProbe: boolean;
  openDashboard: boolean;
  resetPin: boolean;
  rotatePin: boolean;
  rotateStaticClient: boolean;
  noCopy: boolean;
  configDir?: string;
  profile?: string;
  help: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "help",
    subArgs: [],
    roots: [],
    choose: false,
    noPrompt: false,
    noShell: false,
    readOnly: false,
    noSecretShield: false,
    noCaffeinate: false,
    noProbe: false,
    openDashboard: false,
    resetPin: false,
    rotatePin: false,
    rotateStaticClient: false,
    noCopy: false,
    help: false,
  };

  let commandSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      parsed.help = true;
    } else if (token === "--root") {
      const next = argv[++i];
      if (!next) throw new Error("--root requires a directory path");
      parsed.roots.push(next);
    } else if (token === "--port") {
      const next = argv[++i];
      const port = Number(next);
      if (!next || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid --port value: ${next ?? ""}`);
      }
      parsed.port = port;
    } else if (token === "--tunnel") {
      const next = argv[++i];
      if (next !== "tailscale" && next !== "quick" && next !== "none") {
        throw new Error(`--tunnel must be "tailscale", "quick", or "none", got: ${next ?? ""}`);
      }
      parsed.tunnel = next;
    } else if (token === "--funnel-port") {
      const next = argv[++i];
      const funnelPort = Number(next);
      if (funnelPort !== 443 && funnelPort !== 8443 && funnelPort !== 10000) {
        throw new Error(`--funnel-port must be 443, 8443, or 10000, got: ${next ?? ""}`);
      }
      parsed.funnelPort = funnelPort;
    } else if (token === "--choose") {
      parsed.choose = true;
    } else if (token === "--no-prompt") {
      parsed.noPrompt = true;
    } else if (token === "--public-url") {
      const next = argv[++i];
      if (!next || !next.trim() || next.startsWith("-")) {
        throw new Error("--public-url requires an HTTPS URL");
      }
      const normalized = normalizeCustomPublicUrl(next);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      parsed.publicUrl = normalized.url;
    } else if (token === "--config-dir") {
      const next = argv[++i];
      if (!next || !next.trim() || next.startsWith("-")) {
        throw new Error("--config-dir requires a directory path");
      }
      parsed.configDir = next.trim();
    } else if (token === "--profile") {
      const next = argv[++i];
      if (!next || !next.trim() || next.startsWith("-")) {
        throw new Error("--profile requires a profile name");
      }
      parsed.profile = next.trim();
    } else if (token === "--no-shell") {
      parsed.noShell = true;
    } else if (token === "--read-only") {
      parsed.readOnly = true;
    } else if (token === "--no-secret-shield") {
      parsed.noSecretShield = true;
    } else if (token === "--no-caffeinate") {
      parsed.noCaffeinate = true;
    } else if (token === "--no-probe") {
      parsed.noProbe = true;
    } else if (token === "--open-dashboard") {
      parsed.openDashboard = true;
    } else if (token === "--reset-pin") {
      parsed.resetPin = true;
    } else if (token === "--rotate-pin") {
      parsed.rotatePin = true;
    } else if (token === "--rotate-static-client") {
      parsed.rotateStaticClient = true;
    } else if (token === "--remove") {
      parsed.subArgs.push("--remove");
    } else if (token === "--no-copy") {
      parsed.noCopy = true;
    } else if (!token.startsWith("-")) {
      if (!commandSet) {
        parsed.command = token;
        commandSet = true;
      } else {
        parsed.subArgs.push(token);
      }
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`gemination — Gemini Web -> Local PC Official MCP Connector

Usage:
  gemination <command> [options]

Commands:
  gui           Launch Gemination Studio desktop/web GUI (workbench + Chrome login + tunnel control)
  up            One-click start: interactive tunnel/workspace picker, auto-init, probe, dashboard & copy URL
  stdio         Run MCP server over stdio (zero region lock / zero tunnel — for Gemini CLI, Claude, Cursor)
  connect       Register/remove Gemination stdio MCP in local clients (gemini-cli | claude-desktop | cursor | remove | snippet)
  setup         Interactive setup wizard for workspace roots, safety mode, and default tunnel
  serve         Start the local MCP + OAuth server + loopback Studio UI
  config        Inspect or modify saved settings (get | add-root | remove-root | read-only | shell | secret-shield | keep-awake | tunnel)
  service       Manage OS background auto-start service (LaunchAgent / systemd --user / Startup VBS)
  init          Initialize config, workspace roots, owner approval code, and static OAuth client
  credentials   Show summary and optionally rotate owner PIN or static OAuth client credentials
  revoke        Revoke all active OAuth access and refresh tokens
  doctor        Check Bun, tailscale, cloudflared, keep-awake, rg, git, lock, config, roots, and port

Options:
  --root <dir>                  Allow workspace root (repeatable)
  --port <n>                    Local loopback MCP port (default: ${DEFAULT_PORT}; Studio UI binds on port + 1)
  --tunnel <tailscale|quick|none>
                                Tunnel mode (default: interactive prompt in TTY, else saved mode or quick)
  --funnel-port <443|8443|10000>
                                Tailscale Funnel HTTPS port (default: 443)
  --choose                      Show interactive tunnel & settings selection menu
  --no-prompt                   Skip interactive selection menu
  --public-url <url>            Use an existing HTTPS URL (e.g. Cloudflare Named Tunnel)
  --profile <name>              Use an isolated named profile under ~/.config/gemination/profiles/<name>
  --config-dir <dir>            Override config/state directory (mutually exclusive with --profile)
  --no-shell                    Disable run_command / start_process tools
  --read-only                   Disable write_file / edit_file tools
  --no-secret-shield            Disable automatic masking of API keys/tokens in MCP tool output
  --no-caffeinate               Disable sleep prevention while serving (macOS/Windows/Linux)
  --no-probe                    Skip external HTTPS self-check probe after tunnel startup
  --open-dashboard              Open Studio UI in default browser when ready
  --reset-pin                   Generate and print a new owner approval PIN on serve/up/setup/gui
  --no-copy                     Do not copy Gemini MCP URL to clipboard in up mode
  --rotate-pin                  Rotate owner approval PIN (for credentials)
  --rotate-static-client        Rotate static OAuth client_id & client_secret (for credentials)
  -h, --help                    Show this help
`);
}

function applyOverrides(base: GeminationConfig, parsed: ParsedArgs): GeminationConfig {
  return {
    ...base,
    port: parsed.port ?? base.port,
    roots: parsed.roots.length > 0 ? normalizeRoots(parsed.roots) : base.roots,
    publicUrl: parsed.publicUrl ?? base.publicUrl,
    allowShell: parsed.noShell ? false : base.allowShell,
    allowWrite: parsed.readOnly ? false : base.allowWrite,
    shieldSecrets: parsed.noSecretShield ? false : base.shieldSecrets,
    keepAwake: parsed.noCaffeinate ? false : base.keepAwake,
  };
}

function isPortAvailable(port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const tester = createNetServer();
    tester.once("error", () => resolvePromise(false));
    tester.once("listening", () => {
      tester.close(() => resolvePromise(true));
    });
    tester.listen(port, "127.0.0.1");
  });
}

async function resolveServePort(
  preferredPort: number,
  excludePort?: number,
): Promise<{ port: number; switchedFrom?: number }> {
  if (preferredPort === 0) {
    return { port: 0 };
  }
  if (preferredPort !== excludePort && (await isPortAvailable(preferredPort))) {
    return { port: preferredPort };
  }
  const maxCandidate = Math.min(65535, preferredPort + 20);
  for (let candidate = preferredPort + 1; candidate <= maxCandidate; candidate += 1) {
    if (candidate !== excludePort && (await isPortAvailable(candidate))) {
      return { port: candidate, switchedFrom: preferredPort };
    }
  }
  return { port: 0, switchedFrom: preferredPort };
}

async function runInit(parsed: ParsedArgs): Promise<void> {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const existing = loadConfig(configDir);
  const updated = applyOverrides(existing, parsed);
  const configPath = saveConfig(updated, configDir);
  const oauth = new OAuthServer(configDir, updated);
  const creds = oauth.initializeFreshCredentials();

  console.log("Gemination initialized.");
  console.log(`Config file:          ${configPath}`);
  console.log(`Allowed roots:        ${updated.roots.join(", ")}`);
  console.log(`Port:                 ${updated.port}`);
  console.log(`Write enabled:        ${updated.allowWrite}`);
  console.log(`Shell enabled:        ${updated.allowShell}`);
  console.log(`Secret shield:        ${updated.shieldSecrets}`);
  console.log(`Keep awake:           ${updated.keepAwake}`);
  console.log("");
  console.log(`Owner Approval Code:  ${creds.pin}`);
  console.log("  (Enter this code in the browser page when Gemini connects via OAuth.)");
  console.log("");
  console.log(`Static Client ID:     ${creds.staticClientId}`);
  console.log(`Static Client Secret: ${creds.staticClientSecret}`);
  console.log("  (Only needed for manual/Enterprise setups; Gemini Web DCR leaves Client ID/Secret blank.)");
}

function pickDefaultRoot(): string {
  const candidates = [
    join(homedir(), "Projects"),
    join(homedir(), "Developer"),
    join(homedir(), "Documents"),
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return process.cwd();
}

type ResolvedTunnelPlan =
  | { mode: "tailscale"; httpsPort: TailscaleFunnelPort }
  | { mode: "quick" }
  | { mode: "custom"; publicUrl: string }
  | { mode: "none"; publicUrl?: string };

function formatTunnelModeLabel(plan: ResolvedTunnelPlan): string {
  switch (plan.mode) {
    case "tailscale":
      return `Tailscale Funnel (고정 HTTPS · 포트 ${plan.httpsPort})`;
    case "quick":
      return "Cloudflare Quick Tunnel (임시 HTTPS · 재시작 시 URL 변경)";
    case "custom":
      return "직접 지정한 고정 HTTPS URL";
    case "none":
      return plan.publicUrl ? "직접 지정한 고정 HTTPS URL (--tunnel none)" : "로컬 전용 (127.0.0.1)";
  }
}

async function runSetup(parsed: ParsedArgs): Promise<void> {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const hasConfig = existsSync(getConfigPath(configDir));
  const hasState = existsSync(join(configDir, "state.json"));
  let config = applyOverrides(loadConfig(configDir), parsed);
  if (!hasConfig && parsed.roots.length === 0) {
    config.roots = normalizeRoots([pickDefaultRoot()]);
  }

  const prompter = new LinePrompt(process.stdin, process.stdout);
  try {
    const wiz = await promptWorkspaceAndPermissions(prompter, config, process.stdout, {
      allowNativePicker: Boolean(process.stdin.isTTY) && isNativeFolderPickerAvailable(),
    });
    if (wiz.cancelled) {
      console.log("설정을 취소했습니다.");
      return;
    }
    config = wiz.config;

    const funnelPort = parsed.funnelPort ?? config.tailscaleFunnelPort ?? 443;
    const tailscale = inspectTailscaleStatus(funnelPort);
    const cloudflaredBinary = findCloudflaredBinary();
    const selection = await promptTunnelSelection({
      config,
      tailscale,
      cloudflaredBinary,
      funnelPort,
      prompter,
      hideSettingsOption: true,
    });
    if (selection.cancelled) {
      console.log("설정을 취소했습니다.");
      return;
    }
    if (selection.updatedConfig) {
      config = selection.updatedConfig;
    }

    if (selection.mode === "tailscale") {
      config.tunnelMode = "tailscale";
      config.tailscaleFunnelPort = selection.httpsPort;
      config.publicUrl = undefined;
    } else if (selection.mode === "quick") {
      config.tunnelMode = "quick";
      config.publicUrl = undefined;
    } else if (selection.mode === "custom") {
      config.tunnelMode = "custom";
      config.publicUrl = selection.publicUrl;
    } else {
      config.tunnelMode = "none";
      config.publicUrl = undefined;
    }
  } finally {
    prompter.close();
  }

  const savedPath = saveConfig(config, configDir);
  const oauth = new OAuthServer(configDir, config);
  const pin = !hasState || parsed.resetPin ? oauth.resetPin() : undefined;

  console.log("");
  console.log("============================================================");
  console.log(" Gemination 초기 설정 저장 완료");
  console.log("============================================================");
  console.log(` 설정 파일:    ${savedPath}`);
  console.log(` 허용 폴더:    ${config.roots.join(", ")}`);
  console.log(` 보안 모드:    ${formatPermissionPresetLabel(config)}`);
  console.log(` 기본 터널:    ${config.tunnelMode}${config.publicUrl ? ` (${config.publicUrl})` : ""}`);
  if (pin) {
    console.log(` Approval PIN: ${pin}`);
  }
  const runHint = process.platform === "win32" ? "Start-Gemination.bat` 또는 `bun run up" : "./start.sh` 또는 `bun run up";
  console.log(` 이제 \`${runHint}\` 으로 바로 실행할 수 있습니다.`);
  console.log("============================================================");
}

function parseOnOff(value: string | undefined, actionName: string): boolean {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  throw new Error(`'config ${actionName}' expects 'on' or 'off', got: ${value ?? "(missing)"}`);
}

function runConfigCommand(parsed: ParsedArgs): void {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const configPath = getConfigPath(configDir);
  const config = loadConfig(configDir);
  const action = parsed.subArgs[0] ?? "get";
  const rest = parsed.subArgs.slice(1);

  switch (action) {
    case "get": {
      console.log(
        JSON.stringify(
          {
            configPath,
            ...config,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "add-root": {
      const target = rest[0];
      if (!target) throw new Error("config add-root requires a directory path");
      const resolved = resolve(expandTilde(target));
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`Directory does not exist: ${resolved}`);
      }
      config.roots = normalizeRoots([...config.roots, resolved]);
      saveConfig(config, configDir);
      console.log(`Allowed roots: ${config.roots.join(", ")}`);
      return;
    }
    case "remove-root": {
      const target = rest[0];
      if (!target) throw new Error("config remove-root requires a directory path");
      const [normalizedTarget] = normalizeRoots([target]);
      const next = config.roots.filter((r) => r !== normalizedTarget && r !== target);
      if (next.length === 0) {
        throw new Error("Cannot remove the last remaining workspace root.");
      }
      config.roots = next;
      saveConfig(config, configDir);
      console.log(`Allowed roots: ${config.roots.join(", ")}`);
      return;
    }
    case "read-only": {
      const enabled = parseOnOff(rest[0], "read-only");
      config.allowWrite = !enabled;
      saveConfig(config, configDir);
      console.log(`read-only=${enabled} (allowWrite=${config.allowWrite})`);
      return;
    }
    case "shell": {
      const enabled = parseOnOff(rest[0], "shell");
      config.allowShell = enabled;
      saveConfig(config, configDir);
      console.log(`allowShell=${config.allowShell}`);
      return;
    }
    case "secret-shield": {
      const enabled = parseOnOff(rest[0], "secret-shield");
      config.shieldSecrets = enabled;
      saveConfig(config, configDir);
      console.log(`shieldSecrets=${config.shieldSecrets}`);
      return;
    }
    case "keep-awake": {
      const enabled = parseOnOff(rest[0], "keep-awake");
      config.keepAwake = enabled;
      saveConfig(config, configDir);
      console.log(`keepAwake=${config.keepAwake}`);
      return;
    }
    case "tunnel": {
      const mode = rest[0];
      if (mode !== "tailscale" && mode !== "quick" && mode !== "custom" && mode !== "none") {
        throw new Error(`config tunnel expects tailscale | quick | custom | none, got: ${mode ?? ""}`);
      }
      if (mode === "custom") {
        const rawUrl = rest[1] ?? config.publicUrl;
        if (!rawUrl) {
          throw new Error("config tunnel custom requires an HTTPS URL argument");
        }
        const norm = normalizeCustomPublicUrl(rawUrl);
        if (!norm.ok) throw new Error(norm.error);
        config.tunnelMode = "custom";
        config.publicUrl = norm.url;
      } else {
        config.tunnelMode = mode;
        config.publicUrl = undefined;
      }
      saveConfig(config, configDir);
      console.log(`tunnelMode=${config.tunnelMode}${config.publicUrl ? ` (${config.publicUrl})` : ""}`);
      return;
    }
    default:
      throw new Error(
        `Unknown config action "${action}". Expected get, add-root, remove-root, read-only, shell, secret-shield, keep-awake, or tunnel.`,
      );
  }
}

function runServiceCommand(parsed: ParsedArgs): void {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const config = applyOverrides(loadConfig(configDir), parsed);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const action = parsed.subArgs[0] ?? "status";

  if (action === "install") {
    const mode = parsed.tunnel ?? config.tunnelMode ?? (config.publicUrl ? "custom" : "tailscale");
    if (mode === "quick") {
      console.log(
        "[주의] Cloudflare Quick Tunnel은 재시작할 때마다 URL이 바뀝니다. 상시 자동 실행에는 Tailscale Funnel (`bun run config tunnel tailscale`)을 권장합니다.",
      );
    }
    if (!existsSync(getConfigPath(configDir))) {
      if (parsed.roots.length === 0) {
        config.roots = normalizeRoots([pickDefaultRoot()]);
      }
      saveConfig(config, configDir);
    }
    new OAuthServer(configDir, config);

    const status = installBackgroundService({
      projectRoot,
      configDir,
      port: config.port,
      tunnelMode: mode,
      publicUrl: config.publicUrl,
      profile: parsed.profile,
    });
    const serviceLabel =
      status.kind === "launchagent"
        ? "macOS LaunchAgent"
        : status.kind === "systemd"
          ? "Linux systemd user service"
          : status.kind === "windows-startup"
            ? "Windows Startup launcher"
            : "백그라운드 서비스";
    console.log(`${serviceLabel} 등록 완료.`);
    console.log(`  Label:      ${status.label}`);
    console.log(`  Service:    ${status.servicePath}`);
    console.log(`  Active:     ${status.loaded}`);
    console.log(`  Stdout Log: ${status.stdoutLogPath}`);
    console.log(`  Stderr Log: ${status.stderrLogPath}`);
    return;
  }

  if (action === "uninstall") {
    const { removed, status } = uninstallBackgroundService({
      configDir,
      profile: parsed.profile,
    });
    console.log(
      removed
        ? `백그라운드 서비스 제거 완료 (${status.servicePath})`
        : `등록된 서비스 파일이 없습니다 (${status.servicePath})`,
    );
    return;
  }

  if (action === "status") {
    const status = getBackgroundServiceStatus({
      configDir,
      profile: parsed.profile,
    });
    const lockInfo = readInstanceLock(configDir);
    console.log(`Platform / Type:   ${process.platform} (${status.kind})`);
    console.log(`Supported:         ${status.supported}`);
    console.log(`Label:             ${status.label}`);
    console.log(`Installed:         ${status.installed} (${status.servicePath})`);
    console.log(`Active / Loaded:   ${status.loaded}`);
    console.log(
      `Running Instance:  ${lockInfo.running ? `PID ${lockInfo.record?.pid} · ${lockInfo.record?.localBaseUrl ?? ""}` : "not running"}`,
    );
    const tail = readServiceLogTail(status.stdoutLogPath, 15);
    if (tail) {
      console.log("\n--- Recent stdout log ---");
      console.log(tail);
    }
    return;
  }

  throw new Error(`Unknown service action "${action}". Expected install, uninstall, or status.`);
}

async function runServe(parsed: ParsedArgs, options: { copyMcpUrl?: boolean } = {}): Promise<void> {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const hasConfig = existsSync(getConfigPath(configDir));
  const hasState = existsSync(join(configDir, "state.json"));
  const baseConfig = loadConfig(configDir);
  let effectiveConfig = applyOverrides(baseConfig, parsed);
  if (!hasConfig && parsed.roots.length === 0) {
    effectiveConfig.roots = normalizeRoots([pickDefaultRoot()]);
  }

  let plan: ResolvedTunnelPlan;
  let shouldSaveConfig = !hasConfig;

  if (parsed.tunnel === "tailscale") {
    plan = {
      mode: "tailscale",
      httpsPort: parsed.funnelPort ?? effectiveConfig.tailscaleFunnelPort ?? 443,
    };
  } else if (parsed.tunnel === "quick") {
    plan = { mode: "quick" };
  } else if (parsed.tunnel === "none") {
    if (parsed.publicUrl) {
      const normalized = normalizeCustomPublicUrl(parsed.publicUrl);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      effectiveConfig.publicUrl = normalized.url;
      plan = { mode: "custom", publicUrl: normalized.url };
    } else {
      plan = { mode: "none" };
    }
  } else if (parsed.publicUrl) {
    const normalized = normalizeCustomPublicUrl(parsed.publicUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    effectiveConfig.publicUrl = normalized.url;
    plan = { mode: "custom", publicUrl: normalized.url };
  } else {
    const shouldPrompt = !parsed.noPrompt && (
      parsed.choose
      || process.env.GEMINATION_FORCE_PROMPT === "1"
      || (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))
    );

    if (shouldPrompt) {
      const funnelPort = parsed.funnelPort ?? effectiveConfig.tailscaleFunnelPort ?? 443;
      const tailscale = inspectTailscaleStatus(funnelPort);
      const cloudflaredBinary = findCloudflaredBinary();
      const selection = await promptTunnelSelection({
        config: effectiveConfig,
        tailscale,
        cloudflaredBinary,
        funnelPort,
      });
      if (selection.cancelled) {
        console.log("실행을 취소했습니다.");
        return;
      }
      if (selection.updatedConfig) {
        effectiveConfig = applyOverrides(selection.updatedConfig, parsed);
      }
      shouldSaveConfig = true;
      if (selection.mode === "tailscale") {
        effectiveConfig.tunnelMode = "tailscale";
        effectiveConfig.tailscaleFunnelPort = selection.httpsPort;
        effectiveConfig.publicUrl = undefined;
        plan = { mode: "tailscale", httpsPort: selection.httpsPort };
      } else if (selection.mode === "quick") {
        effectiveConfig.tunnelMode = "quick";
        effectiveConfig.publicUrl = undefined;
        plan = { mode: "quick" };
      } else if (selection.mode === "custom") {
        effectiveConfig.tunnelMode = "custom";
        effectiveConfig.publicUrl = selection.publicUrl;
        plan = { mode: "custom", publicUrl: selection.publicUrl };
      } else {
        effectiveConfig.tunnelMode = "none";
        effectiveConfig.publicUrl = undefined;
        plan = { mode: "none" };
      }
    } else if (effectiveConfig.tunnelMode === "tailscale") {
      plan = {
        mode: "tailscale",
        httpsPort: parsed.funnelPort ?? effectiveConfig.tailscaleFunnelPort ?? 443,
      };
    } else if (effectiveConfig.tunnelMode === "none") {
      plan = { mode: "none" };
    } else if (effectiveConfig.tunnelMode === "custom" && effectiveConfig.publicUrl) {
      plan = { mode: "custom", publicUrl: effectiveConfig.publicUrl };
    } else if (effectiveConfig.tunnelMode === "quick") {
      plan = { mode: "quick" };
    } else if (effectiveConfig.publicUrl) {
      plan = { mode: "custom", publicUrl: effectiveConfig.publicUrl };
    } else {
      plan = { mode: "quick" };
    }
  }

  const portResolution = await resolveServePort(effectiveConfig.port);
  if (portResolution.switchedFrom !== undefined) {
    console.log(
      `[안내] 포트 ${portResolution.switchedFrom}이 이미 사용 중이어서 포트 ${portResolution.port}로 자동 전환했습니다.`,
    );
  }
  const preferredUiPort = effectiveConfig.port === 0 ? 0 : portResolution.port + 1;
  const uiPortResolution = await resolveServePort(preferredUiPort, portResolution.port);

  const lockHandle = acquireInstanceLock(configDir, {
    port: portResolution.port,
    tunnelMode: plan.mode,
  });

  const persistedPort = hasConfig
    ? baseConfig.port
    : parsed.port && parsed.port > 0
      ? parsed.port
      : DEFAULT_PORT;

  if (shouldSaveConfig) {
    saveConfig({ ...effectiveConfig, port: persistedPort }, configDir);
  }

  const runtimeConfig: GeminationConfig = {
    ...effectiveConfig,
    port: portResolution.port,
  };

  const oauth = new OAuthServer(configDir, runtimeConfig);
  const shouldShowFreshPin = !hasState || parsed.resetPin || (plan.mode === "quick" && !process.env.GEMINATION_PIN);
  const initialPin = shouldShowFreshPin ? oauth.resetPin() : undefined;
  const audit = new AuditLogger(configDir);
  const processManager = new ProcessManager();
  const keepAwake = createKeepAwakeController(runtimeConfig.keepAwake && !parsed.noCaffeinate);

  const serverHandle = startGeminationHttpServer({
    config: runtimeConfig,
    configDir,
    oauth,
    audit,
    processManager,
    uiPort: uiPortResolution.port,
    persistedPort,
    keepAwakeController: keepAwake,
    runtimeMeta: {
      tunnelMode: plan.mode,
      keepAwake: keepAwake.isActive(),
      initialPin,
      profile: parsed.profile,
    },
  });

  const tunnelController = new TunnelController({
    config: runtimeConfig,
    configDir,
    serverHandle,
    onPersistConfig: () => saveConfig({ ...runtimeConfig, port: persistedPort }, configDir),
    onStateChange: (snap) => {
      lockHandle.update({
        publicBaseUrl: snap.publicUrl ?? serverHandle.localBaseUrl,
        tunnelMode: snap.mode,
      });
    },
  });
  serverHandle.setTunnelController(tunnelController);

  lockHandle.update({
    port: serverHandle.port,
    localBaseUrl: serverHandle.localBaseUrl,
    studioBaseUrl: serverHandle.studioBaseUrl,
  });

  let shuttingDown = false;
  let detachHotkeys = () => {};

  const shutdown = async (signalName: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    detachHotkeys();
    console.log(`\nReceived ${signalName}, shutting down...`);
    keepAwake.stop();
    processManager.stopAll();
    await tunnelController.stop().catch(() => {});
    await serverHandle.stop();
    lockHandle.release();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (plan.mode === "quick") {
    console.log(`Starting Cloudflare Quick Tunnel -> ${serverHandle.localBaseUrl} ...`);
  } else if (plan.mode === "tailscale") {
    console.log(`Starting Tailscale Funnel (HTTPS :${plan.httpsPort}) -> ${serverHandle.localBaseUrl} ...`);
  }

  let probeResult: PublicProbeResult | undefined;
  try {
    const tSnap = await tunnelController.start({
      mode: plan.mode,
      publicUrl: plan.mode === "custom" ? plan.publicUrl : undefined,
      httpsPort: plan.mode === "tailscale" ? plan.httpsPort : undefined,
      skipProbe: parsed.noProbe,
      persist: false,
      openEnableUrl: Boolean(process.stdin.isTTY),
      skipPinRotate: Boolean(initialPin),
    });
    probeResult = tSnap.probeStatus;
  } catch (err) {
    keepAwake.stop();
    processManager.stopAll();
    await tunnelController.stop().catch(() => {});
    await serverHandle.stop();
    lockHandle.release();
    throw err;
  }

  const publicBase = serverHandle.getPublicBaseUrl();
  const mcpUrl = `${publicBase}/mcp`;
  lockHandle.update({
    publicBaseUrl: publicBase,
    tunnelMode: plan.mode,
  });

  const summary = oauth.getSummary();
  const copied =
    options.copyMcpUrl && !parsed.noCopy && process.env.CI !== "1" && process.env.CI !== "true"
      ? tryCopyToClipboard(mcpUrl)
      : false;
  const isServiceMode = process.env.GEMINATION_SERVICE_MODE === "1";

  console.log("");
  console.log("============================================================");
  console.log(" Gemination MCP Server Ready");
  console.log("============================================================");
  if (parsed.profile) {
    console.log(` Profile:             ${parsed.profile}`);
  }
  console.log(` Tunnel Mode:         ${formatTunnelModeLabel(plan)}`);
  console.log(` Local MCP Server:    ${serverHandle.localBaseUrl}`);
  console.log(` Local Studio UI:     ${serverHandle.studioBaseUrl}/  (로컬 전용 관리 UI)`);
  console.log(` Public Base URL:     ${publicBase}`);
  console.log(` Gemini MCP URL:      ${mcpUrl}${copied ? "  (클립보드에 복사됨)" : ""}`);
  if (probeResult && !probeResult.skipped) {
    console.log(` External Probe:      [${probeResult.ok ? "OK" : "WARN"}] ${probeResult.detail}`);
  }
  console.log(` Allowed Roots:       ${runtimeConfig.roots.join(", ")}`);
  console.log(` Permissions:         ${formatPermissionPresetLabel(runtimeConfig)}`);
  console.log(` Keep Awake:          ${keepAwake.isActive() ? `ON (${keepAwake.getBackend()} 활성)` : "OFF"}`);
  const activePin = serverHandle.getLatestPin();
  if (!isServiceMode) {
    if (activePin) {
      console.log(` Approval Code:       ${activePin}`);
    } else if (process.env.GEMINATION_PIN) {
      console.log(" Approval Code:       (using GEMINATION_PIN from environment)");
    } else {
      console.log(" Approval Code:       (기존 PIN 유지됨 · 실행 중 `p` 키 또는 대시보드에서 재발급 가능)");
    }
  }
  if (summary.staticClientId) {
    console.log(` Static Client ID:    ${summary.staticClientId}`);
  }
  if (plan.mode === "quick") {
    console.log("");
    console.log(" [!] Quick Tunnel 안내 (중요):");
    console.log("     서버를 껐다 켜면 trycloudflare.com URL이 새로 발급됩니다.");
    console.log("     재시작할 때마다 gemini.google.com 커넥터 URL을 다시 등록해야 합니다.");
    console.log("     고정 주소를 원하시면 다음 실행 시 [1] Tailscale Funnel을 선택하세요.");
  } else if (plan.mode === "tailscale") {
    console.log("");
    console.log(" [i] Tailscale Funnel 고정 주소:");
    console.log("     이 주소는 서버를 껐다 켜도 바뀌지 않으므로 gemini.google.com에 한 번만 등록하면 됩니다.");
  }
  console.log("");
  console.log(" Gemini Web 연결 방법 (gemini.google.com):");
  console.log("   1. 왼쪽 메뉴 -> Customize (맞춤설정) -> Connectors (커넥터) -> + Custom");
  console.log(`   2. MCP Server URL 입력: ${mcpUrl}`);
  console.log("   3. Client ID / Secret 은 비워두고 Next -> Connect 클릭");
  console.log("   4. 열리는 승인 페이지에 위 Local Owner Approval Code 입력 후 Approve 클릭");
  console.log("   * 참고: 한국 리전 등 웹 맞춤 앱 미지원 시 -> bun run connect gemini-cli (터널 불필요)");
  console.log("============================================================");
  if (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)) {
    console.log(" 단축키: [c] URL 복사 | [p] 새 PIN 발급 | [d] Studio UI 열기 | [g] Gemini 열기 | [r] 토큰 즉시 폐기 | [q/Ctrl+C] 종료");
  }
  console.log(" Press Ctrl+C to stop.");

  if (parsed.openDashboard) {
    openInBrowser(`${serverHandle.studioBaseUrl}/`);
  }

  detachHotkeys = attachRuntimeHotkeys({
    onCopyUrl: () => {
      const currentMcpUrl = `${serverHandle.getPublicBaseUrl()}/mcp`;
      const ok = tryCopyToClipboard(currentMcpUrl);
      console.log(ok ? `[복사됨] ${currentMcpUrl}` : `[안내] MCP URL: ${currentMcpUrl}`);
    },
    onRotatePin: () => {
      const nextPin = serverHandle.rotatePin();
      const ok = tryCopyToClipboard(nextPin);
      console.log(`[새 PIN 발급] ${nextPin}${ok ? " (클립보드에 복사됨)" : ""}`);
    },
    onOpenDashboard: () => {
      const opened = openInBrowser(`${serverHandle.studioBaseUrl}/`);
      console.log(opened ? `[Studio UI 열기] ${serverHandle.studioBaseUrl}/` : `${serverHandle.studioBaseUrl}/`);
    },
    onOpenGemini: () => {
      const opened = openInBrowser(GEMINI_WEB_URL);
      console.log(opened ? `[Gemini Web 열기] ${GEMINI_WEB_URL}` : GEMINI_WEB_URL);
    },
    onRevokeAll: () => {
      const revoked = oauth.revokeAllTokens();
      console.log(`[비상 차단] 모든 OAuth 토큰 ${revoked}건을 즉시 폐기했습니다.`);
    },
    onQuit: () => {
      void shutdown("hotkey q");
    },
  });

  await new Promise<void>(() => {
    // Keep server process alive until SIGINT/SIGTERM/quit.
  });
}

function runCredentials(parsed: ParsedArgs): void {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const config = loadConfig(configDir);
  const oauth = new OAuthServer(configDir, config);

  if (parsed.rotatePin) {
    const newPin = oauth.resetPin();
    console.log(`New Owner Approval Code: ${newPin}`);
  }
  if (parsed.rotateStaticClient) {
    const creds = oauth.rotateStaticClient();
    console.log(`New Static Client ID:     ${creds.clientId}`);
    console.log(`New Static Client Secret: ${creds.clientSecret}`);
  }

  const summary = oauth.getSummary();
  console.log(`Config directory:         ${configDir}`);
  console.log(`Registered OAuth clients: ${summary.clientCount}`);
  console.log(`Active tokens:            ${summary.activeTokenCount}`);
  console.log(`Static Client ID:         ${summary.staticClientId ?? "(none)"}`);
}

function runRevoke(parsed: ParsedArgs): void {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const config = loadConfig(configDir);
  const oauth = new OAuthServer(configDir, config);
  const count = oauth.revokeAllTokens();
  console.log(`Revoked ${count} stored token record(s).`);
}

async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const configPath = getConfigPath(configDir);
  const config = loadConfig(configDir);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const uiMeta = getPlatformUiMeta();
  checks.push({ name: "platform", ok: true, detail: `${uiMeta.platform} (${process.arch}) — ${uiMeta.serviceTitle}` });
  checks.push({ name: "bun", ok: true, detail: Bun.version });
  const tailscaleBinary = findTailscaleBinary();
  const tsStatus = inspectTailscaleStatus(
    parsed.funnelPort ?? config.tailscaleFunnelPort ?? 443,
    tailscaleBinary,
  );
  checks.push({
    name: "tailscale",
    ok: tsStatus.running && Boolean(tsStatus.dnsName),
    detail: tsStatus.binary ? `${tsStatus.detail} (${tsStatus.binary})` : tsStatus.detail,
  });
  const cloudflared = findCloudflaredBinary();
  checks.push({
    name: "cloudflared",
    ok: Boolean(cloudflared),
    detail: cloudflared ?? `missing (optional — only needed for Cloudflare Quick Tunnel; ${getTunnelInstallHint("cloudflared")})`,
  });
  if (process.platform === "darwin") {
    const caffeinate = Bun.which("caffeinate");
    checks.push({
      name: "keep-awake (caffeinate)",
      ok: Boolean(caffeinate),
      detail: caffeinate ?? "not found",
    });
  } else if (process.platform === "linux") {
    const inhibit = Bun.which("systemd-inhibit");
    checks.push({
      name: "keep-awake (systemd-inhibit)",
      ok: true,
      detail: inhibit ?? "not found (optional — sleep inhibition disabled when absent)",
    });
  } else if (process.platform === "win32") {
    const ps =
      Bun.which("powershell.exe")
      || Bun.which("pwsh.exe")
      || (existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : null);
    checks.push({
      name: "keep-awake (SetThreadExecutionState)",
      ok: Boolean(ps),
      detail: ps ?? "PowerShell not found on PATH",
    });
  }
  const rg = Bun.which("rg");
  checks.push({
    name: "ripgrep (rg)",
    ok: true,
    detail: rg ?? "not installed (pure-TS fallback active)",
  });
  const git = Bun.which("git");
  checks.push({
    name: "git",
    ok: Boolean(git),
    detail: git ?? "missing",
  });
  checks.push({
    name: "config",
    ok: true,
    detail: existsSync(configPath)
      ? `${configPath} (${formatPermissionPresetLabel(config)})`
      : `not initialized yet (defaults apply; run \`bun run setup\` or \`bun run up\`)`,
  });

  const lockStatus = readInstanceLock(configDir);
  checks.push({
    name: "instance",
    ok: true,
    detail: lockStatus.running
      ? `running (PID ${lockStatus.record?.pid} · ${lockStatus.record?.localBaseUrl ?? ""})`
      : "not currently running",
  });

  let rootsOk = true;
  for (const root of config.roots) {
    if (!existsSync(root)) rootsOk = false;
  }
  checks.push({
    name: "workspace roots",
    ok: rootsOk,
    detail: config.roots.join(", "),
  });

  const portOk = await isPortAvailable(config.port);
  checks.push({
    name: `port ${config.port}`,
    ok: portOk,
    detail: portOk ? "available" : "currently in use (`up`/`serve` will auto-shift if needed)",
  });

  let fatal = false;
  for (const item of checks) {
    const marker = item.ok ? "[OK]" : "[WARN]";
    console.log(`${marker} ${item.name}: ${item.detail}`);
    if (!item.ok && item.name === "workspace roots") fatal = true;
  }

  if (fatal) {
    process.exitCode = 1;
  }
}

async function runGui(parsed: ParsedArgs): Promise<void> {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const existingLock = readInstanceLock(configDir);
  const existingUrl = existingLock.record?.studioBaseUrl ?? existingLock.record?.localBaseUrl;
  if (existingLock.running && existingUrl && /^http:\/\/127\.0\.0\.1:\d+$/.test(existingUrl)) {
    console.log(
      `[안내] Gemination이 이미 실행 중입니다 (PID ${existingLock.record!.pid}). 기존 Studio UI 창을 엽니다: ${existingUrl}/`,
    );
    openDesktopAppWindow(`${existingUrl}/`, configDir);
    return;
  }

  const hasConfig = existsSync(getConfigPath(configDir));
  const hasState = existsSync(join(configDir, "state.json"));
  const baseConfig = loadConfig(configDir);
  const effectiveConfig = applyOverrides(baseConfig, parsed);
  if (!hasConfig && parsed.roots.length === 0) {
    effectiveConfig.roots = normalizeRoots([pickDefaultRoot()]);
  }

  const portResolution = await resolveServePort(effectiveConfig.port);
  if (portResolution.switchedFrom !== undefined) {
    console.log(
      `[안내] 포트 ${portResolution.switchedFrom}이 이미 사용 중이어서 포트 ${portResolution.port}로 자동 전환했습니다.`,
    );
  }
  const preferredUiPort = effectiveConfig.port === 0 ? 0 : portResolution.port + 1;
  const uiPortResolution = await resolveServePort(preferredUiPort, portResolution.port);

  const lockHandle = acquireInstanceLock(configDir, {
    port: portResolution.port,
    tunnelMode: effectiveConfig.tunnelMode ?? "none",
  });

  const persistedPort = hasConfig
    ? baseConfig.port
    : parsed.port && parsed.port > 0
      ? parsed.port
      : DEFAULT_PORT;

  if (!hasConfig) {
    saveConfig({ ...effectiveConfig, port: persistedPort }, configDir);
  }

  const runtimeConfig: GeminationConfig = {
    ...effectiveConfig,
    port: portResolution.port,
  };

  const oauth = new OAuthServer(configDir, runtimeConfig);
  const initialPin = !hasState || parsed.resetPin ? oauth.resetPin() : undefined;
  const audit = new AuditLogger(configDir);
  const processManager = new ProcessManager();
  const keepAwake = createKeepAwakeController(runtimeConfig.keepAwake && !parsed.noCaffeinate);

  const serverHandle = startGeminationHttpServer({
    config: runtimeConfig,
    configDir,
    oauth,
    audit,
    processManager,
    uiPort: uiPortResolution.port,
    persistedPort,
    keepAwakeController: keepAwake,
    runtimeMeta: {
      tunnelMode: parsed.tunnel ?? runtimeConfig.tunnelMode ?? "none",
      keepAwake: keepAwake.isActive(),
      initialPin,
      profile: parsed.profile,
    },
  });

  const tunnelController = new TunnelController({
    config: runtimeConfig,
    configDir,
    serverHandle,
    onPersistConfig: () => saveConfig({ ...runtimeConfig, port: persistedPort }, configDir),
    onStateChange: (snap) => {
      lockHandle.update({
        publicBaseUrl: snap.publicUrl ?? serverHandle.localBaseUrl,
        tunnelMode: snap.mode,
      });
    },
  });
  serverHandle.setTunnelController(tunnelController);

  lockHandle.update({
    port: serverHandle.port,
    localBaseUrl: serverHandle.localBaseUrl,
    studioBaseUrl: serverHandle.studioBaseUrl,
  });

  let shuttingDown = false;
  const shutdown = async (signalName: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signalName}, shutting down Gemination Studio...`);
    keepAwake.stop();
    processManager.stopAll();
    await tunnelController.stop().catch(() => {});
    await serverHandle.stop();
    lockHandle.release();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    if (parsed.tunnel || parsed.publicUrl) {
      const startMode = parsed.tunnel ?? "custom";
      try {
        await tunnelController.start({
          mode: startMode,
          publicUrl: parsed.publicUrl ?? runtimeConfig.publicUrl,
          httpsPort: parsed.funnelPort ?? runtimeConfig.tailscaleFunnelPort ?? 443,
          skipProbe: parsed.noProbe,
          persist: false,
          openEnableUrl: true,
          skipPinRotate: Boolean(initialPin),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[경고] 초기 터널 연결에 실패했지만 Studio UI를 계속 실행합니다: ${msg}`);
      }
    }

    const appUrl = `${serverHandle.studioBaseUrl}/`;
    const launched = openDesktopAppWindow(appUrl, configDir);

    const autoReconnectAllowed =
      !parsed.tunnel
      && !parsed.publicUrl
      && hasConfig
      && process.env.GEMINATION_NO_AUTO_TUNNEL !== "1"
      && process.env.CI !== "1"
      && process.env.CI !== "true"
      && (runtimeConfig.tunnelMode === "tailscale"
        || (runtimeConfig.tunnelMode === "custom" && Boolean(runtimeConfig.publicUrl)));

    if (autoReconnectAllowed && runtimeConfig.tunnelMode) {
      void tunnelController
        .start({
          mode: runtimeConfig.tunnelMode,
          publicUrl: runtimeConfig.publicUrl,
          httpsPort: runtimeConfig.tailscaleFunnelPort ?? 443,
          skipProbe: parsed.noProbe,
          persist: false,
          openEnableUrl: true,
          skipPinRotate: true,
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[경고] 저장된 터널 자동 재연결 실패 (Studio UI에서 다시 연결 가능): ${msg}`);
        });
    }

    console.log("============================================================");
    console.log(" Gemination Studio GUI Ready");
    console.log("============================================================");
    console.log(` Studio UI URL:  ${appUrl} (${launched.mode})`);
    console.log(` Local MCP URL:  ${serverHandle.localBaseUrl}/mcp`);
    console.log(` Allowed Roots:  ${runtimeConfig.roots.join(", ")}`);
    const activePin = serverHandle.getLatestPin();
    if (activePin && process.env.GEMINATION_SERVICE_MODE !== "1") {
      console.log(` Approval Code:  ${activePin}`);
    }
    console.log(" Press Ctrl+C to stop.");

    await new Promise<void>(() => {
      // Keep GUI backend alive until SIGINT/SIGTERM.
    });
  } catch (err) {
    keepAwake.stop();
    processManager.stopAll();
    await tunnelController.stop().catch(() => {});
    await serverHandle.stop();
    lockHandle.release();
    throw err;
  }
}

async function runStdio(parsed: ParsedArgs): Promise<void> {
  // CRITICAL: stdout is exclusively reserved for MCP JSON-RPC frames. Never call console.log here.
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const hasConfig = existsSync(getConfigPath(configDir));
  const baseConfig = loadConfig(configDir);
  const config = applyOverrides(baseConfig, parsed);
  if (!hasConfig && parsed.roots.length === 0) {
    config.roots = normalizeRoots([pickDefaultRoot()]);
  }

  const audit = new AuditLogger(configDir);
  const processManager = new ProcessManager();
  const mcpServer = createGeminationMcpServer({
    config,
    configDir,
    defaultCwd: config.roots[0] ?? process.cwd(),
    audit,
    processManager,
  });
  const transport = new StdioServerTransport();

  let cleanedUp = false;
  const cleanup = async (exitAfter = false): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    processManager.stopAll();
    try {
      await mcpServer.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    if (exitAfter) {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void cleanup(true));
  process.on("SIGTERM", () => void cleanup(true));
  process.stdin.on("end", () => void cleanup(false));

  await mcpServer.connect(transport);
}

function runConnectCommand(parsed: ParsedArgs): void {
  const configDir = resolveConfigDir({ configDir: parsed.configDir, profile: parsed.profile });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const arg0 = parsed.subArgs[0];
  const arg1 = parsed.subArgs[1];

  if (arg0 === "snippet") {
    const { snippetJson } = detectLocalClients(projectRoot, configDir);
    process.stdout.write(snippetJson);
    return;
  }

  if (!arg0 || arg0 === "status") {
    const { clients, snippetJson } = detectLocalClients(projectRoot, configDir);
    console.log("============================================================");
    console.log(" Gemination 로컬 MCP 클라이언트 연동 (터널 · 웹 맞춤 앱 불필요)");
    console.log("============================================================");
    console.log(" * gemini.google.com '맞춤 앱'은 현재 미국/영어 계정 제한이 있어");
    console.log("   한국 리전에서는 아래 로컬 클라이언트(stdio MCP) 연동을 권장합니다.");
    console.log("");
    for (const c of clients) {
      const regText = c.registered ? (c.upToDate ? "등록됨 (최신)" : "등록됨 (경로 갱신 권장)") : "미등록";
      const cliNote =
        c.id === "gemini-cli"
          ? ` | CLI: ${c.cliInstalled ? c.cliBinary : `미설치 (${c.installCommand})`}`
          : "";
      console.log(` - ${c.id.padEnd(14)} ${regText}${cliNote}`);
      console.log(`   설정 파일: ${c.configPath}`);
    }
    console.log("");
    console.log("등록 예시:");
    console.log("  bun run connect gemini-cli       # 한국 리전 Google 계정 로그인 Gemini CLI");
    console.log("  bun run connect claude-desktop   # Claude Desktop");
    console.log("  bun run connect cursor           # Cursor IDE");
    console.log("");
    console.log("기타 MCP 클라이언트(VS Code / Antigravity 등)용 JSON:");
    console.log(snippetJson.trimEnd());
    return;
  }

  if (arg0 === "remove" || parsed.subArgs.includes("--remove")) {
    const target = arg0 === "remove" ? arg1 : arg0;
    if (!isLocalMcpClientId(target)) {
      throw new Error(`지원하지 않는 클라이언트입니다: ${target ?? "(none)"} (gemini-cli | claude-desktop | cursor)`);
    }
    const res = unregisterLocalClient(target);
    console.log(
      res.removed
        ? `Gemination 등록을 해제했습니다: ${res.configPath}`
        : `등록된 Gemination 항목이 없습니다: ${res.configPath}`,
    );
    return;
  }

  if (!isLocalMcpClientId(arg0)) {
    throw new Error(
      `알 수 없는 connect 대상 "${arg0}". status, snippet, gemini-cli, claude-desktop, cursor, remove 중 하나를 사용하세요.`,
    );
  }

  if (!existsSync(getConfigPath(configDir))) {
    const cfg = applyOverrides(loadConfig(configDir), parsed);
    if (parsed.roots.length === 0) {
      cfg.roots = normalizeRoots([pickDefaultRoot()]);
    }
    saveConfig(cfg, configDir);
  }

  const res = registerLocalClient(arg0, projectRoot, configDir);
  console.log(`[완료] ${arg0}에 Gemination stdio MCP를 등록했습니다.`);
  console.log(`  설정 파일: ${res.configPath}`);
  if (res.backupPath) {
    console.log(`  기존 백업: ${res.backupPath}`);
  }
  console.log(`  Perm Roots: ${loadConfig(configDir).roots.join(", ")}`);
  if (arg0 === "gemini-cli") {
    console.log("");
    console.log("다음 단계:");
    if (!Bun.which("gemini")) {
      console.log("  1. Gemini CLI 설치: npm install -g @google/gemini-cli");
      console.log("  2. 터미널에서 `gemini` 실행 후 개인 Google 계정으로 로그인");
    } else {
      console.log("  1. 터미널에서 `gemini` 실행 후 개인 Google 계정으로 로그인");
    }
    console.log("  3. Gemini CLI 안에서 `/mcp` 입력해 `gemination` 도구 12종 연결 확인");
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help || parsed.command === "help") {
    printHelp();
    return;
  }

  switch (parsed.command) {
    case "gui":
      await runGui(parsed);
      break;
    case "up":
      await runServe(parsed, { copyMcpUrl: true });
      break;
    case "stdio":
      await runStdio(parsed);
      break;
    case "connect":
      runConnectCommand(parsed);
      break;
    case "setup":
      await runSetup(parsed);
      break;
    case "init":
      await runInit(parsed);
      break;
    case "serve":
      await runServe(parsed);
      break;
    case "config":
      runConfigCommand(parsed);
      break;
    case "service":
      runServiceCommand(parsed);
      break;
    case "credentials":
      runCredentials(parsed);
      break;
    case "revoke":
      runRevoke(parsed);
      break;
    case "doctor":
      await runDoctor(parsed);
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}. Run with --help for usage.`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
