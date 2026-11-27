import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { dirname, join, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { version as PKG_VERSION } from "../package.json";
import {
  getGitNullHooksPath,
  killProcessGracefully,
  resolveShellCommand,
} from "./platform.ts";
import {
  buildSanitizedChildEnv,
  checkCommandSafety,
  getSensitiveDeniedPaths,
  isPathInside,
  resolveSafePath,
  SecurityError,
} from "./security.ts";
import { maskSecrets, shieldToolResult } from "./secrets-shield.ts";
import type { ToolContext } from "./types.ts";

export const MAX_EDITABLE_FILE_BYTES = 10 * 1024 * 1024;
export const SAFE_GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${getGitNullHooksPath()}`,
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
] as const;

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function isDeniedPath(candidate: string, deniedPaths: string[]): boolean {
  return deniedPaths.some((denied) => isPathInside(candidate, denied, process.platform, CASE_INSENSITIVE_FS));
}

function normalizeGitSegment(seg: string): string {
  // Strip Win32 NTFS ADS suffixes (`:stream:$DATA`) and trailing dots/spaces.
  return seg.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();
}

export function isProtectedGitMetadataPath(absPath: string): boolean {
  const rawParts = absPath.split(/[/\\]+/).filter(Boolean);
  const parts = rawParts.map(normalizeGitSegment);
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== ".git") continue;
    // Block NTFS ADS syntax anywhere under .git
    for (let j = i + 1; j < rawParts.length; j += 1) {
      if (rawParts[j]!.includes(":")) return true;
    }
    const next = parts[i + 1];
    if (next === "config" || next?.startsWith("config.") || next === "hooks") {
      return true;
    }
    if (next === "modules") {
      for (let j = i + 2; j < parts.length; j += 1) {
        const sub = parts[j];
        if (sub === "config" || sub?.startsWith("config.") || sub === "hooks") {
          return true;
        }
      }
    }
  }
  return false;
}

const readOnlyAnn = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const writeAnn = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const execAnn = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateUtf8(bytes: Uint8Array, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes.byteLength <= maxBytes) {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated: false };
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes)),
    truncated: true,
  };
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  capBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  if (!stream || typeof stream === "number") {
    return { text: "", truncated: false, totalBytes: 0 };
  }
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const chunks: Uint8Array[] = [];
  let collected = 0;
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (collected < capBytes) {
        const remaining = capBytes - collected;
        if (value.byteLength <= remaining) {
          chunks.push(value);
          collected += value.byteLength;
        } else {
          chunks.push(value.subarray(0, remaining));
          collected += remaining;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    }
  } catch {
    // Stream cancelled or errored after timeout drain grace.
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(merged),
    truncated,
    totalBytes,
  };
}

async function runBoundedSubprocess(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}> {
  const started = Date.now();
  const useProcessGroup = process.platform !== "win32";
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
    detached: useProcessGroup,
  });

  const streamAbort = new AbortController();
  let timedOut = false;
  let procExited = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (procExited) {
      // Leader already exited before timeoutMs while a descendant retained stdio handles.
      if (useProcessGroup) {
        killProcessGracefully(proc, true, process.platform, { processGroup: true });
      }
      drainTimer = setTimeout(() => {
        streamAbort.abort();
      }, 250);
      return;
    }
    killProcessGracefully(proc, false, process.platform, { processGroup: useProcessGroup });
    if (useProcessGroup) {
      killTimer = setTimeout(() => {
        if (!procExited) {
          killProcessGracefully(proc, true, process.platform, { processGroup: true });
        }
      }, 1500);
    }
  }, timeoutMs);

  const exitedPromise = proc.exited.then((code) => {
    procExited = true;
    if (timedOut) {
      // Stop waiting on leaked stdout/stderr FDs if a grandchild survived or escaped the PGID.
      drainTimer = setTimeout(() => {
        if (useProcessGroup) {
          killProcessGracefully(proc, true, process.platform, { processGroup: true });
        }
        streamAbort.abort();
      }, 250);
    }
    return code;
  });

  try {
    const [stdoutRes, stderrRes, exitCode] = await Promise.all([
      readStreamCapped(proc.stdout, maxOutputBytes, streamAbort.signal),
      readStreamCapped(proc.stderr, maxOutputBytes, streamAbort.signal),
      exitedPromise,
    ]);
    return {
      exitCode,
      stdout: stdoutRes.text,
      stderr: stderrRes.text,
      stdoutTruncated: stdoutRes.truncated,
      stderrTruncated: stderrRes.truncated,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (drainTimer) clearTimeout(drainTimer);
  }
}

async function runSimpleShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}> {
  return runBoundedSubprocess(
    resolveShellCommand(command),
    cwd,
    buildSanitizedChildEnv(),
    timeoutMs,
    maxOutputBytes,
  );
}

async function runArgv(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const res = await runBoundedSubprocess(
    argv,
    cwd,
    { ...buildSanitizedChildEnv(), GIT_TERMINAL_PROMPT: "0" },
    timeoutMs,
    maxOutputBytes,
  );
  return {
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
  };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`);
}

