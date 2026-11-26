import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type LocalMcpClientId = "gemini-cli" | "claude-desktop" | "cursor";

export interface StdioServerEntry {
  command: string;
  args: string[];
}

export interface LocalMcpClientStatus {
  id: LocalMcpClientId;
  label: string;
  configPath: string;
  cliInstalled?: boolean;
  cliBinary?: string | null;
  configExists: boolean;
  registered: boolean;
  upToDate: boolean;
  installCommand?: string;
}

export interface ClientPathOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  homeDir?: string;
  overridePath?: string;
}

const VALID_CLIENT_IDS: readonly LocalMcpClientId[] = ["gemini-cli", "claude-desktop", "cursor"];

export function isLocalMcpClientId(value: unknown): value is LocalMcpClientId {
  return typeof value === "string" && (VALID_CLIENT_IDS as readonly string[]).includes(value);
}

export function buildStdioServerEntry(
  projectRoot: string,
  configDir: string,
  options?: { bunPath?: string },
): StdioServerEntry {
  const bunPath = options?.bunPath?.trim() || process.execPath;
  const cliEntry = join(resolve(projectRoot), "src", "cli.ts");
  return {
    command: bunPath,
    args: ["run", cliEntry, "stdio", "--config-dir", resolve(configDir)],
  };
}

export function getClientConfigPath(
  clientId: LocalMcpClientId,
  options?: ClientPathOptions,
): string {
  if (options?.overridePath?.trim()) {
    return resolve(options.overridePath.trim());
  }
  const home = options?.homeDir?.trim() || homedir();
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;

  switch (clientId) {
    case "gemini-cli":
      return join(home, ".gemini", "settings.json");
    case "claude-desktop":
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
        return join(appData, "Claude", "claude_desktop_config.json");
      }
      return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "Claude", "claude_desktop_config.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
  }
}

function getClientLabel(clientId: LocalMcpClientId): string {
  switch (clientId) {
    case "gemini-cli":
      return "Gemini CLI (@google/gemini-cli)";
    case "claude-desktop":
      return "Claude Desktop";
    case "cursor":
      return "Cursor";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesEqual(a: unknown, b: StdioServerEntry): boolean {
  if (!isPlainRecord(a)) return false;
  if (a.command !== b.command) return false;
  if (!Array.isArray(a.args) || a.args.length !== b.args.length) return false;
  return a.args.every((item, idx) => item === b.args[idx]);
}

function readExistingConfigNonThrowing(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(targetPath: string, payload: unknown): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.gemination-tmp-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, targetPath);
}

export function detectLocalClients(
  projectRoot: string,
  configDir: string,
  options?: {
    env?: Record<string, string | undefined>;
    platform?: string;
    homeDir?: string;
    bunPath?: string;
    overrides?: Partial<Record<LocalMcpClientId, string>>;
  },
): {
  clients: LocalMcpClientStatus[];
  stdioEntry: StdioServerEntry;
  snippetJson: string;
} {
  const stdioEntry = buildStdioServerEntry(projectRoot, configDir, { bunPath: options?.bunPath });
  const geminiBinary = Bun.which("gemini") ?? null;

  const clients: LocalMcpClientStatus[] = VALID_CLIENT_IDS.map((id) => {
    const configPath = getClientConfigPath(id, {
      env: options?.env,
      platform: options?.platform,
      homeDir: options?.homeDir,
      overridePath: options?.overrides?.[id],
    });
    const configExists = existsSync(configPath);
    const parsed = readExistingConfigNonThrowing(configPath);
    const servers = parsed && isPlainRecord(parsed.mcpServers) ? parsed.mcpServers : null;
    const gemEntry = servers ? servers.gemination : undefined;
    const registered = Boolean(gemEntry && isPlainRecord(gemEntry));
    const upToDate = registered && entriesEqual(gemEntry, stdioEntry);

    return {
      id,
      label: getClientLabel(id),
      configPath,
      ...(id === "gemini-cli"
        ? {
            cliInstalled: Boolean(geminiBinary),
            cliBinary: geminiBinary,
            installCommand: "npm install -g @google/gemini-cli",
          }
        : {}),
      configExists,
      registered,
      upToDate,
    };
  });

  const snippetJson = `${JSON.stringify({ mcpServers: { gemination: stdioEntry } }, null, 2)}\n`;
  return { clients, stdioEntry, snippetJson };
}

export function registerLocalClient(
  clientId: LocalMcpClientId,
  projectRoot: string,
  configDir: string,
  options?: ClientPathOptions & { bunPath?: string },
): { configPath: string; backupPath?: string; entry: StdioServerEntry } {
  const configPath = getClientConfigPath(clientId, options);
  const entry = buildStdioServerEntry(projectRoot, configDir, { bunPath: options?.bunPath });

  let rootObj: Record<string, unknown> = {};
  let rawExisting: string | null = null;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `기존 설정 파일 JSON 형식이 올바르지 않아 수정하지 않았습니다 (${configPath}): ${msg}`,
        );
      }
      if (!isPlainRecord(parsed)) {
        throw new Error(`기존 설정 파일의 루트가 JSON 객체가 아닙니다 (${configPath}).`);
      }
      rootObj = { ...parsed };
      rawExisting = raw;
    }
  }

  const existingServers = rootObj.mcpServers;
  if (existingServers !== undefined && !isPlainRecord(existingServers)) {
    throw new Error(`기존 설정 파일의 mcpServers 필드가 객체가 아닙니다 (${configPath}).`);
  }

  let backupPath: string | undefined;
  if (rawExisting !== null) {
    backupPath = `${configPath}.gemination.bak`;
    writeFileSync(backupPath, rawExisting, { encoding: "utf8", mode: 0o600 });
  }

  rootObj.mcpServers = {
    ...(isPlainRecord(existingServers) ? existingServers : {}),
    gemination: entry,
  };

  writeJsonAtomic(configPath, rootObj);
  return { configPath, ...(backupPath ? { backupPath } : {}), entry };
}

export function unregisterLocalClient(
  clientId: LocalMcpClientId,
  options?: ClientPathOptions,
): { configPath: string; removed: boolean } {
  const configPath = getClientConfigPath(clientId, options);
  if (!existsSync(configPath)) {
    return { configPath, removed: false };
  }
  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`설정 파일 JSON 형식이 올바르지 않아 해제하지 않았습니다 (${configPath}): ${msg}`);
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.mcpServers)) {
    return { configPath, removed: false };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed.mcpServers, "gemination")) {
    return { configPath, removed: false };
  }

  const nextServers = { ...parsed.mcpServers };
  delete nextServers.gemination;
  const nextRoot = { ...parsed, mcpServers: nextServers };
  writeJsonAtomic(configPath, nextRoot);
  return { configPath, removed: true };
}
