import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GeminationConfig, TailscaleFunnelPort, TunnelMode } from "./types.ts";

export const DEFAULT_PORT = 3847;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

export function getConfigDir(overrideDir?: string): string {
  const trimmedOverride = overrideDir?.trim();
  const trimmedEnv = process.env.GEMINATION_CONFIG_DIR?.trim();
  const rawExplicit = trimmedOverride || trimmedEnv;
  if (rawExplicit) {
    const lower = rawExplicit.toLowerCase();
    if (lower === "undefined" || lower === "null") {
      throw new Error(`Invalid config directory value "${rawExplicit}". Pass a valid filesystem path.`);
    }
    return resolve(expandTilde(rawExplicit));
  }
  return resolve(join(homedir(), ".config", "gemination"));
}

export function resolveConfigDir(options: { configDir?: string; profile?: string } = {}): string {
  if (options.configDir && options.profile) {
    throw new Error("--config-dir and --profile cannot be used together; choose only one.");
  }
  if (options.profile !== undefined) {
    const trimmed = options.profile.trim();
    if (!PROFILE_NAME_RE.test(trimmed) || trimmed.includes("..")) {
      throw new Error(
        `Invalid --profile name "${options.profile}". Use 1-48 alphanumeric, '.', '_', or '-' characters starting with a letter or digit.`,
      );
    }
    return join(getConfigDir(), "profiles", trimmed);
  }
  return getConfigDir(options.configDir);
}

export function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

export function ensureDirSecure(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod failures on filesystems that don't support POSIX modes.
  }
}

export function atomicWriteFile(filePath: string, content: string | Uint8Array, mode = 0o600): void {
  const parent = dirname(filePath);
  ensureDirSecure(parent);
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmpPath, content, { mode });
  try {
    chmodSync(tmpPath, mode);
  } catch {
    // Ignore on non-POSIX filesystems.
  }
  renameSync(tmpPath, filePath);
}

export function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const raw of roots) {
    const expanded = resolve(expandTilde(raw.trim()));
    if (!expanded) continue;
    let canonical = expanded;
    try {
      canonical = realpathSync(expanded);
    } catch {
      // Keep resolved path if directory doesn't exist yet; doctor/tools validate existence.
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      resolved.push(canonical);
    }
  }
  return resolved;
}

export function defaultConfig(): GeminationConfig {
  return {
    port: DEFAULT_PORT,
    host: "127.0.0.1",
    roots: normalizeRoots([process.cwd()]),
    allowShell: true,
    allowWrite: true,
    shieldSecrets: true,
    keepAwake: true,
    extraRedirectHosts: [],
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
}

export function getConfigPath(configDir?: string): string {
  return join(getConfigDir(configDir), "config.json");
}

function parseTunnelMode(value: unknown): TunnelMode | undefined {
  if (value === "tailscale" || value === "quick" || value === "custom" || value === "none") {
    return value;
  }
  return undefined;
}

function parseTailscaleFunnelPort(value: unknown): TailscaleFunnelPort | undefined {
  if (value === 443 || value === 8443 || value === 10000) {
    return value;
  }
  return undefined;
}

export function loadConfig(configDir?: string): GeminationConfig {
  const path = getConfigPath(configDir);
  const base = defaultConfig();
  if (!existsSync(path)) {
    return base;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GeminationConfig>;
  const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535
    ? raw.port
    : base.port;
  const roots = Array.isArray(raw.roots) && raw.roots.length > 0
    ? normalizeRoots(raw.roots.filter((item): item is string => typeof item === "string"))
    : base.roots;
  const commandTimeoutMs = typeof raw.commandTimeoutMs === "number" && raw.commandTimeoutMs > 0
    ? Math.min(raw.commandTimeoutMs, MAX_COMMAND_TIMEOUT_MS)
    : base.commandTimeoutMs;
  const maxOutputBytes = typeof raw.maxOutputBytes === "number" && raw.maxOutputBytes >= 1024
    ? raw.maxOutputBytes
    : base.maxOutputBytes;
  const tunnelMode = parseTunnelMode(raw.tunnelMode);
  const tailscaleFunnelPort = parseTailscaleFunnelPort(raw.tailscaleFunnelPort);

  return {
    port,
    host: "127.0.0.1",
    roots: roots.length > 0 ? roots : base.roots,
    publicUrl: typeof raw.publicUrl === "string" && raw.publicUrl.trim() ? raw.publicUrl.trim().replace(/\/+$/, "") : undefined,
    tunnelMode,
    tailscaleFunnelPort,
    allowShell: typeof raw.allowShell === "boolean" ? raw.allowShell : base.allowShell,
    allowWrite: typeof raw.allowWrite === "boolean" ? raw.allowWrite : base.allowWrite,
    shieldSecrets: typeof raw.shieldSecrets === "boolean" ? raw.shieldSecrets : base.shieldSecrets,
    keepAwake: typeof raw.keepAwake === "boolean" ? raw.keepAwake : base.keepAwake,
    extraRedirectHosts: Array.isArray(raw.extraRedirectHosts)
      ? raw.extraRedirectHosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      : [],
    commandTimeoutMs,
    maxOutputBytes,
  };
}

export function saveConfig(config: GeminationConfig, configDir?: string): string {
  const path = getConfigPath(configDir);
  const normalized: GeminationConfig = {
    ...config,
    host: "127.0.0.1",
    roots: normalizeRoots(config.roots),
    publicUrl: config.publicUrl ? config.publicUrl.trim().replace(/\/+$/, "") : undefined,
    tunnelMode: parseTunnelMode(config.tunnelMode),
    tailscaleFunnelPort: parseTailscaleFunnelPort(config.tailscaleFunnelPort),
    shieldSecrets: typeof config.shieldSecrets === "boolean" ? config.shieldSecrets : true,
    keepAwake: typeof config.keepAwake === "boolean" ? config.keepAwake : true,
    commandTimeoutMs: Math.min(Math.max(1000, config.commandTimeoutMs), MAX_COMMAND_TIMEOUT_MS),
    maxOutputBytes: Math.max(1024, config.maxOutputBytes),
  };
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
  return path;
}