function fallbackSearch(
  rootDir: string,
  pattern: string,
  mode: "content" | "files",
  glob: string | undefined,
  maxResults: number,
  deniedPaths: string[],
): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const globRegex = glob ? globToRegex(glob) : null;
  let contentRegex: RegExp;
  try {
    contentRegex = new RegExp(pattern, "i");
  } catch {
    contentRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  function walk(dir: string): void {
    if (results.length >= maxResults) return;
    if (isDeniedPath(dir, deniedPaths)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (isDeniedPath(full, deniedPaths)) continue;
      const rel = relative(rootDir, full) || entry.name;
      const relPosix = rel.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (globRegex && !globRegex.test(relPosix)) continue;

      if (mode === "files") {
        if (contentRegex.test(rel)) {
          results.push({ path: full, relativePath: rel });
        }
        continue;
      }

      try {
        const st = statSync(full);
        if (st.size > 1024 * 1024) continue;
        const raw = readFileSync(full);
        if (raw.includes(0)) continue;
        const lines = raw.toString("utf8").split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx += 1) {
          if (contentRegex.test(lines[idx]!)) {
            results.push({
              path: full,
              relativePath: rel,
              line: idx + 1,
              text: lines[idx]!.slice(0, 300),
            });
            if (results.length >= maxResults) return;
          }
        }
      } catch {
        // Skip unreadable files.
      }
    }
  }

  walk(rootDir);
  return results;
}

