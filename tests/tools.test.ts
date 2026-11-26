import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
});
