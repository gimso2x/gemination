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
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
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
  const pathImpl = targetPlatform === "win32" ? win32 : posix;
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
const SHELL_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "coproc",
  "builtin",
  "!",
  "{",
  "}",
]);
const COMMAND_WRAPPERS = new Set(["sudo", "doas", "env", "exec", "command", "nohup", "time"]);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIR_PREFIX_RE = /^(?:\d*[<>]+.*|&[<>].*)$/;
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user", "-R", "--chroot", "-D", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-a", "--argv0"]),
  exec: new Set(["-a"]),
};
const SUDO_SHORT_VALUE_CHARS = new Set(["u", "g", "C", "h", "p", "r", "t", "T", "U", "R", "D"]);

function collectRawSegments(
  input: string,
  start: number,
  stopAtParen: boolean,
  segments: string[],
): number {
  let buf = "";
  let i = start;
  let parenDepth = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (stopAtParen) {
      if (ch === "(") {
        parenDepth += 1;
        buf += ch;
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (parenDepth === 0) {
          if (buf.trim()) segments.push(buf);
          return i + 1;
        }
        parenDepth -= 1;
        buf += ch;
        i += 1;
        continue;
      }
    }

    if (ch === "\\") {
      buf += ch;
      if (i + 1 < input.length) {
        buf += input[i + 1]!;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      const ansiC = i > 0 && input[i - 1] === "$";
      buf += ch;
      i += 1;
      while (i < input.length && input[i] !== "'") {
        if (ansiC && input[i] === "\\" && i + 1 < input.length) {
          buf += input[i]! + input[i + 1]!;
          i += 2;
          continue;
        }
        buf += input[i]!;
        i += 1;
      }
      if (i < input.length && input[i] === "'") {
        buf += "'";
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      buf += ch;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const inner = input[i]!;
        if (inner === "\\") {
          buf += inner + (i + 1 < input.length ? input[i + 1]! : "");
          i += i + 1 < input.length ? 2 : 1;
          continue;
        }
        if (inner === "$" && input[i + 1] === "(") {
          i = collectRawSegments(input, i + 2, true, segments);
          buf += " ";
          continue;
        }
        if (inner === "`") {
          let bt = "";
          i += 1;
          while (i < input.length && input[i] !== "`") {
            if (input[i] === "\\" && i + 1 < input.length) {
              const next = input[i + 1]!;
              bt += next === "`" || next === "\\" || next === "$" || next === '"' ? next : `\\${next}`;
              i += 2;
              continue;
            }
            bt += input[i]!;
            i += 1;
          }
          if (i < input.length && input[i] === "`") i += 1;
          collectRawSegments(bt, 0, false, segments);
          buf += " ";
          continue;
        }
        buf += inner;
        i += 1;
      }
      if (i < input.length && input[i] === '"') {
        buf += '"';
        i += 1;
      }
      continue;
    }

    if (ch === "`") {
      let bt = "";
      i += 1;
      while (i < input.length && input[i] !== "`") {
        if (input[i] === "\\" && i + 1 < input.length) {
          const next = input[i + 1]!;
          bt += next === "`" || next === "\\" || next === "$" ? next : `\\${next}`;
          i += 2;
          continue;
        }
        bt += input[i]!;
        i += 1;
      }
      if (i < input.length && input[i] === "`") i += 1;
      collectRawSegments(bt, 0, false, segments);
      if (buf.trim()) segments.push(buf);
      buf = "";
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      if (buf.trim()) segments.push(buf);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  if (buf.trim()) segments.push(buf);
  return i;
}

function splitSegmentTokens(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i]!;
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      i += 1;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (i + 1 < segment.length ? segment[i + 1]! : "");
      i += i + 1 < segment.length ? 2 : 1;
      continue;
    }
    if (ch === "'") {
      const ansiC = i > 0 && segment[i - 1] === "$";
      cur += ch;
      i += 1;
      while (i < segment.length && segment[i] !== "'") {
        if (ansiC && segment[i] === "\\" && i + 1 < segment.length) {
          cur += segment[i]! + segment[i + 1]!;
          i += 2;
          continue;
        }
        cur += segment[i]!;
        i += 1;
      }
      if (i < segment.length && segment[i] === "'") {
        cur += "'";
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      cur += ch;
      i += 1;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === "\\" && i + 1 < segment.length) {
          cur += segment[i]! + segment[i + 1]!;
          i += 2;
          continue;
        }
        cur += segment[i]!;
        i += 1;
      }
      if (i < segment.length && segment[i] === '"') {
        cur += '"';
        i += 1;
      }
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function unquoteCommandWord(token: string): string {
  const looksLikeWinPath = /^["']?[A-Za-z]:[/\\]|^["']?\\\\/.test(token);
  let out = "";
  let i = 0;
  while (i < token.length) {
    const ch = token[i]!;
    if (ch === "$" && token[i + 1] === "'") {
      i += 2;
      while (i < token.length && token[i] !== "'") {
        if (token[i] === "\\" && i + 1 < token.length) {
          out += token[i + 1]!;
          i += 2;
        } else {
          out += token[i]!;
          i += 1;
        }
      }
      if (i < token.length && token[i] === "'") i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < token.length && token[i] !== "'") {
        out += token[i]!;
        i += 1;
      }
      if (i < token.length && token[i] === "'") i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < token.length && token[i] !== '"') {
        if (!looksLikeWinPath && token[i] === "\\" && i + 1 < token.length) {
          out += token[i + 1]!;
          i += 2;
        } else {
          out += token[i]!;
          i += 1;
        }
      }
      if (i < token.length && token[i] === '"') i += 1;
      continue;
    }
    if (!looksLikeWinPath && ch === "\\" && i + 1 < token.length) {
      out += token[i + 1]!;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findFirstExecutableToken(segment: string): string | null {
  const tokens = splitSegmentTokens(segment);
  let activeWrapper: string | null = null;
  let skipNextToken = false;
  let skipNextRedirTarget = false;

  for (const rawToken of tokens) {
    if (skipNextRedirTarget) {
      skipNextRedirTarget = false;
      continue;
    }
    if (skipNextToken) {
      skipNextToken = false;
      continue;
    }
    if (rawToken === "<" || rawToken === ">" || rawToken === ">>") {
      skipNextRedirTarget = true;
      continue;
    }
    if (REDIR_PREFIX_RE.test(rawToken)) {
      if (/^\d*[<>]+$/.test(rawToken)) {
        skipNextRedirTarget = true;
      }
      continue;
    }

    const token = unquoteCommandWord(rawToken);
    if (!token) continue;

    if (SHELL_PREFIX_KEYWORDS.has(token)) {
      activeWrapper = null;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(token)) {
      continue;
    }
    if (activeWrapper && token.startsWith("-")) {
      if (activeWrapper === "command" && (token === "-v" || token === "-V")) {
        return null;
      }
      const valueFlags = WRAPPER_VALUE_FLAGS[activeWrapper];
      if (valueFlags && valueFlags.has(token)) {
        skipNextToken = true;
      } else if (
        activeWrapper === "sudo"
        && /^-[A-Za-z]+$/.test(token)
        && SUDO_SHORT_VALUE_CHARS.has(token[token.length - 1]!)
      ) {
        skipNextToken = true;
      }
      continue;
    }

    const base = token.replace(/^.*[/\\]/, "").toLowerCase();
    if (COMMAND_WRAPPERS.has(base)) {
      activeWrapper = base;
      continue;
    }
    return base;
  }
  return null;
}

function hasDangerousPowerCommand(command: string): boolean {
  const segments: string[] = [];
  collectRawSegments(command, 0, false, segments);
  for (const segment of segments) {
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
  const flattened = trimmed.replace(/\\\r?\n/g, "").replace(/`\r?\n/g, " ");
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
