import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { defaultConfig } from "../src/config.ts";
import {
  extractTailscaleEnableUrl,
  extractTailscaleFunnelUrl,
  findTailscaleBinary,
  inspectTailscaleStatus,
  parseTailscaleStatusJson,
  startCloudflaredQuickTunnel,
  startTailscaleFunnel,
  type TailscaleStatusInfo,
} from "../src/tunnel.ts";
import {
  formatTunnelMenu,
  getDefaultMenuChoice,
  normalizeCustomPublicUrl,
  promptTunnelSelection,
} from "../src/tunnel-selector.ts";
import { makeMockCli } from "./helpers/mock-cli.ts";

const tempDirs: string[] = [];

function makeTempScript(filename: string, jsBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gemination-tunnel-test-"));
  tempDirs.push(dir);
  return makeMockCli(dir, filename, jsBody);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore transient Windows binary lock immediately after process kill.
    }
  }
});

describe("Tailscale status & URL helpers", () => {
  test("parses Running status JSON, strips trailing dot, detects HTTPS & Funnel caps", () => {
    const raw = JSON.stringify({
      BackendState: "Running",
      Self: {
        DNSName: "my-mac.tail1234.ts.net.",
        CapMap: {
          https: [],
          "https://tailscale.com/cap/funnel": [],
        },
      },
    });

    const defaultPort = parseTailscaleStatusJson(raw, 443);
    expect(defaultPort.running).toBe(true);
    expect(defaultPort.dnsName).toBe("my-mac.tail1234.ts.net");
    expect(defaultPort.publicUrl).toBe("https://my-mac.tail1234.ts.net");
    expect(defaultPort.httpsEnabled).toBe(true);
    expect(defaultPort.funnelCapabilityDetected).toBe(true);

    const altPort = parseTailscaleStatusJson(raw, 8443);
    expect(altPort.publicUrl).toBe("https://my-mac.tail1234.ts.net:8443");
  });

  test("handles Stopped backend state and missing DNSName cleanly", () => {
    const stopped = parseTailscaleStatusJson(JSON.stringify({ BackendState: "Stopped" }));
    expect(stopped.running).toBe(false);
    expect(stopped.dnsName).toBeUndefined();
    expect(stopped.publicUrl).toBeUndefined();

    const noDns = parseTailscaleStatusJson(JSON.stringify({ BackendState: "Running", Self: {} }));
    expect(noDns.running).toBe(true);
    expect(noDns.dnsName).toBeUndefined();
  });

  test("extracts only ts.net funnel URLs and Tailscale admin enable links", () => {
    expect(extractTailscaleFunnelUrl("  https://mac.tail95.ts.net/  ")).toBe("https://mac.tail95.ts.net");
    expect(extractTailscaleFunnelUrl("Available: https://mac.tail95.ts.net:8443/")).toBe("https://mac.tail95.ts.net:8443");
    expect(extractTailscaleFunnelUrl("https://tailscale.com/kb/1247/funnel")).toBeNull();
    expect(extractTailscaleFunnelUrl("https://login.tailscale.com/f/funnel?node=abc")).toBeNull();

    expect(extractTailscaleEnableUrl("To enable, visit: https://login.tailscale.com/f/funnel?node=123.")).toBe(
      "https://login.tailscale.com/f/funnel?node=123",
    );
    expect(extractTailscaleEnableUrl("https://example.com/nope")).toBeNull();
  });

  test("findTailscaleBinary honors TAILSCALE_BIN override", () => {
    const fakeBin = makeTempScript("fake-tailscale", "process.exit(0);\n");
    expect(findTailscaleBinary({ TAILSCALE_BIN: fakeBin })).toBe(fakeBin);
  });

  test("startTailscaleFunnel resolves funnel URL and cleans up cleanly", async () => {
    const fakeTailscale = makeTempScript(
      "tailscale-ok",
      `const cmd = process.argv[2];
if (cmd === "status") {
  console.log('{"BackendState":"Running","Self":{"DNSName":"mock-mac.tail999.ts.net.","CapMap":{"https":[]}}}');
  process.exit(0);
}
if (cmd === "funnel") {
  console.log("Available on the internet:");
  console.log("https://mock-mac.tail999.ts.net/");
  console.log("|-- proxy " + (process.argv[4] ?? ""));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`,
    );

    const status = inspectTailscaleStatus(443, fakeTailscale);
    expect(status.running).toBe(true);
    expect(status.publicUrl).toBe("https://mock-mac.tail999.ts.net");

    const handle = await startTailscaleFunnel("http://127.0.0.1:3847", {
      binary: fakeTailscale,
      timeoutMs: 5_000,
    });
    expect(handle.provider).toBe("tailscale");
    expect(handle.publicUrl).toBe("https://mock-mac.tail999.ts.net");
    await handle.stop();
  });

  test("startTailscaleFunnel surfaces admin enable URL notice before funnel URL arrives", async () => {
    const fakeTailscale = makeTempScript(
      "tailscale-activate",
      `const cmd = process.argv[2];
if (cmd === "status") {
  console.log('{"BackendState":"Running","Self":{"DNSName":"activate-mac.tail999.ts.net.","CapMap":{"https":[]}}}');
  process.exit(0);
}
if (cmd === "funnel") {
  console.log("Funnel is not enabled on your tailnet.");
  console.log("To enable, visit https://login.tailscale.com/f/funnel?node=n123");
  await new Promise((r) => setTimeout(r, 100));
  console.log("https://activate-mac.tail999.ts.net/");
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`,
    );

    const notices: string[] = [];
    const handle = await startTailscaleFunnel("http://127.0.0.1:3847", {
      binary: fakeTailscale,
      timeoutMs: 5_000,
      onNotice: (msg) => notices.push(msg),
    });
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("https://login.tailscale.com/f/funnel?node=n123");
    expect(handle.publicUrl).toBe("https://activate-mac.tail999.ts.net");
    await handle.stop();
  });

  test("startTailscaleFunnel fails clearly when Tailscale is stopped", async () => {
    const fakeTailscale = makeTempScript(
      "tailscale-stopped",
      `if (process.argv[2] === "status") {
  console.log('{"BackendState":"Stopped"}');
  process.exit(0);
}
process.exit(1);
`,
    );

    await expect(
      startTailscaleFunnel("http://127.0.0.1:3847", { binary: fakeTailscale }),
    ).rejects.toThrow("실행/로그인되어 있지 않습니다");
  });

  test("startTailscaleFunnel aborts in-flight startup promptly when AbortSignal fires", async () => {
    const fakeTailscale = makeTempScript(
      "tailscale-hang",
      `const cmd = process.argv[2];
if (cmd === "status") {
  console.log('{"BackendState":"Running","Self":{"DNSName":"hang-mac.tail999.ts.net.","CapMap":{"https":[]}}}');
  process.exit(0);
}
if (cmd === "funnel") {
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    const started = Date.now();
    try {
      await expect(
        startTailscaleFunnel("http://127.0.0.1:3847", {
          binary: fakeTailscale,
          timeoutMs: 30_000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("aborted");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe("Tunnel selector & custom URL normalization", () => {
  const readyTailscale: TailscaleStatusInfo = {
    binary: "/usr/local/bin/tailscale",
    installed: true,
    running: true,
    dnsName: "node.tailnet.ts.net",
    publicUrl: "https://node.tailnet.ts.net",
    httpsEnabled: true,
    funnelCapabilityDetected: true,
    detail: "준비됨 · https://node.tailnet.ts.net",
  };

  const missingTailscale: TailscaleStatusInfo = {
    binary: null,
    installed: false,
    running: false,
    httpsEnabled: false,
    funnelCapabilityDetected: false,
    detail: "미설치",
  };

  test("normalizeCustomPublicUrl validates HTTPS and strips trailing /mcp", () => {
    expect(normalizeCustomPublicUrl("https://mcp.example.com/")).toEqual({
      ok: true,
      url: "https://mcp.example.com",
      strippedMcpSuffix: false,
    });
    expect(normalizeCustomPublicUrl("https://mcp.example.com/mcp")).toEqual({
      ok: true,
      url: "https://mcp.example.com",
      strippedMcpSuffix: true,
    });
    expect(normalizeCustomPublicUrl("http://insecure.example.com").ok).toBe(false);
    expect(normalizeCustomPublicUrl("not-a-url").ok).toBe(false);
  });

  test("menu renders Quick Tunnel restart warning and Tailscale fixed-URL guidance", () => {
    const cfg = defaultConfig();
    const defaultChoice = getDefaultMenuChoice(cfg, {
      tailscale: readyTailscale,
      cloudflaredBinary: "/usr/local/bin/cloudflared",
    });
    expect(defaultChoice).toBe("1");

    const text = formatTunnelMenu({
      config: cfg,
      tailscale: readyTailscale,
      cloudflaredBinary: "/usr/local/bin/cloudflared",
      defaultChoice,
    });
    expect(text).toContain("Tailscale Funnel");
    expect(text).toContain("Cloudflare Quick Tunnel");
    expect(text).toContain("서버를 껐다 켜면 URL이 매번 바뀌므로");
    expect(text).toContain("다시 등록해야 합니다");
  });

  test("promptTunnelSelection supports choices 1, 2, 3 (+/mcp strip), 4, retry on missing tool, and cancel", async () => {
    const runPrompt = async (
      lines: string[],
      ts = readyTailscale,
      cf: string | null = "/opt/homebrew/bin/cloudflared",
    ) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let rendered = "";
      output.on("data", (chunk) => {
        rendered += Buffer.from(chunk).toString("utf8");
      });
      input.end(`${lines.join("\n")}\n`);
      const result = await promptTunnelSelection({
        config: defaultConfig(),
        tailscale: ts,
        cloudflaredBinary: cf,
        input,
        output,
      });
      return { result, rendered };
    };

    const pick1 = await runPrompt(["1"]);
    expect(pick1.result).toEqual({ cancelled: false, mode: "tailscale", httpsPort: 443 });

    const pick2 = await runPrompt(["2"]);
    expect(pick2.result).toEqual({ cancelled: false, mode: "quick" });

    const pick3 = await runPrompt(["3", "https://my.domain.com/mcp"]);
    expect(pick3.result).toEqual({ cancelled: false, mode: "custom", publicUrl: "https://my.domain.com" });
    expect(pick3.rendered).toContain("자동으로 제거");

    const retryMissing = await runPrompt(["1", "4"], missingTailscale, null);
    expect(retryMissing.rendered).toContain("Tailscale이 설치되어 있지 않습니다");
    expect(retryMissing.result).toEqual({ cancelled: false, mode: "none" });

    const cancel = await runPrompt(["q"]);
    expect(cancel.result).toEqual({ cancelled: true });
  });
});

describe("Cloudflare Quick Tunnel", () => {
  test("passes an isolated empty --config file and cleans it up on stop", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "gemination-quick-report-"));
    tempDirs.push(reportDir);
    const reportPath = join(reportDir, "report.json");

    const fakeCloudflared = makeTempScript(
      "cloudflared-ok",
      `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const cfgIdx = args.indexOf("--config");
const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : null;
const configContent = cfgPath ? readFileSync(cfgPath, "utf8") : null;
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ args, cfgPath, configContent }), "utf8");
console.log("INF | +--------------------------------------------------------------------------------------------+");
console.log("INF |  https://mock-quick-tunnel.trycloudflare.com                                               |");
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );

    const handle = await startCloudflaredQuickTunnel("http://127.0.0.1:3847", {
      binary: fakeCloudflared,
      timeoutMs: 5_000,
    });
    expect(handle.provider).toBe("quick");
    expect(handle.publicUrl).toBe("https://mock-quick-tunnel.trycloudflare.com");

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      args: string[];
      cfgPath: string | null;
      configContent: string | null;
    };
    expect(report.cfgPath).toBeTruthy();
    expect(report.args).toEqual([
      "tunnel",
      "--config",
      report.cfgPath!,
      "--url",
      "http://127.0.0.1:3847",
      "--no-autoupdate",
    ]);
    expect(report.configContent?.trim()).toBe("{}");
    expect(existsSync(report.cfgPath!)).toBe(true);

    await handle.stop();
    expect(existsSync(report.cfgPath!)).toBe(false);
    expect(existsSync(dirname(report.cfgPath!))).toBe(false);
  });

  test("cleans up temporary --config directory if cloudflared exits unexpectedly", async () => {
    const reportDir = mkdtempSync(join(tmpdir(), "gemination-quick-fail-"));
    tempDirs.push(reportDir);
    const reportPath = join(reportDir, "report.json");

    const fakeCloudflared = makeTempScript(
      "cloudflared-fail",
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const cfgIdx = args.indexOf("--config");
const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : null;
writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ cfgPath }), "utf8");
console.error("simulated startup failure");
process.exit(1);
`,
    );

    await expect(
      startCloudflaredQuickTunnel("http://127.0.0.1:3847", {
        binary: fakeCloudflared,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("cloudflared exited unexpectedly with code 1");

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { cfgPath: string | null };
    expect(report.cfgPath).toBeTruthy();
    expect(existsSync(report.cfgPath!)).toBe(false);
    expect(existsSync(dirname(report.cfgPath!))).toBe(false);
  });
});