export function createGeminationMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "gemination", version: PKG_VERSION },
    {
      instructions:
        "Gemination connects Gemini Web to the user's local PC inside configured workspace roots. Inspect local_info first to see allowed roots and capabilities. Prefer read/search tools before editing, keep commands concise, and use start_process/poll_process for long-running tasks.",
    },
  );

  async function runTool(
    toolName: string,
    summary: string,
    fn: () => Promise<CallToolResult> | CallToolResult,
  ): Promise<CallToolResult> {
    const started = Date.now();
    try {
      const rawRes = await fn();
      const shielded = ctx.config.shieldSecrets
        ? shieldToolResult(rawRes)
        : { result: rawRes, masked: [] as string[] };
      const uniqueMasked = shielded.masked.length > 0 ? [...new Set(shielded.masked)] : undefined;
      ctx.audit.log({
        tool: toolName,
        clientId: ctx.authInfo?.clientId,
        ok: !shielded.result.isError,
        durationMs: Date.now() - started,
        summary,
        maskedSecrets: uniqueMasked,
      });
      return shielded.result;
    } catch (err) {
      const rawMsg = formatError(err);
      const msg = ctx.config.shieldSecrets ? maskSecrets(rawMsg).text : rawMsg;
      ctx.audit.log({
        tool: toolName,
        clientId: ctx.authInfo?.clientId,
        ok: false,
        durationMs: Date.now() - started,
        summary,
        error: msg,
      });
      return errorResult(msg);
    }
  }

  server.registerTool(
    "local_info",
    {
      description: "Inspect local host OS, allowed workspace roots, default cwd, and enabled capabilities.",
      inputSchema: {},
      annotations: readOnlyAnn,
    },
    () =>
      runTool("local_info", "inspect host info", () =>
        jsonResult({
          name: "gemination",
          version: PKG_VERSION,
          host: hostname(),
          platform: platform(),
          arch: arch(),
          osRelease: release(),
          roots: ctx.config.roots,
          defaultCwd: ctx.defaultCwd,
          capabilities: {
            allowRead: true,
            allowWrite: ctx.config.allowWrite,
            allowShell: ctx.config.allowShell,
            shieldSecrets: ctx.config.shieldSecrets,
          },
          activeProcesses: ctx.processManager.list().filter((p) => p.status === "running").length,
        }),
      ),
  );

  server.registerTool(
    "list_directory",
    {
      description: "List files and directories inside an allowed workspace root.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (defaults to workspace root)."),
        recursive: z.boolean().optional().default(false),
        maxDepth: z.number().int().min(1).max(5).optional().default(2),
        includeHidden: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(1000).optional().default(200),
      },
      annotations: readOnlyAnn,
    },
    ({ path, recursive, maxDepth, includeHidden, limit }) =>
      runTool("list_directory", `list ${path ?? "."}`, () => {
        const targetDir = resolveSafePath(path ?? ctx.defaultCwd, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const st = statSync(targetDir);
        if (!st.isDirectory()) {
          return errorResult(`Not a directory: ${targetDir}`);
        }

        const items: Array<{ path: string; relativePath: string; type: string; size?: number }> = [];
        let truncated = false;
        const deniedPaths = getSensitiveDeniedPaths(ctx.configDir);

        function walk(current: string, depth: number): void {
          if (items.length >= limit) {
            truncated = true;
            return;
          }
          if (isDeniedPath(current, deniedPaths)) {
            return;
          }
          const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith(".")) continue;
            if (entry.name === "node_modules" && recursive) continue;
            if (items.length >= limit) {
              truncated = true;
              return;
            }
            const full = join(current, entry.name);
            if (isDeniedPath(full, deniedPaths)) continue;
            const rel = relative(targetDir, full) || entry.name;
            const kind = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
            let size: number | undefined;
            if (entry.isFile()) {
              try {
                size = statSync(full).size;
              } catch {
                // Ignore stat race.
              }
            }
            items.push({ path: full, relativePath: rel, type: kind, size });
            if (recursive && entry.isDirectory() && depth < maxDepth) {
              walk(full, depth + 1);
            }
          }
        }

        walk(targetDir, 1);
        return jsonResult({ directory: targetDir, count: items.length, truncated, items });
      }),
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a UTF-8 text file within allowed workspace roots, with optional line range.",
      inputSchema: {
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional().default(1),
        endLine: z.number().int().min(1).optional(),
        maxBytes: z.number().int().min(256).max(262_144).optional().default(65_536),
      },
      annotations: readOnlyAnn,
    },
    ({ path, startLine, endLine, maxBytes }) =>
      runTool("read_file", `read ${path}`, () => {
        const target = resolveSafePath(path, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const st = statSync(target);
        if (!st.isFile()) {
          return errorResult(`Not a regular file: ${target}`);
        }
        if (st.size > MAX_EDITABLE_FILE_BYTES) {
          return errorResult(`File too large (${st.size} bytes; max ${MAX_EDITABLE_FILE_BYTES}): ${target}`);
        }
        const raw = readFileSync(target);
        const sample = raw.subarray(0, Math.min(raw.byteLength, 8192));
        if (sample.includes(0)) {
          return errorResult(`Binary file detected (${st.size} bytes): ${target}`);
        }
        const allLines = raw.toString("utf8").split(/\r?\n/);
        const totalLines = allLines.length;
        const effectiveEnd = Math.min(totalLines, endLine ?? startLine + 399);
        if (startLine > totalLines && totalLines > 0) {
          return jsonResult({
            path: target,
            totalLines,
            startLine,
            endLine: effectiveEnd,
            truncated: false,
            content: "",
          });
        }
        const selected = allLines.slice(startLine - 1, effectiveEnd).join("\n");
        const { text, truncated } = truncateUtf8(Buffer.from(selected, "utf8"), maxBytes);
        return jsonResult({
          path: target,
          totalLines,
          startLine,
          endLine: effectiveEnd,
          truncated: truncated || effectiveEnd < totalLines,
          content: text,
        });
      }),
  );

  server.registerTool(
    "write_file",
    {
      description: "Create, overwrite, or append to a file inside allowed workspace roots.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        append: z.boolean().optional().default(false),
      },
      annotations: writeAnn,
    },
    ({ path, content, append }) =>
      runTool("write_file", `${append ? "append" : "write"} ${path}`, () => {
        if (!ctx.config.allowWrite) {
          throw new SecurityError("Filesystem writes are disabled (--read-only mode)");
        }
        const target = resolveSafePath(path, ctx.config.roots, ctx.defaultCwd, {
          allowMissingLeaf: true,
          configDir: ctx.configDir,
        });
        if (!ctx.config.allowShell && isProtectedGitMetadataPath(target)) {
          throw new SecurityError(
            "Modifying .git/config or .git/hooks is blocked when shell execution is disabled (--no-shell)",
          );
        }
        mkdirSync(dirname(target), { recursive: true });
        if (append && existsSync(target)) {
          appendFileSync(target, content, "utf8");
        } else {
          writeFileSync(target, content, "utf8");
        }
        return jsonResult({
          path: target,
          bytesWritten: Buffer.byteLength(content, "utf8"),
          append,
        });
      }),
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace exact text in an existing file inside allowed workspace roots.",
      inputSchema: {
        path: z.string().min(1),
        target: z.string().min(1),
        replacement: z.string(),
        replaceAll: z.boolean().optional().default(false),
      },
      annotations: writeAnn,
    },
    ({ path, target, replacement, replaceAll }) =>
      runTool("edit_file", `edit ${path}`, () => {
        if (!ctx.config.allowWrite) {
          throw new SecurityError("Filesystem writes are disabled (--read-only mode)");
        }
        const safePath = resolveSafePath(path, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        if (!ctx.config.allowShell && isProtectedGitMetadataPath(safePath)) {
          throw new SecurityError(
            "Modifying .git/config or .git/hooks is blocked when shell execution is disabled (--no-shell)",
          );
        }
        const st = statSync(safePath);
        if (!st.isFile()) {
          return errorResult(`Not a regular file: ${safePath}`);
        }
        if (st.size > MAX_EDITABLE_FILE_BYTES) {
          return errorResult(`File too large (${st.size} bytes; max ${MAX_EDITABLE_FILE_BYTES}): ${safePath}`);
        }
        const original = readFileSync(safePath, "utf8");
        const occurrences = original.split(target).length - 1;
        if (occurrences === 0) {
          return errorResult(`Target snippet not found in ${safePath}`);
        }
        if (occurrences > 1 && !replaceAll) {
          return errorResult(
            `Target snippet matched ${occurrences} times in ${safePath}; pass replaceAll=true or provide more surrounding context`,
          );
        }
        const updated = replaceAll
          ? original.split(target).join(replacement)
          : original.replace(target, () => replacement);
        writeFileSync(safePath, updated, "utf8");
        return jsonResult({
          path: safePath,
          replacements: replaceAll ? occurrences : 1,
        });
      }),
  );

  server.registerTool(
    "search_files",
    {
      description: "Search file contents or filenames inside an allowed workspace root.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().optional(),
        mode: z.enum(["content", "files"]).optional().default("content"),
        glob: z.string().optional(),
        maxResults: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: readOnlyAnn,
    },
    ({ pattern, path, mode, glob, maxResults }) =>
      runTool("search_files", `search (${mode}) ${pattern}`, async () => {
        if (pattern.length > 512) {
          return errorResult("Pattern exceeds maximum length of 512 characters");
        }
        const searchRoot = resolveSafePath(path ?? ctx.defaultCwd, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const deniedPaths = getSensitiveDeniedPaths(ctx.configDir);
        const isAllowedPath = (candidate: string): boolean => !isDeniedPath(candidate, deniedPaths);

        const rgBin = Bun.which("rg");
        if (rgBin) {
          const argv = mode === "files"
            ? [rgBin, "--files", ...(glob ? [`--glob=${glob}`] : []), "--", searchRoot]
            : [
                rgBin,
                "--json",
                "--line-number",
                "--ignore-case",
                ...(glob ? [`--glob=${glob}`] : []),
                "-e",
                pattern,
                "--",
                searchRoot,
              ];

          const res = await runArgv(argv, searchRoot, 15_000, ctx.config.maxOutputBytes * 4);
          if (mode === "files") {
            let filterRegex: RegExp;
            try {
              filterRegex = new RegExp(pattern, "i");
            } catch {
              filterRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            }
            const lines = res.stdout
              .split(/\r?\n/)
              .filter(Boolean)
              .filter((line) => isAllowedPath(line) && filterRegex.test(line))
              .slice(0, maxResults)
              .map((full) => ({ path: full, relativePath: relative(searchRoot, full) || full }));
            return jsonResult({ root: searchRoot, mode, count: lines.length, results: lines });
          }

          if (res.exitCode === 0 || res.exitCode === 1) {
            const matches: Array<Record<string, unknown>> = [];
            for (const line of res.stdout.split(/\r?\n/)) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line) as {
                  type?: string;
                  data?: {
                    path?: { text?: string };
                    line_number?: number;
                    lines?: { text?: string };
                  };
                };
                if (event.type === "match" && event.data?.path?.text) {
                  const fullPath = event.data.path.text;
                  if (!isAllowedPath(fullPath)) continue;
                  matches.push({
                    path: fullPath,
                    relativePath: relative(searchRoot, fullPath) || fullPath,
                    line: event.data.line_number,
                    text: (event.data.lines?.text ?? "").trimEnd().slice(0, 300),
                  });
                  if (matches.length >= maxResults) break;
                }
              } catch {
                // Skip non-JSON line.
              }
            }
            return jsonResult({ root: searchRoot, mode, count: matches.length, results: matches });
          }
        }

        const results = fallbackSearch(searchRoot, pattern, mode, glob, maxResults, deniedPaths);
        return jsonResult({ root: searchRoot, mode, count: results.length, results });
      }),
  );

  server.registerTool(
    "run_command",
    {
      description: "Run a shell command in an allowed workspace directory and wait for bounded output.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(500).max(120_000).optional(),
      },
      annotations: execAnn,
    },
    ({ command, cwd, timeoutMs }) =>
      runTool("run_command", `run: ${command.slice(0, 120)}`, async () => {
        if (!ctx.config.allowShell) {
          throw new SecurityError("Shell execution is disabled (--no-shell mode)");
        }
        checkCommandSafety(command);
        const safeCwd = resolveSafePath(cwd ?? ctx.defaultCwd, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const effectiveTimeout = Math.min(
          timeoutMs ?? ctx.config.commandTimeoutMs,
          120_000,
        );
        const result = await runSimpleShell(command, safeCwd, effectiveTimeout, ctx.config.maxOutputBytes);
        return jsonResult({ cwd: safeCwd, ...result });
      }),
  );

  server.registerTool(
    "start_process",
    {
      description: "Start a long-running background shell command inside an allowed workspace directory.",
      inputSchema: {
        command: z.string().min(1),
        cwd: z.string().optional(),
      },
      annotations: execAnn,
    },
    ({ command, cwd }) =>
      runTool("start_process", `start: ${command.slice(0, 120)}`, () => {
        if (!ctx.config.allowShell) {
          throw new SecurityError("Shell execution is disabled (--no-shell mode)");
        }
        checkCommandSafety(command);
        const safeCwd = resolveSafePath(cwd ?? ctx.defaultCwd, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const info = ctx.processManager.start(command, safeCwd);
        return jsonResult(info);
      }),
  );

  server.registerTool(
    "poll_process",
    {
      description: "Poll status and incremental stdout/stderr output of a managed background process.",
      inputSchema: {
        id: z.string().min(1),
        stdoutOffset: z.number().int().min(0).optional().default(0),
        stderrOffset: z.number().int().min(0).optional().default(0),
        maxBytes: z.number().int().min(256).max(262_144).optional().default(32_768),
      },
      annotations: readOnlyAnn,
    },
    ({ id, stdoutOffset, stderrOffset, maxBytes }) =>
      runTool("poll_process", `poll ${id}`, () =>
        jsonResult(ctx.processManager.poll(id, stdoutOffset, stderrOffset, maxBytes)),
      ),
  );

  server.registerTool(
    "stop_process",
    {
      description: "Terminate a managed background process.",
      inputSchema: {
        id: z.string().min(1),
        force: z.boolean().optional().default(false),
      },
      annotations: execAnn,
    },
    ({ id, force }) =>
      runTool("stop_process", `stop ${id}`, () => jsonResult(ctx.processManager.stop(id, force))),
  );

  server.registerTool(
    "list_processes",
    {
      description: "List all managed background processes started during this session.",
      inputSchema: {},
      annotations: readOnlyAnn,
    },
    () =>
      runTool("list_processes", "list processes", () =>
        jsonResult({ processes: ctx.processManager.list() }),
      ),
  );

  server.registerTool(
    "git_inspect",
    {
      description: "Inspect git status, diff, log, or branches inside an allowed workspace repository.",
      inputSchema: {
        path: z.string().optional(),
        action: z.enum(["status", "diff", "log", "branch"]),
        limit: z.number().int().min(1).max(100).optional().default(20),
        staged: z.boolean().optional().default(false),
      },
      annotations: readOnlyAnn,
    },
    ({ path, action, limit, staged }) =>
      runTool("git_inspect", `git ${action} ${path ?? "."}`, async () => {
        const repoDir = resolveSafePath(path ?? ctx.defaultCwd, ctx.config.roots, ctx.defaultCwd, {
          configDir: ctx.configDir,
        });
        const gitBin = Bun.which("git") ?? "git";
        let argv: string[];
        switch (action) {
          case "status":
            argv = [gitBin, ...SAFE_GIT_ARGS, "status", "--short", "--branch"];
            break;
          case "diff":
            argv = [gitBin, ...SAFE_GIT_ARGS, "diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : [])];
            break;
          case "log":
            argv = [gitBin, ...SAFE_GIT_ARGS, "log", "-n", String(limit), "--oneline", "--decorate"];
            break;
          case "branch":
            argv = [gitBin, ...SAFE_GIT_ARGS, "branch", "-vv"];
            break;
        }
        const res = await runArgv(argv, repoDir, 15_000, ctx.config.maxOutputBytes);
        return jsonResult({
          cwd: repoDir,
          action,
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        });
      }),
  );

  return server;
}
