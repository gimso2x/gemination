import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempScript(dir: string, filename: string, content: string): string {
  const scriptPath = join(dir, filename);
  writeFileSync(scriptPath, content, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function runChooseCli(options: {
  cfgDir: string;
  stdinLines: string[];
  extraEnv?: Record<string, string>;
  extraArgs?: string[];
  waitForText?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/cli.ts",
      "up",
      "--choose",
      "--port",
      "0",
      "--no-copy",
      "--config-dir",
      options.cfgDir,
      ...(options.extraArgs ?? []),
    ],
    {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GEMINATION_PIN: "",
        GEMINATION_SKIP_PROBE: "1",
        GEMINATION_NO_CAFFEINATE: "1",
        ...options.extraEnv,
      },
    },
  );

  proc.stdin.write(`${options.stdinLines.join("\n")}\n`);
  proc.stdin.end();

  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";

  const readStderr = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) stderr += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();

  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 10_000;
  let sawMarker = false;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) stdout += decoder.decode(value, { stream: true });
      if (options.waitForText && stdout.includes(options.waitForText)) {
        sawMarker = true;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (options.waitForText && sawMarker) {
    proc.kill("SIGTERM");
  }
  const exitCode = await proc.exited;
  await readStderr;
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("gemination CLI up onboarding & convenience flows", () => {
  test("auto-initializes config/state on first run and prints Gemini MCP URL + Dashboard + Approval Code", async () => {
    const cfgDir = makeTempDir("gemination-up-test-");

    const proc = Bun.spawn(
      ["bun", "run", "src/cli.ts", "up", "--tunnel", "none", "--port", "0", "--no-copy", "--config-dir", cfgDir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GEMINATION_PIN: "",
          GEMINATION_SKIP_PROBE: "1",
          GEMINATION_NO_CAFFEINATE: "1",
        },
      },
    );

    let out = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
        if (out.includes("Press Ctrl+C to stop.")) break;
      }

      expect(out).toMatch(/Local MCP Server:\s+http:\/\/127\.0\.0\.1:\d+/);
      expect(out).toMatch(/Local Studio UI:\s+http:\/\/127\.0\.0\.1:\d+\//);
      expect(out).toMatch(/Gemini MCP URL:\s+http:\/\/127\.0\.0\.1:\d+\/mcp/);
      expect(out).toMatch(/Approval Code:\s+[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);
      expect(existsSync(join(cfgDir, "config.json"))).toBe(true);
      expect(existsSync(join(cfgDir, "state.json"))).toBe(true);
    } finally {
      reader.releaseLock();
      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0);
    }
  });

  test("interactive --choose menu allows picking Tailscale Funnel (choice 1) with mock Tailscale CLI", async () => {
    const cfgDir = makeTempDir("gemination-choose-ts-");
    const binDir = makeTempDir("gemination-ts-bin-");
    const fakeTailscale = makeTempScript(
      binDir,
      "tailscale",
      `#!/usr/bin/env bash
if [ "$1" = "status" ]; then
  echo '{"BackendState":"Running","Self":{"DNSName":"test-box.tail999.ts.net.","CapMap":{"https":[]}}}'
  exit 0
fi
if [ "$1" = "funnel" ]; then
  echo "Available on the internet:"
  echo "https://test-box.tail999.ts.net/"
  trap 'exit 0' INT TERM
  while true; do sleep 1; done
fi
exit 1
`,
    );

    const res = await runChooseCli({
      cfgDir,
      stdinLines: ["1"],
      extraEnv: { TAILSCALE_BIN: fakeTailscale },
      waitForText: "Press Ctrl+C to stop.",
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Tailscale Funnel");
    expect(res.stdout).toContain("재시작할 때마다 gemini.google.com 커넥터를 다시 등록해야 합니다.");
    expect(res.stdout).toContain("Gemini MCP URL:      https://test-box.tail999.ts.net/mcp");
    expect(res.stdout).toContain("이 주소는 서버를 껐다 켜도 바뀌지 않으므로");

    const saved = JSON.parse(readFileSync(join(cfgDir, "config.json"), "utf8")) as { tunnelMode?: string };
    expect(saved.tunnelMode).toBe("tailscale");
  });

  test("interactive --choose menu allows picking Quick Tunnel (choice 2), prints restart warning & auto-PIN even when state exists", async () => {
    const cfgDir = makeTempDir("gemination-choose-cf-");
    const binDir = makeTempDir("gemination-cf-bin-");
    const fakeCloudflared = makeTempScript(
      binDir,
      "cloudflared",
      `#!/usr/bin/env bash
echo "INF +--------------------------------------------------------------------------------------------+" >&2
echo "INF |  https://mock-quick-tunnel-demo.trycloudflare.com                                          |" >&2
trap 'exit 0' INT TERM
while true; do sleep 1; done
`,
    );

    // Pre-create state.json via init so this simulates a subsequent Quick Tunnel restart
    const initProc = Bun.spawnSync(
      ["bun", "run", "src/cli.ts", "init", "--config-dir", cfgDir],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(initProc.exitCode).toBe(0);

    const res = await runChooseCli({
      cfgDir,
      stdinLines: ["2"],
      extraEnv: { CLOUDFLARED_BIN: fakeCloudflared },
      waitForText: "Press Ctrl+C to stop.",
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Gemini MCP URL:      https://mock-quick-tunnel-demo.trycloudflare.com/mcp");
    expect(res.stdout).toContain("[!] Quick Tunnel 안내 (중요):");
    expect(res.stdout).toContain("재시작할 때마다 gemini.google.com 커넥터 URL을 다시 등록해야 합니다.");
    expect(res.stdout).toMatch(/Approval Code:\s+[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);

    const saved = JSON.parse(readFileSync(join(cfgDir, "config.json"), "utf8")) as { tunnelMode?: string };
    expect(saved.tunnelMode).toBe("quick");
  });

  test("interactive --choose [s] wizard switches to safety preset and persists before starting", async () => {
    const cfgDir = makeTempDir("gemination-choose-wiz-");
    // [s] -> keep root (1) -> safety preset (2) -> then choose local-only (4)
    const res = await runChooseCli({
      cfgDir,
      stdinLines: ["s", "1", "2", "4"],
      waitForText: "Press Ctrl+C to stop.",
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("읽기 전용 (안전 모드)");
    const saved = JSON.parse(readFileSync(join(cfgDir, "config.json"), "utf8")) as {
      allowWrite: boolean;
      allowShell: boolean;
      tunnelMode?: string;
    };
    expect(saved.allowWrite).toBe(false);
    expect(saved.allowShell).toBe(false);
    expect(saved.tunnelMode).toBe("none");
  });

  test("interactive --choose menu allows clean cancel (q) without creating files", async () => {
    const cfgCancel = makeTempDir("gemination-choose-cancel-");
    const cancelRes = await runChooseCli({
      cfgDir: cfgCancel,
      stdinLines: ["q"],
    });
    expect(cancelRes.exitCode).toBe(0);
    expect(cancelRes.stdout).toContain("실행을 취소했습니다.");
    expect(existsSync(join(cfgCancel, "config.json"))).toBe(false);
    expect(existsSync(join(cfgCancel, "state.json"))).toBe(false);
  });

  test("config CLI subcommands update roots, read-only, secret-shield, and tunnel mode", () => {
    const cfgDir = makeTempDir("gemination-config-cmd-");
    const extraRoot = makeTempDir("gemination-extra-root-");

    const cmds: string[][] = [
      ["init", "--config-dir", cfgDir],
      ["config", "add-root", extraRoot, "--config-dir", cfgDir],
      ["config", "read-only", "on", "--config-dir", cfgDir],
      ["config", "secret-shield", "off", "--config-dir", cfgDir],
      ["config", "tunnel", "tailscale", "--config-dir", cfgDir],
    ];
    for (const args of cmds) {
      const res = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(res.exitCode).toBe(0);
    }

    const getRes = Bun.spawnSync(["bun", "run", "src/cli.ts", "config", "get", "--config-dir", cfgDir], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(getRes.exitCode).toBe(0);
    const parsed = JSON.parse(Buffer.from(getRes.stdout).toString("utf8")) as {
      allowWrite: boolean;
      shieldSecrets: boolean;
      tunnelMode: string;
      roots: string[];
    };
    expect(parsed.allowWrite).toBe(false);
    expect(parsed.shieldSecrets).toBe(false);
    expect(parsed.tunnelMode).toBe("tailscale");
    expect(parsed.roots.length).toBeGreaterThanOrEqual(2);
  });

  test("auto-shifts port when preferred port is already occupied", async () => {
    const cfgDir = makeTempDir("gemination-port-shift-");
    const holder = createNetServer();
    const heldPort = await new Promise<number>((resolvePort) => {
      holder.listen(0, "127.0.0.1", () => {
        const addr = holder.address();
        resolvePort(typeof addr === "object" && addr ? addr.port : 49152);
      });
    });

    const proc = Bun.spawn(
      ["bun", "run", "src/cli.ts", "up", "--tunnel", "none", "--port", String(heldPort), "--no-copy", "--config-dir", cfgDir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GEMINATION_PIN: "",
          GEMINATION_SKIP_PROBE: "1",
          GEMINATION_NO_CAFFEINATE: "1",
        },
      },
    );

    let out = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
        if (out.includes("Press Ctrl+C to stop.")) break;
      }

      expect(out).toContain(`포트 ${heldPort}이 이미 사용 중이어서`);
      expect(out).toMatch(/Gemini MCP URL:\s+http:\/\/127\.0\.0\.1:\d+\/mcp/);
      expect(out).not.toContain(`http://127.0.0.1:${heldPort}/mcp`);
    } finally {
      reader.releaseLock();
      proc.kill("SIGTERM");
      const code = await proc.exited;
      await new Promise<void>((r) => holder.close(() => r()));
      expect(code).toBe(0);
    }
  });

  test("gui subcommand serves ZCode-style Studio UI and shuts down cleanly", async () => {
    const cfgDir = makeTempDir("gemination-gui-cmd-");
    const proc = Bun.spawn(
      ["bun", "run", "src/cli.ts", "gui", "--port", "0", "--config-dir", cfgDir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GEMINATION_PIN: "",
          GEMINATION_NO_OPEN: "1",
          GEMINATION_SKIP_PROBE: "1",
          GEMINATION_NO_CAFFEINATE: "1",
        },
      },
    );

    let out = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
        if (out.includes("Press Ctrl+C to stop.")) break;
      }

      expect(out).toContain("Gemination Studio GUI Ready");
      const urlMatch = out.match(/Studio UI URL:\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
      const mcpMatch = out.match(/Local MCP URL:\s+(http:\/\/127\.0\.0\.1:\d+\/mcp)/);
      expect(urlMatch).not.toBeNull();
      expect(mcpMatch).not.toBeNull();
      expect(urlMatch![1]).not.toBe(mcpMatch![1]!.replace(/\/mcp$/, "/"));
      const res = await fetch(urlMatch![1]!);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Gemination");
      const mcpRoot = await fetch(mcpMatch![1]!.replace(/\/mcp$/, "/"));
      expect(mcpRoot.status).toBe(404);
      const studioStatus = await fetch(`${urlMatch![1]!}_local/status`);
      expect(studioStatus.status).toBe(200);
      const studioJson = (await studioStatus.json()) as {
        tunnelState?: { state?: string; mode?: string };
      };
      expect(studioJson.tunnelState?.state).toBe("idle");
      expect(studioJson.tunnelState?.mode).toBe("none");
      expect(existsSync(join(cfgDir, "config.json"))).toBe(true);
      expect(existsSync(join(cfgDir, "state.json"))).toBe(true);
    } finally {
      reader.releaseLock();
      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0);
    }
  });

  test("serve --tunnel none ignores stale saved publicUrl and starts local-only", async () => {
    const cfgDir = makeTempDir("gemination-local-none-");
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        port: 0,
        host: "127.0.0.1",
        roots: [cfgDir],
        tunnelMode: "custom",
        publicUrl: "https://stale-custom.example.com",
        allowShell: true,
        allowWrite: true,
        shieldSecrets: true,
        keepAwake: false,
        extraRedirectHosts: [],
        commandTimeoutMs: 30000,
        maxOutputBytes: 65536,
      }),
      "utf8",
    );

    const proc = Bun.spawn(
      ["bun", "run", "src/cli.ts", "serve", "--tunnel", "none", "--no-prompt", "--config-dir", cfgDir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GEMINATION_PIN: "",
          GEMINATION_SKIP_PROBE: "1",
          GEMINATION_NO_CAFFEINATE: "1",
        },
      },
    );

    let out = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) out += decoder.decode(value, { stream: true });
        if (out.includes("Press Ctrl+C to stop.")) break;
      }

      expect(out).not.toContain("stale-custom.example.com");
      expect(out).toMatch(/Gemini MCP URL:\s+http:\/\/127\.0\.0\.1:\d+\/mcp/);
    } finally {
      reader.releaseLock();
      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0);
    }
  });
});
