import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { ensureDirSecure, expandTilde } from "./config.ts";
import { maskSecrets } from "./secrets-shield.ts";
import type { AuditEntry } from "./types.ts";

const MAX_SYMLINK_HOPS = 16;

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export function resolvePosixShell(): string {
  const candidates = [process.env.SHELL?.trim(), "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "/bin/sh";
}

export function buildSanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GEMINATION_PIN;
  delete env.GEMINATION_CONFIG_DIR;
  return env;
}

function canonicalizeIfPossible(target: string): string {
  const resolved = resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function tryLstat(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw new SecurityError(`Invalid path (${code ?? "error"}): ${target}`);
  }
}

export function isPathInside(
  candidate: string,
  parent: string,
  targetPlatform: string = process.platform,
  caseInsensitive: boolean = targetPlatform === "win32",
): boolean {
  const pathImpl = targetPlatform === "win32" ? win32 : { resolve, sep: "/" };
  let normCandidate = pathImpl.resolve(candidate);
  let normParent = pathImpl.resolve(parent);
  if (caseInsensitive) {
    normCandidate = normCandidate.toLowerCase();
    normParent = normParent.toLowerCase();
  }
  if (normCandidate === normParent) return true;
  const prefix = normParent.endsWith(pathImpl.sep) ? normParent : `${normParent}${pathImpl.sep}`;
  return normCandidate.startsWith(prefix);
}

export function getSensitiveDeniedPaths(
  configDir: string,
  targetPlatform: string = process.platform,
): string[] {
  const home = homedir();
  const candidates = [
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "gemination"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".npmrc"),
    join(home, ".netrc"),
    join(home, ".git-credentials"),
    configDir,
  ];

  if (targetPlatform === "darwin") {
    candidates.push(
      join(home, "Library", "Keychains"),
      join(home, "Library", "Application Support", "Google", "Chrome"),
      "/etc/shadow",
      "/etc/sudoers",
    );
  } else if (targetPlatform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    const appData = process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    candidates.push(
      join(localAppData, "Google", "Chrome", "User Data"),
      join(localAppData, "Microsoft", "Edge", "User Data"),
      join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      join(appData, "gemination"),
      "C:\\Windows\\System32\\config",
    );
  } else {
    candidates.push(
      join(home, ".config", "google-chrome"),
      join(home, ".config", "chromium"),
      join(home, ".local", "share", "keyrings"),
      "/etc/shadow",
      "/etc/sudoers",
    );
  }

  return [...new Set(candidates.map(canonicalizeIfPossible))];
}

export interface ResolveSafePathOptions {
  allowMissingLeaf?: boolean;
  configDir?: string;
}

function resolveTargetPath(
  absoluteTarget: string,
  originalInput: string,
  allowMissingLeaf: boolean,
  depth = 0,
): string {
  if (depth > MAX_SYMLINK_HOPS) {
    throw new SecurityError(`Too many symbolic links while resolving path: ${originalInput}`);
  }

  const directStat = tryLstat(absoluteTarget);
  if (directStat) {
    if (directStat.isSymbolicLink()) {
      const linkTarget = readlinkSync(absoluteTarget);
      const nextTarget = resolve(dirname(absoluteTarget), linkTarget);
      return resolveTargetPath(nextTarget, originalInput, allowMissingLeaf, depth + 1);
    }
    return realpathSync(absoluteTarget);
  }

  if (!allowMissingLeaf) {
    throw new SecurityError(`Path does not exist: ${originalInput}`);
  }

  const trailingSegments: string[] = [];
  let cursor = absoluteTarget;
  while (true) {
    const ancestorStat = tryLstat(cursor);
    if (ancestorStat) {
      if (ancestorStat.isSymbolicLink()) {
        const linkTarget = readlinkSync(cursor);
        const resolvedAncestor = resolve(dirname(cursor), linkTarget);
        const rejoined = trailingSegments.length > 0
          ? join(resolvedAncestor, ...trailingSegments)
          : resolvedAncestor;
        return resolveTargetPath(rejoined, originalInput, allowMissingLeaf, depth + 1);
      }
      const canonicalAncestor = realpathSync(cursor);
      return trailingSegments.length > 0
        ? join(canonicalAncestor, ...trailingSegments)
        : canonicalAncestor;
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new SecurityError(`No existing ancestor directory for path: ${absoluteTarget}`);
    }
    const segment = basename(cursor);
    if (segment === ".." || segment === ".") {
      throw new SecurityError(`Invalid path traversal segment in ${absoluteTarget}`);
    }
    trailingSegments.unshift(segment);
    cursor = parent;
  }
}

