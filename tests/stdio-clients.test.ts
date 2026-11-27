import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultConfig } from "../src/config.ts";
import { startGeminationHttpServer } from "../src/http-server.ts";
import {
  detectLocalClients,
  getClientConfigPath,
  registerLocalClient,
  unregisterLocalClient,
} from "../src/mcp-clients.ts";
import { OAuthServer } from "../src/oauth.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { AuditLogger } from "../src/security.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Local MCP clients registry (src/mcp-clients.ts)", () => {
  test("resolves OS-specific config paths for gemini-cli, claude-desktop, and cursor", () => {
    expect(getClientConfigPath("gemini-cli", { homeDir: "/home/alice", platform: "linux" })).toBe(
      join("/home/alice", ".gemini", "settings.json"),
    );
    expect(getClientConfigPath("claude-desktop", { homeDir: "/Users/alice", platform: "darwin" })).toBe(
      join("/Users/alice", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    expect(
      getClientConfigPath("claude-desktop", {
        homeDir: "C:\\Users\\alice",
        platform: "win32",
        env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
      }),
    ).toBe(join("C:\\Users\\alice\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(getClientConfigPath("cursor", { homeDir: "/home/alice", platform: "linux" })).toBe(
      join("/home/alice", ".cursor", "mcp.json"),
    );
  });

  test("registerLocalClient preserves existing keys & sibling servers, backs up existing config, and unregisters cleanly", () => {
    const fakeHome = makeTempDir("gemination-client-home-");
    const cfgDir = makeTempDir("gemination-client-cfg-");
    const geminiSettings = join(fakeHome, ".gemini", "settings.json");
    mkdirSync(join(fakeHome, ".gemini"), { recursive: true });
    writeFileSync(
      geminiSettings,
      JSON.stringify({
        selectedAuthType: "oauth-personal",
        mcpServers: { existingTool: { command: "npx", args: ["-y", "demo"] } },
      }),
      "utf8",
    );

    const reg = registerLocalClient("gemini-cli", process.cwd(), cfgDir, {
      overridePath: geminiSettings,
      bunPath: "/custom/bun",
    });
    expect(reg.configPath).toBe(geminiSettings);
    expect(existsSync(`${geminiSettings}.gemination.bak`)).toBe(true);

    const updated = JSON.parse(readFileSync(geminiSettings, "utf8")) as {
      selectedAuthType: string;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(updated.selectedAuthType).toBe("oauth-personal");
    expect(updated.mcpServers.existingTool?.command).toBe("npx");
    expect(updated.mcpServers.gemination?.command).toBe("/custom/bun");
    expect(updated.mcpServers.gemination?.args).toContain("stdio");

    const detected = detectLocalClients(process.cwd(), cfgDir, {
      bunPath: "/custom/bun",
      overrides: {
        "gemini-cli": geminiSettings,
        "claude-desktop": join(fakeHome, "claude.json"),
        cursor: join(fakeHome, "cursor.json"),
      },
    });
    const gemStatus = detected.clients.find((c) => c.id === "gemini-cli");
    expect(gemStatus?.registered).toBe(true);
    expect(gemStatus?.upToDate).toBe(true);

    const staleDetected = detectLocalClients(process.cwd(), cfgDir, {
      bunPath: "/other/bun",
      overrides: {
        "gemini-cli": geminiSettings,
        "claude-desktop": join(fakeHome, "claude.json"),
        cursor: join(fakeHome, "cursor.json"),
      },
    });
    const staleGem = staleDetected.clients.find((c) => c.id === "gemini-cli");
    expect(staleGem?.registered).toBe(true);
    expect(staleGem?.upToDate).toBe(false);

    const unreg = unregisterLocalClient("gemini-cli", { overridePath: geminiSettings });
    expect(unreg.removed).toBe(true);
    const unregAgain = unregisterLocalClient("gemini-cli", { overridePath: geminiSettings });
    expect(unregAgain.removed).toBe(false);
    const unregMissing = unregisterLocalClient("cursor", { overridePath: join(fakeHome, "missing.json") });
    expect(unregMissing.removed).toBe(false);
    const afterRemove = JSON.parse(readFileSync(geminiSettings, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterRemove.mcpServers.gemination).toBeUndefined();
    expect(afterRemove.mcpServers.existingTool).toBeDefined();
  });

  test("registerLocalClient refuses to overwrite malformed existing JSON config", () => {
    const dir = makeTempDir("gemination-badjson-");
    const badPath = join(dir, "settings.json");
    writeFileSync(badPath, "{ invalid json !!!", "utf8");

    expect(() =>
      registerLocalClient("gemini-cli", process.cwd(), dir, { overridePath: badPath }),
    ).toThrow("올바르지 않아 수정하지 않았습니다");
    expect(() => unregisterLocalClient("gemini-cli", { overridePath: badPath })).toThrow(
      "올바르지 않아 해제하지 않았습니다",
    );
    expect(readFileSync(badPath, "utf8")).toBe("{ invalid json !!!");
  });

  test("connect snippet & status CLI commands execute cleanly without errors", () => {
    const cfgDir = makeTempDir("gemination-connect-cli-");
    const snippetRes = Bun.spawnSync(
      [process.execPath, "run", "src/cli.ts", "connect", "snippet", "--config-dir", cfgDir],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(snippetRes.exitCode).toBe(0);
    const snippetJson = JSON.parse(Buffer.from(snippetRes.stdout).toString("utf8")) as {
      mcpServers: { gemination: { args: string[] } };
    };
    expect(snippetJson.mcpServers.gemination.args).toContain("stdio");

    const statusRes = Bun.spawnSync(
      [process.execPath, "run", "src/cli.ts", "connect", "status", "--config-dir", cfgDir],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(statusRes.exitCode).toBe(0);
    expect(Buffer.from(statusRes.stdout).toString("utf8")).toContain("gemini-cli");
  });
});

describe("MCP stdio transport end-to-end", () => {
  test("serves all 13 tools over stdio without OAuth or tunnel, enforcing Secret Shield and path jail", async () => {
    const ws = realpathSync(makeTempDir("gemination-stdio-ws-"));
    const outside = realpathSync(makeTempDir("gemination-stdio-out-"));
    const cfgDir = makeTempDir("gemination-stdio-cfg-");

    writeFileSync(join(ws, "sample.txt"), "API_TOKEN=ghp_1234567890abcdef1234567890abcdef1234\n", "utf8");
    writeFileSync(join(outside, "nope.txt"), "outside\n", "utf8");

    const cfg = defaultConfig();
    cfg.roots = [ws];
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(process.cwd(), "src", "cli.ts"), "stdio", "--config-dir", cfgDir],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.length).toBe(13);
      expect(listed.tools.map((t) => t.name)).toContain("batch_edit");

      const info = await client.callTool({ name: "local_info", arguments: {} });
      expect(info.isError).not.toBe(true);

      const readRes = await client.callTool({ name: "read_file", arguments: { path: "sample.txt" } });
      const text = (readRes.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).not.toContain("ghp_1234567890");
      expect(text).toContain("hidden]");

      const escaped = await client.callTool({
        name: "write_file",
        arguments: { path: join(outside, "pwn.txt"), content: "x" },
      });
      expect(escaped.isError).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  });
});

describe("Studio context-pack & local client HTTP endpoints", () => {
  test("context-pack includes shielded workspace tree & blocks traversal; client register validates ID", async () => {
    const ws = realpathSync(makeTempDir("gemination-ctx-ws-"));
    const outside = realpathSync(makeTempDir("gemination-ctx-out-"));
    const cfgDir = makeTempDir("gemination-ctx-cfg-");
    mkdirSync(join(ws, "src"), { recursive: true });
    const filePath = join(ws, "src", "app.ts");
    writeFileSync(filePath, "export const ok = true;\n", "utf8");
    writeFileSync(join(outside, "outside.txt"), "secret\n", "utf8");

    const cfg = defaultConfig();
    cfg.port = 0;
    cfg.roots = [ws];
    const oauth = new OAuthServer(cfgDir, cfg);
    const pm = new ProcessManager();
    const audit = new AuditLogger(cfgDir);
    const server = startGeminationHttpServer({
      config: cfg,
      configDir: cfgDir,
      oauth,
      audit,
      processManager: pm,
    });

    try {
      const html = await (await fetch(`${server.studioBaseUrl}/`)).text();
      const csrf = html.match(/<meta name="gemination-csrf" content="([a-f0-9]+)">/)?.[1] ?? "";
      expect(csrf.length).toBeGreaterThan(10);

      const status = (await (await fetch(`${server.studioBaseUrl}/_local/status`)).json()) as {
        localClients?: { clients: Array<{ id: string }> };
      };
      expect(status.localClients?.clients.some((c) => c.id === "gemini-cli")).toBe(true);

      const badClient = await fetch(`${server.studioBaseUrl}/_local/clients/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gemination-Local-Token": csrf },
        body: JSON.stringify({ client: "unknown-client" }),
      });
      expect(badClient.status).toBe(400);

      const badRoot = await fetch(`${server.studioBaseUrl}/_local/context-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gemination-Local-Token": csrf },
        body: JSON.stringify({ root: outside, prompt: "hello" }),
      });
      expect(badRoot.status).toBe(403);

      const fileAsRoot = await fetch(`${server.studioBaseUrl}/_local/context-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gemination-Local-Token": csrf },
        body: JSON.stringify({ root: filePath, prompt: "hello" }),
      });
      expect(fileAsRoot.status).toBe(400);

      const okPack = await fetch(`${server.studioBaseUrl}/_local/context-pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gemination-Local-Token": csrf },
        body: JSON.stringify({
          root: ws,
          prompt: "Check key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD please",
        }),
      });
      expect(okPack.status).toBe(200);
      const json = (await okPack.json()) as { composedPrompt: string };
      expect(json.composedPrompt).toContain("src/app.ts");
      expect(json.composedPrompt).toContain("[OpenAI key hidden]");
      expect(json.composedPrompt).not.toContain("sk-proj-");
    } finally {
      pm.stopAll();
      await server.stop();
    }
  });
});
