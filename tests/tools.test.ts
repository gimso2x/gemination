import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultConfig } from "../src/config.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { AuditLogger } from "../src/security.ts";
import { createGeminationMcpServer } from "../src/tools.ts";
import type { GeminationConfig } from "../src/types.ts";

let workspaceDir: string;
let configDir: string;
let processManager: ProcessManager;

async function connectTestClient(overrides: Partial<GeminationConfig> = {}): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const cfg: GeminationConfig = {
    ...defaultConfig(),
    roots: [realpathSync(workspaceDir)],
    ...overrides,
  };
  const mcpServer = createGeminationMcpServer({
    config: cfg,
    configDir,
    defaultCwd: cfg.roots[0]!,
    audit: new AuditLogger(configDir),
    processManager,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), mcpServer.close()]);
    },
  };
}

function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "gemination-tools-ws-"));
  configDir = mkdtempSync(join(tmpdir(), "gemination-tools-cfg-"));
  processManager = new ProcessManager();
});

afterEach(() => {
  processManager.stopAll();
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("Gemination MCP tools", () => {
  test("filesystem read/write/edit/search/list tools work end-to-end", async () => {
    const { client, close } = await connectTestClient();
    try {
      const info = parseToolJson(await client.callTool({ name: "local_info", arguments: {} }));
      expect(info.name).toBe("gemination");

      const writeRes = parseToolJson(
        await client.callTool({
          name: "write_file",
          arguments: { path: "notes/hello.txt", content: "line1\nneedle here\nline3\n" },
        }),
      );
      expect(writeRes.bytesWritten).toBeGreaterThan(0);

      const editRes = parseToolJson(
        await client.callTool({
          name: "edit_file",
          arguments: { path: "notes/hello.txt", target: "needle here", replacement: "updated needle" },
        }),
      );
      expect(editRes.replacements).toBe(1);

      const readRes = parseToolJson(
        await client.callTool({
          name: "read_file",
          arguments: { path: "notes/hello.txt", startLine: 1, endLine: 3 },
        }),
      );
      expect(String(readRes.content)).toContain("updated needle");

      // Binary file rejection
      writeFileSync(join(workspaceDir, "bin.dat"), new Uint8Array([0, 1, 2, 0, 255]));
      const binRes = await client.callTool({ name: "read_file", arguments: { path: "bin.dat" } });
      expect(binRes.isError).toBe(true);

      const searchContent = parseToolJson(
        await client.callTool({
          name: "search_files",
          arguments: { pattern: "updated needle", mode: "content" },
        }),
      );
      expect(searchContent.count).toBe(1);

      const searchFiles = parseToolJson(
        await client.callTool({
          name: "search_files",
          arguments: { pattern: "hello\\.txt", mode: "files" },
        }),
      );
      expect(searchFiles.count).toBe(1);

      const listRes = parseToolJson(
        await client.callTool({
          name: "list_directory",
          arguments: { recursive: true },
        }),
      );
      expect(listRes.count).toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  });

  test("run_command, background process lifecycle, and git_inspect", async () => {
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "write_file",
        arguments: {
          path: "_run_helper.mjs",
          content: [
            'console.log("hello-stdout");',
            'console.error("hello-stderr");',
          ].join("\n"),
        },
      });
      await client.callTool({
        name: "write_file",
        arguments: {
          path: "_bg_helper.mjs",
          content: [
            'console.log("bg-ready");',
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        },
      });
      await client.callTool({
        name: "write_file",
        arguments: {
          path: "_git_init.mjs",
          content: [
            'import { writeFileSync } from "node:fs";',
            'const run = (cmd) => {',
            '  const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });',
            '  if (res.exitCode !== 0) throw new Error(Buffer.from(res.stderr).toString("utf8"));',
            "};",
            'run(["git", "init"]);',
            'run(["git", "config", "user.email", "test@example.com"]);',
            'run(["git", "config", "user.name", "test"]);',
            'writeFileSync("a.txt", "a\\n", "utf8");',
            'run(["git", "add", "a.txt"]);',
            'run(["git", "commit", "-m", "init"]);',
          ].join("\n"),
        },
      });

      const cmdRes = parseToolJson(
        await client.callTool({
          name: "run_command",
          arguments: { command: "bun _run_helper.mjs" },
        }),
      );
      expect(cmdRes.exitCode).toBe(0);
      expect(String(cmdRes.stdout)).toContain("hello-stdout");
      expect(String(cmdRes.stderr)).toContain("hello-stderr");

      const started = parseToolJson(
        await client.callTool({
          name: "start_process",
          arguments: { command: "bun _bg_helper.mjs" },
        }),
      );
      const procId = String(started.id);
      let polled: Record<string, unknown> = {};
      const pollDeadline = Date.now() + 10_000;
      while (Date.now() < pollDeadline) {
        polled = parseToolJson(
          await client.callTool({
            name: "poll_process",
            arguments: { id: procId },
          }),
        );
        if (String(polled.stdoutChunk ?? "").includes("bg-ready")) break;
        await Bun.sleep(40);
      }
      expect(String(polled.stdoutChunk)).toContain("bg-ready");

      const listed = parseToolJson(await client.callTool({ name: "list_processes", arguments: {} }));
      expect((listed.processes as Array<{ id: string }>).some((p) => p.id === procId)).toBe(true);

      const stopped = parseToolJson(
        await client.callTool({ name: "stop_process", arguments: { id: procId } }),
      );
      expect(stopped.status).toBe("killed");

      // Initialize git repo and inspect
      const gitSetupRes = parseToolJson(
        await client.callTool({
          name: "run_command",
          arguments: { command: "bun _git_init.mjs" },
        }),
      );
      expect(gitSetupRes.exitCode).toBe(0);
      const gitStatus = parseToolJson(
        await client.callTool({ name: "git_inspect", arguments: { action: "status" } }),
      );
      expect(gitStatus.exitCode).toBe(0);
      const gitLog = parseToolJson(
        await client.callTool({ name: "git_inspect", arguments: { action: "log", limit: 5 } }),
      );
      expect(String(gitLog.stdout)).toContain("init");
    } finally {
      await close();
    }
  });

  test("enforces read-only and no-shell policies", async () => {
    const { client, close } = await connectTestClient({ allowWrite: false, allowShell: false });
    try {
      const writeBlocked = await client.callTool({
        name: "write_file",
        arguments: { path: "blocked.txt", content: "nope" },
      });
      expect(writeBlocked.isError).toBe(true);

      const cmdBlocked = await client.callTool({
        name: "run_command",
        arguments: { command: "echo nope" },
      });
      expect(cmdBlocked.isError).toBe(true);
    } finally {
      await close();
    }
  });

  test("prevents rg flag injection, preserves $-replacements in edit_file, and blocks .git/config edits when --no-shell", async () => {
    const { client, close } = await connectTestClient({ allowWrite: true, allowShell: false });
    try {
      await client.callTool({
        name: "write_file",
        arguments: { path: "sample.txt", content: "--pre=echo\nhello $world\n" },
      });

      const editRes = parseToolJson(
        await client.callTool({
          name: "edit_file",
          arguments: { path: "sample.txt", target: "hello $world", replacement: "$& $$ $` $' ok" },
        }),
      );
      expect(editRes.replacements).toBe(1);

      const readRes = parseToolJson(
        await client.callTool({ name: "read_file", arguments: { path: "sample.txt" } }),
      );
      expect(String(readRes.content)).toContain("$& $$ $` $' ok");

      // Pattern starting with "-" must be treated as literal pattern via -e / --, NOT an rg --pre flag
      const searchRes = parseToolJson(
        await client.callTool({
          name: "search_files",
          arguments: { pattern: "--pre=echo", mode: "content" },
        }),
      );
      expect(searchRes.count).toBe(1);

      const gitConfigWrite = await client.callTool({
        name: "write_file",
        arguments: { path: ".git/config", content: "[core]\n\tfsmonitor = evil\n" },
      });
      expect(gitConfigWrite.isError).toBe(true);

      const gitAdsWrite = await client.callTool({
        name: "write_file",
        arguments: { path: ".git/config::$DATA", content: "[core]\n\tfsmonitor = evil\n" },
      });
      expect(gitAdsWrite.isError).toBe(true);

      const gitTrailingDotWrite = await client.callTool({
        name: "write_file",
        arguments: { path: ".git/hooks./pre-commit", content: "#!/bin/sh\necho pwn\n" },
      });
      expect(gitTrailingDotWrite.isError).toBe(true);
    } finally {
      await close();
    }
  });

  test("terminates grandchild processes holding pipes on run_command timeout and stop_process", async () => {
    const { client, close } = await connectTestClient();

    if (process.platform === "win32") {
      try {
        await client.callTool({
          name: "write_file",
          arguments: {
            path: "_win_hang.mjs",
            content: [
              'const c = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "pipe", stderr: "pipe" });',
              "console.log(c.pid);",
              "setInterval(() => {}, 1000);",
            ].join("\n"),
          },
        });
        const startedAt = Date.now();
        const res = parseToolJson(
          await client.callTool({
            name: "run_command",
            arguments: { command: "bun _win_hang.mjs", timeoutMs: 1200 },
          }),
        );
        expect(res.timedOut).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(8000);
      } finally {
        await close();
      }
      return;
    }

    let runGcPid = 0;
    let bgGcPid = 0;
    const isPidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitPidGone = async (pid: number): Promise<boolean> => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await Bun.sleep(25);
      }
      return !isPidAlive(pid);
    };

    try {
      const startedAt = Date.now();
      const timedOutRes = parseToolJson(
        await client.callTool({
          name: "run_command",
          arguments: {
            command: "(sleep 30) & printf '%s' \"$!\" > _run_gc.pid; sleep 30",
            timeoutMs: 1200,
          },
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      expect(timedOutRes.timedOut).toBe(true);
      expect(elapsedMs).toBeLessThan(4000);

      const runPidPath = join(workspaceDir, "_run_gc.pid");
      expect(existsSync(runPidPath)).toBe(true);
      runGcPid = Number.parseInt(readFileSync(runPidPath, "utf8").trim(), 10);
      expect(runGcPid).toBeGreaterThan(0);
      expect(await waitPidGone(runGcPid)).toBe(true);

      // Early parent exit while descendant keeps stdio pipes open must still stop at timeoutMs
      const orphanStart = Date.now();
      const orphanRes = parseToolJson(
        await client.callTool({
          name: "run_command",
          arguments: {
            command: "(sleep 30) & printf '%s' \"$!\" > _orphan_gc.pid",
            timeoutMs: 800,
          },
        }),
      );
      expect(orphanRes.timedOut).toBe(true);
      expect(Date.now() - orphanStart).toBeLessThan(3500);
      const orphanPid = Number.parseInt(readFileSync(join(workspaceDir, "_orphan_gc.pid"), "utf8").trim(), 10);
      expect(orphanPid).toBeGreaterThan(0);
      try {
        expect(await waitPidGone(orphanPid)).toBe(true);
      } finally {
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }

      const bgStarted = parseToolJson(
        await client.callTool({
          name: "start_process",
          arguments: {
            command: "(sleep 30) & printf '%s' \"$!\" > _bg_gc.pid; echo ready; wait",
          },
        }),
      );
      const procId = String(bgStarted.id);
      const bgPidPath = join(workspaceDir, "_bg_gc.pid");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const polled = parseToolJson(
          await client.callTool({ name: "poll_process", arguments: { id: procId } }),
        );
        if (String(polled.stdoutChunk ?? "").includes("ready") && existsSync(bgPidPath)) {
          break;
        }
        await Bun.sleep(30);
      }
      expect(existsSync(bgPidPath)).toBe(true);
      bgGcPid = Number.parseInt(readFileSync(bgPidPath, "utf8").trim(), 10);
      expect(bgGcPid).toBeGreaterThan(0);

      const stopped = parseToolJson(
        await client.callTool({ name: "stop_process", arguments: { id: procId } }),
      );
      expect(stopped.status).toBe("killed");
      expect(await waitPidGone(bgGcPid)).toBe(true);

      // Grandchild ignoring SIGTERM holding pipes must still be killed via SIGKILL escalation on timeout
      let trapGcPid = 0;
      const trapStartedAt = Date.now();
      const trapRes = parseToolJson(
        await client.callTool({
          name: "run_command",
          arguments: {
            command: "(sh -c \"trap '' TERM; sleep 30\") & printf '%s' \"$!\" > _trap_gc.pid; sleep 30",
            timeoutMs: 1200,
          },
        }),
      );
      expect(trapRes.timedOut).toBe(true);
      expect(Date.now() - trapStartedAt).toBeLessThan(4000);
      const trapPidPath = join(workspaceDir, "_trap_gc.pid");
      expect(existsSync(trapPidPath)).toBe(true);
      trapGcPid = Number.parseInt(readFileSync(trapPidPath, "utf8").trim(), 10);
      expect(trapGcPid).toBeGreaterThan(0);
      try {
        expect(await waitPidGone(trapGcPid)).toBe(true);
      } finally {
        try {
          process.kill(trapGcPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
      } finally {
        for (const pid of [runGcPid, bgGcPid]) {
          if (pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already exited.
            }
          }
        }
        await close();
      }
    });

  test("batch_edit applies multi-file writes and edits atomically in one call", async () => {
    const { client, close } = await connectTestClient();
    try {
      writeFileSync(join(workspaceDir, "a.txt"), "alpha\nfoo\nfoo\n$token\n", "utf8");
      writeFileSync(join(workspaceDir, "log.txt"), "start\n", "utf8");

      const res = parseToolJson(
        await client.callTool({
          name: "batch_edit",
          arguments: {
            edits: [
              // Sequential edits on the same file, including replaceAll and $-replacement preservation
              { path: "a.txt", action: "edit", target: "foo", replacement: "bar", replaceAll: true },
              { path: "a.txt", target: "$token", replacement: "$& $$ $` $' ok" },
              // Create a new file (inferred write) and edit it within the same batch
              { path: "sub/new.txt", content: "hello placeholder\n" },
              { path: "sub/new.txt", target: "placeholder", replacement: "world" },
              // Append to an existing file
              { path: "log.txt", action: "write", content: "next\n", append: true },
            ],
          },
        }),
      );

      expect(res.dryRun).toBe(false);
      expect(res.operationsApplied).toBe(5);
      expect(res.filesModified).toBe(3);

      expect(readFileSync(join(workspaceDir, "a.txt"), "utf8")).toBe("alpha\nbar\nbar\n$& $$ $` $' ok\n");
      expect(readFileSync(join(workspaceDir, "sub", "new.txt"), "utf8")).toBe("hello world\n");
      expect(readFileSync(join(workspaceDir, "log.txt"), "utf8")).toBe("start\nnext\n");
    } finally {
      await close();
    }
  });

  test("batch_edit rolls back in memory (zero disk changes) when any operation fails", async () => {
    const { client, close } = await connectTestClient({ allowWrite: true, allowShell: false });
    try {
      writeFileSync(join(workspaceDir, "keep.txt"), "original\n", "utf8");

      // Missing target snippet in a later op must leave earlier ops and new files untouched
      const missingTargetRes = await client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [
            { path: "keep.txt", target: "original", replacement: "changed" },
            { path: "created-if-non-atomic.txt", content: "should not exist\n" },
            { path: "keep.txt", target: "not-found", replacement: "x" },
          ],
        },
      });
      expect(missingTargetRes.isError).toBe(true);
      expect(readFileSync(join(workspaceDir, "keep.txt"), "utf8")).toBe("original\n");
      expect(existsSync(join(workspaceDir, "created-if-non-atomic.txt"))).toBe(false);

      // Path outside workspace root in a later op must fail cleanly without touching earlier files
      const outsideRes = await client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [
            { path: "keep.txt", target: "original", replacement: "changed" },
            { path: "../escape.txt", content: "nope" },
          ],
        },
      });
      expect(outsideRes.isError).toBe(true);
      expect(readFileSync(join(workspaceDir, "keep.txt"), "utf8")).toBe("original\n");

      // Protected .git/config write under --no-shell must block the whole batch
      const gitConfigRes = await client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [
            { path: "keep.txt", target: "original", replacement: "changed" },
            { path: ".git/config", content: "[core]\n\tfsmonitor = evil\n" },
          ],
        },
      });
      expect(gitConfigRes.isError).toBe(true);
      expect(readFileSync(join(workspaceDir, "keep.txt"), "utf8")).toBe("original\n");
    } finally {
      await close();
    }
  });

  test("batch_edit supports dryRun, enforces allowWrite, validates edge cases, and exports Gemini-compatible schema", async () => {
    const rwConn = await connectTestClient();
    try {
      writeFileSync(join(workspaceDir, "dry.txt"), "before\n", "utf8");
      writeFileSync(join(workspaceDir, "bin.dat"), new Uint8Array([0, 1, 2, 0, 255]));

      // dryRun previews without modifying disk
      const dryRes = parseToolJson(
        await rwConn.client.callTool({
          name: "batch_edit",
          arguments: {
            dryRun: true,
            edits: [
              { path: "dry.txt", target: "before", replacement: "after" },
              { path: "dry-new.txt", content: "new\n" },
            ],
          },
        }),
      );
      expect(dryRes.dryRun).toBe(true);
      expect(dryRes.operationsApplied).toBe(2);
      expect(dryRes.filesModified).toBe(2);
      expect(readFileSync(join(workspaceDir, "dry.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(workspaceDir, "dry-new.txt"))).toBe(false);

      // Binary file rejection
      const binRes = await rwConn.client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [{ path: "bin.dat", target: "a", replacement: "b" }],
        },
      });
      expect(binRes.isError).toBe(true);

      // Ambiguous op (both target and content without explicit action)
      const ambigRes = await rwConn.client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [{ path: "dry.txt", target: "before", replacement: "after", content: "x" }],
        },
      });
      expect(ambigRes.isError).toBe(true);

      // File vs directory collision in same batch (file staged first, then child under it)
      const collisionRes1 = await rwConn.client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [
            { path: "node", content: "file\n" },
            { path: "node/child.txt", content: "child\n" },
          ],
        },
      });
      expect(collisionRes1.isError).toBe(true);
      expect(existsSync(join(workspaceDir, "node"))).toBe(false);

      // File vs directory collision in reverse order (child staged first, then ancestor as file)
      const collisionRes2 = await rwConn.client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [
            { path: "dir/child.txt", content: "child\n" },
            { path: "dir", content: "file\n" },
          ],
        },
      });
      expect(collisionRes2.isError).toBe(true);
      expect(existsSync(join(workspaceDir, "dir"))).toBe(false);

      // Gemini Web JSON Schema compatibility: readOnlyHint === false, no oneOf/anyOf
      const listed = await rwConn.client.listTools();
      const batchTool = listed.tools.find((t) => t.name === "batch_edit");
      expect(batchTool).toBeDefined();
      expect(batchTool?.annotations?.readOnlyHint).toBe(false);
      const schemaText = JSON.stringify(batchTool?.inputSchema ?? {});
      expect(schemaText).not.toContain('"oneOf"');
      expect(schemaText).not.toContain('"anyOf"');
    } finally {
      await rwConn.close();
    }

    // --read-only (allowWrite: false) blocks batch_edit
    const roConn = await connectTestClient({ allowWrite: false, allowShell: false });
    try {
      const blocked = await roConn.client.callTool({
        name: "batch_edit",
        arguments: {
          edits: [{ path: "blocked.txt", content: "nope" }],
        },
      });
      expect(blocked.isError).toBe(true);
    } finally {
      await roConn.close();
    }
  });
});