export function resolveSafePath(
  inputPath: string,
  roots: string[],
  defaultCwd: string,
  options: ResolveSafePathOptions = {},
): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new SecurityError("Path must be a non-empty string");
  }
  if (inputPath.includes("\0")) {
    throw new SecurityError("Path contains NUL byte");
  }
  if (roots.length === 0) {
    throw new SecurityError("No allowed workspace roots configured");
  }

  const expanded = expandTilde(inputPath.trim());
  const absoluteTarget = expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded)
    ? resolve(expanded)
    : resolve(defaultCwd, expanded);

  const canonicalTarget = resolveTargetPath(
    absoluteTarget,
    inputPath,
    Boolean(options.allowMissingLeaf),
  );

  const canonicalRoots = roots.map(canonicalizeIfPossible);
  const insideRoot = canonicalRoots.some((root) => isPathInside(canonicalTarget, root));
  if (!insideRoot) {
    throw new SecurityError(
      `Access denied: "${inputPath}" resolves outside allowed workspace roots (${canonicalRoots.join(", ")})`,
    );
  }

  const configDir = options.configDir ?? join(homedir(), ".config", "gemination");
  const deniedPaths = getSensitiveDeniedPaths(configDir);
  const caseInsensitiveDenied = process.platform === "win32" || process.platform === "darwin";
  for (const denied of deniedPaths) {
    if (isPathInside(canonicalTarget, denied, process.platform, caseInsensitiveDenied)) {
      throw new SecurityError(`Access denied: "${inputPath}" points to a protected path (${denied})`);
    }
  }

  return canonicalTarget;
}

const CATASTROPHIC_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(^|[;&|\s])(?:[^\s;&|]*\/)?rm\s+[^\n]*(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|-[a-zA-Z]*[rR][a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*[rR]|--recursive\b[^\n]*--force\b|--force\b[^\n]*--recursive\b)[^\n]*(\s+\/+(\*|\s|$)|["']?~\/?["']?(\s|$)|["']?\$\{?HOME\}?\/?["']?(\s|$))/,
    reason: "Catastrophic recursive delete targeting root or home directory",
  },
  {
    pattern: /(^|[;&|\s])(?:[^\s;&|]*\/)?rm\s+[^\n]*--no-preserve-root\b/,
    reason: "rm --no-preserve-root is blocked",
  },
  {
    pattern: /(^|[;&|\s])(?:[^\s;&|]*\/)?(mkfs(\.[a-z0-9]+)?|newfs_[a-z0-9]+)\b/,
    reason: "Filesystem formatting commands are blocked",
  },
  {
    pattern: /(^|[;&|\s])dd\b[^\n]*\bof=\/dev\/(disk|rdisk|sd[a-z]|nvme|hd[a-z])/,
    reason: "Raw block-device write via dd is blocked",
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: "Fork bomb pattern is blocked",
  },
  {
    pattern: /(^|[;&|\s])diskutil\s+(eraseDisk|eraseVolume|partitionDisk|zeroDisk)\b/i,
    reason: "Destructive diskutil partition/erase commands are blocked",
  },
  {
    pattern: /(^|[;&|\s])(?:Remove-Item|ri|del|rd)\b[^\n]*(?:-Recurse\b[^\n]*-Force\b|-Force\b[^\n]*-Recurse\b)[^\n]*(\s+["']?[a-zA-Z]:[/\\](\*|\s|["']|$)|["']?~[/\\]?["']?(\s|$)|\$HOME\b|\$env:USERPROFILE\b)/i,
    reason: "Destructive PowerShell recursive delete targeting root or user profile is blocked",
  },
  {
    pattern: /(^|[;&|\s])(?:Remove-Item|ri)\b[^\n]*(\s+["']?[a-zA-Z]:[/\\](\*|\s|["'])|\$env:USERPROFILE\b)[^\n]*(?:-Recurse\b[^\n]*-Force\b|-Force\b[^\n]*-Recurse\b)/i,
    reason: "Destructive PowerShell recursive delete targeting root or user profile is blocked",
  },
  {
    pattern: /(^|[;&|\s])(rd|rmdir)\s+[^\n]*(?:\/s\b[^\n]*\/q\b|\/q\b[^\n]*\/s\b)[^\n]*(\s+["']?[a-zA-Z]:[/\\](Windows\b|[/\\]|\s|["']|$)|%(USERPROFILE|SystemRoot|WINDIR)%)/i,
    reason: "Destructive cmd rd /s /q targeting drive root or system directory is blocked",
  },
  {
    pattern: /(^|[;&|\s])(format\s+[a-zA-Z]:|diskpart\b|Stop-Computer\b|Restart-Computer\b)/i,
    reason: "Destructive Windows disk or power command is blocked",
  },
];

const POWER_COMMANDS = new Set(["shutdown", "shutdown.exe", "reboot", "halt", "poweroff"]);
const SHELL_PREFIX_KEYWORDS = new Set(["then", "do", "else", "elif", "!"]);
const COMMAND_WRAPPERS = new Set(["sudo", "doas", "env", "exec", "command", "nohup", "time"]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function consumeBacktick(
  input: string,
  start: number,
  insideDoubleQuote: boolean,
): { out: string; nextIndex: number } {
  const raw: string[] = [];
  let i = start;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) {
        i += 1;
        break;
      }
      if (next === "`" || next === "\\" || next === "$" || (insideDoubleQuote && next === '"')) {
        raw.push(next);
      } else {
        raw.push("\\", next);
      }
      i += 2;
      continue;
    }
    if (ch === "`") {
      i += 1;
      break;
    }
    raw.push(ch);
    i += 1;
  }
  return { out: stripNonExecutableQuotes(raw.join("")), nextIndex: i };
}

function consumeQuoted(
  input: string,
  start: number,
  stopAtMatchingParen = false,
): { out: string; nextIndex: number } {
  const chunks: string[] = [];
  let i = start;
  let parenDepth = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (stopAtMatchingParen) {
      if (ch === "(") {
        parenDepth += 1;
        chunks.push(ch);
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (parenDepth === 0) {
          return { out: chunks.join(""), nextIndex: i + 1 };
        }
        parenDepth -= 1;
        chunks.push(ch);
        i += 1;
        continue;
      }
    }

    if (ch === "\\") {
      chunks.push(ch);
      if (i + 1 < input.length) {
        chunks.push(input[i + 1]!);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      chunks.push(" ");
      i += 1;
      while (i < input.length && input[i] !== "'") {
        i += 1;
      }
      if (i < input.length && input[i] === "'") {
        i += 1;
      }
      chunks.push(" ");
      continue;
    }

    if (ch === '"') {
      chunks.push(" ");
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const inner = input[i]!;
        if (inner === "\\") {
          i += i + 1 < input.length ? 2 : 1;
          chunks.push(" ");
          continue;
        }
        if (inner === "$" && input[i + 1] === "(") {
          const subst = consumeQuoted(input, i + 2, true);
          chunks.push(" ; ", subst.out, " ; ");
          i = subst.nextIndex;
          continue;
        }
        if (inner === "`") {
          const bt = consumeBacktick(input, i + 1, true);
          chunks.push(" ; ", bt.out, " ; ");
          i = bt.nextIndex;
          continue;
        }
        chunks.push(" ");
        i += 1;
      }
      if (i < input.length && input[i] === '"') {
        i += 1;
      }
      chunks.push(" ");
      continue;
    }

    if (ch === "`") {
      const bt = consumeBacktick(input, i + 1, false);
      chunks.push(" ; ", bt.out, " ; ");
      i = bt.nextIndex;
      continue;
    }

    chunks.push(ch);
    i += 1;
  }

  return { out: chunks.join(""), nextIndex: i };
}

function stripNonExecutableQuotes(command: string): string {
  return consumeQuoted(command, 0, false).out;
}

function findFirstExecutableToken(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let afterWrapper = false;
  for (const token of tokens) {
    if (SHELL_PREFIX_KEYWORDS.has(token)) {
      afterWrapper = false;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(token)) {
      continue;
    }
    if (afterWrapper && token.startsWith("-")) {
      continue;
    }
    const base = token.replace(/^.*[/\\]/, "").toLowerCase();
    if (COMMAND_WRAPPERS.has(base)) {
      afterWrapper = true;
      continue;
    }
    return base;
  }
  return null;
}

function hasDangerousPowerCommand(command: string): boolean {
  const stripped = stripNonExecutableQuotes(command);
  for (const segment of stripped.split(/[;&|\n()`]+/)) {
    const cmd = findFirstExecutableToken(segment);
    if (cmd && POWER_COMMANDS.has(cmd)) {
      return true;
    }
  }
  return false;
}

export function checkCommandSafety(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new SecurityError("Command must not be empty");
  }
  if (trimmed.includes("\0")) {
    throw new SecurityError("Command contains NUL byte");
  }
  const flattened = trimmed.replace(/[\\`]\r?\n/g, " ");
  for (const rule of CATASTROPHIC_COMMAND_PATTERNS) {
    if (rule.pattern.test(trimmed) || rule.pattern.test(flattened)) {
      throw new SecurityError(`Blocked dangerous command: ${rule.reason}`);
    }
  }
  if (hasDangerousPowerCommand(trimmed) || hasDangerousPowerCommand(flattened)) {
    throw new SecurityError("Blocked dangerous command: System power/reboot commands are blocked");
  }
}

export function redactSecrets(input: string): string {
  return maskSecrets(
    input
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/(client_secret|refresh_token|access_token|pin)=([^\s&]+)/gi, "$1=[REDACTED]"),
  ).text;
}

export class AuditLogger {
  private readonly auditPath: string;

  constructor(configDir: string) {
    ensureDirSecure(configDir);
    this.auditPath = join(configDir, "audit.jsonl");
  }

  log(entry: Omit<AuditEntry, "ts">): void {
    const record: AuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
      summary: redactSecrets(entry.summary).slice(0, 500),
      error: entry.error ? redactSecrets(entry.error).slice(0, 500) : undefined,
    };
    try {
      appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      try {
        chmodSync(this.auditPath, 0o600);
      } catch {
        // Ignore chmod errors on unsupported filesystems.
      }
    } catch {
      // Never crash tool execution on audit write failure.
    }
  }

  readRecent(limit = 30): AuditEntry[] {
    if (!existsSync(this.auditPath) || limit <= 0) {
      return [];
    }
    try {
      const raw = readFileSync(this.auditPath, "utf8");
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const sliced = lines.slice(-limit);
      const entries: AuditEntry[] = [];
      for (let i = sliced.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(sliced[i]!) as AuditEntry;
          if (parsed && typeof parsed.ts === "string" && typeof parsed.tool === "string") {
            entries.push(parsed);
          }
        } catch {
          // Skip malformed JSONL line.
        }
      }
      return entries;
    } catch {
      return [];
    }
  }
}
