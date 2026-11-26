import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfigDir } from "../src/config.ts";
import { startGeminationHttpServer } from "../src/http-server.ts";
import {
  acquireInstanceLock,
  InstanceAlreadyRunningError,
  LOCK_FILENAME,
  readInstanceLock,
} from "../src/lock.ts";
import { OAuthServer } from "../src/oauth.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { AuditLogger } from "../src/security.ts";
import { TunnelController } from "../src/tunnel-controller.ts";
import {
  getBackgroundServiceStatus,
  getLaunchAgentStatus,
  installBackgroundService,
  installLaunchAgent,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
  renderWindowsStartupVbs,
  uninstallBackgroundService,
  uninstallLaunchAgent,
} from "../src/service.ts";
import { probePublicEndpoint } from "../src/tunnel.ts";

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

describe("Profile config resolution, lockfile, and LaunchAgent helpers", () => {
  test("resolveConfigDir isolates named profiles and rejects invalid names or conflicts", () => {
    const prevEnv = process.env.GEMINATION_CONFIG_DIR;
    const baseDir = makeTempDir("gemination-profiles-base-");
    process.env.GEMINATION_CONFIG_DIR = baseDir;
    try {
      expect(resolveConfigDir({ profile: "work-1" })).toBe(join(baseDir, "profiles", "work-1"));
      expect(() => resolveConfigDir({ profile: "../evil" })).toThrow();
      expect(() => resolveConfigDir({ configDir: baseDir, profile: "work" })).toThrow();
    } finally {
      if (prevEnv === undefined) delete process.env.GEMINATION_CONFIG_DIR;
      else process.env.GEMINATION_CONFIG_DIR = prevEnv;
    }
  });

  test("acquireInstanceLock detects live owner, recovers stale lock, and verifies ownership on release", () => {
    const cfgDir = makeTempDir("gemination-lock-test-");

    const lock1 = acquireInstanceLock(cfgDir, { port: 3847, tunnelMode: "none" });
    lock1.update({ localBaseUrl: "http://127.0.0.1:3847", publicBaseUrl: "https://demo.ts.net" });
    expect(readInstanceLock(cfgDir).running).toBe(true);

    expect(() => acquireInstanceLock(cfgDir, { port: 3848 })).toThrow(InstanceAlreadyRunningError);
    lock1.release();
    expect(readInstanceLock(cfgDir).running).toBe(false);

    // Simulate crashed dead PID lockfile
    writeFileSync(
      join(cfgDir, LOCK_FILENAME),
      JSON.stringify({ pid: 999999, instanceId: "dead-inst", port: 3847, startedAt: new Date().toISOString() }),
      "utf8",
    );
    const lock2 = acquireInstanceLock(cfgDir, { port: 3847 });
    expect(readInstanceLock(cfgDir).running).toBe(true);
    lock2.release();
    expect(existsSync(join(cfgDir, LOCK_FILENAME))).toBe(false);
  });

  test("LaunchAgent plist generation, install, status, and uninstall work in isolated temp dir", () => {
    if (process.platform !== "darwin") return;
    const cfgDir = makeTempDir("gemination-svc-cfg-");
    const agentsDir = makeTempDir("gemination-svc-agents-");

    const plist = renderLaunchAgentPlist({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "tailscale",
      profile: "personal",
      bunPath: "/opt/homebrew/bin/bun",
      launchAgentsDir: agentsDir,
      skipLaunchctl: true,
    });
    expect(plist).toContain("<string>com.gemination.agent.personal</string>");
    expect(plist).toContain("<string>--tunnel</string>");
    expect(plist).toContain("<string>tailscale</string>");
    expect(plist).toContain("<string>--no-prompt</string>");

    const installed = installLaunchAgent({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "tailscale",
      profile: "personal",
      launchAgentsDir: agentsDir,
      skipLaunchctl: true,
    });
    expect(installed.installed).toBe(true);
    expect(existsSync(installed.plistPath)).toBe(true);

    const status = getLaunchAgentStatus({
      configDir: cfgDir,
      profile: "personal",
      launchAgentsDir: agentsDir,
      skipLaunchctl: true,
    });
    expect(status.installed).toBe(true);

    const un = uninstallLaunchAgent({
      configDir: cfgDir,
      profile: "personal",
      launchAgentsDir: agentsDir,
      skipLaunchctl: true,
    });
    expect(un.removed).toBe(true);
    expect(un.status.installed).toBe(false);
  });

  test("Cross-platform background service render, install, status, and uninstall work for systemd & Windows Startup", () => {
    const cfgDir = makeTempDir("gemination-xsvc-cfg-");
    const unitDir = makeTempDir("gemination-xsvc-unit-");
    const startupDir = makeTempDir("gemination-xsvc-win-");

    const unit = renderSystemdUserUnit({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "tailscale",
      profile: "linux-prof",
      bunPath: "/usr/local/bin/bun",
      serviceDir: unitDir,
      platform: "linux",
      skipServiceControl: true,
    });
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("GEMINATION_SERVICE_MODE=1");
    expect(unit).toContain('"--tunnel" "tailscale"');

    const vbs = renderWindowsStartupVbs({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "tailscale",
      profile: "win-prof",
      bunPath: "C:\\Users\\demo\\.bun\\bin\\bun.exe",
      serviceDir: startupDir,
      platform: "win32",
      skipServiceControl: true,
    });
    expect(vbs).toContain("WScript.Shell");
    expect(vbs).toContain('env("GEMINATION_SERVICE_MODE") = "1"');
    expect(vbs).toContain("--no-prompt");

    const linInstall = installBackgroundService({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "none",
      profile: "linux-prof",
      serviceDir: unitDir,
      platform: "linux",
      skipServiceControl: true,
    });
    expect(linInstall.kind).toBe("systemd");
    expect(linInstall.installed).toBe(true);
    expect(existsSync(linInstall.servicePath)).toBe(true);
    const linStatus = getBackgroundServiceStatus({
      configDir: cfgDir,
      profile: "linux-prof",
      serviceDir: unitDir,
      platform: "linux",
      skipServiceControl: true,
    });
    expect(linStatus.installed).toBe(true);
    const linUn = uninstallBackgroundService({
      configDir: cfgDir,
      profile: "linux-prof",
      serviceDir: unitDir,
      platform: "linux",
      skipServiceControl: true,
    });
    expect(linUn.removed).toBe(true);

    const winInstall = installBackgroundService({
      projectRoot: process.cwd(),
      configDir: cfgDir,
      port: 3847,
      tunnelMode: "none",
      profile: "win-prof",
      serviceDir: startupDir,
      platform: "win32",
      skipServiceControl: true,
    });
    expect(winInstall.kind).toBe("windows-startup");
    expect(winInstall.installed).toBe(true);
    expect(existsSync(winInstall.servicePath)).toBe(true);
    const winUn = uninstallBackgroundService({
      configDir: cfgDir,
      profile: "win-prof",
      serviceDir: startupDir,
      platform: "win32",
      skipServiceControl: true,
    });
    expect(winUn.removed).toBe(true);
  });

  test("probePublicEndpoint verifies valid RFC 9728 metadata and flags errors", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({ resource: `${url.origin}/mcp` });
        }
        return new Response("no", { status: 404 });
      },
    });
    try {
      const ok = await probePublicEndpoint(`http://127.0.0.1:${server.port}`, {
        maxAttempts: 1,
        skipDnsWait: true,
      });
      expect(ok.ok).toBe(true);
      expect(ok.status).toBe(200);

      const fail = await probePublicEndpoint("http://127.0.0.1:1", {
        maxAttempts: 1,
        timeoutMs: 600,
        skipDnsWait: true,
      });
      expect(fail.ok).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});

describe("Local-only management dashboard & control endpoints", () => {
  test("dashboard blocks proxied/external requests, gates POSTs with CSRF, and mutates settings/roots/PIN/tokens", async () => {
    const ws1 = realpathSync(makeTempDir("gemination-dash-ws1-"));
    const ws2 = realpathSync(makeTempDir("gemination-dash-ws2-"));
    const cfgDir = makeTempDir("gemination-dash-cfg-");

    const cfg = defaultConfig();
    cfg.port = 0;
    cfg.roots = [ws1];
    const oauth = new OAuthServer(cfgDir, cfg);
    const initialPin = oauth.resetPin("2345-6789-ABCD");
    const pm = new ProcessManager();
    const audit = new AuditLogger(cfgDir);
    audit.log({ tool: "read_file", ok: true, durationMs: 4, summary: "read README.md" });

    const server = startGeminationHttpServer({
      config: cfg,
      configDir: cfgDir,
      oauth,
      audit,
      processManager: pm,
      initialPublicBaseUrl: "https://demo-node.tail999.ts.net",
      runtimeMeta: {
        tunnelMode: "tailscale",
        keepAwake: true,
        initialPin,
      },
    });
    const tunnelController = new TunnelController({
      config: cfg,
      configDir: cfgDir,
      serverHandle: server,
    });
    server.setTunnelController(tunnelController);

    const studioBase = server.studioBaseUrl;
    const mcpBase = server.localBaseUrl;

    try {
      // 1a. Public/tunneled MCP listener MUST NOT serve "/" or "/_local/*" even on direct loopback
      const mcpRootRes = await fetch(`${mcpBase}/`);
      expect(mcpRootRes.status).toBe(404);
      expect(mcpRootRes.headers.get("access-control-allow-origin")).toBeNull();

      const mcpLocalRes = await fetch(`${mcpBase}/_local/status`);
      expect(mcpLocalRes.status).toBe(404);

      const mcpAssetRes = await fetch(`${mcpBase}/_local/assets/styles.css`);
      expect(mcpAssetRes.status).toBe(404);

      const healthRes = await fetch(`${mcpBase}/healthz`);
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers.get("access-control-allow-origin")).toBeNull();
      const healthJson = (await healthRes.json()) as Record<string, unknown>;
      expect(healthJson.ok).toBe(true);
      expect(healthJson.publicBaseUrl).toBeUndefined();
      expect(healthJson.mcpUrl).toBeUndefined();

      // 1b. Studio listener rejects proxied, wrong-host, cross-site, and OPTIONS requests with no CORS
      const viaCf = await fetch(`${studioBase}/`, {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      });
      expect(viaCf.status).toBe(404);

      const viaWrongHost = await fetch(`${studioBase}/_local/status`, {
        headers: { Host: "demo-node.tail999.ts.net" },
      });
      expect(viaWrongHost.status).toBe(404);

      const viaCrossSite = await fetch(`${studioBase}/_local/status`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(viaCrossSite.status).toBe(404);

      const optionsRes = await fetch(`${studioBase}/_local/status`, { method: "OPTIONS" });
      expect(optionsRes.status).toBe(405);
      expect(optionsRes.headers.get("access-control-allow-origin")).toBeNull();

      // 2. Direct loopback GET "/" + CSS/JS assets on Studio port return 200 without CORS
      const dashRes = await fetch(`${studioBase}/`);
      expect(dashRes.status).toBe(200);
      expect(dashRes.headers.get("access-control-allow-origin")).toBeNull();
      const html = await dashRes.text();
      expect(html).toContain("Gemination");
      const tokenMatch = html.match(/<meta name="gemination-csrf" content="([a-f0-9]+)">/);
      expect(tokenMatch).not.toBeNull();
      const csrf = tokenMatch![1]!;

      const cssRes = await fetch(`${studioBase}/_local/assets/styles.css`);
      expect(cssRes.status).toBe(200);
      expect(await cssRes.text()).toContain("--page:");

      const jsRes = await fetch(`${studioBase}/_local/assets/app.js`);
      expect(jsRes.status).toBe(200);
      expect(await jsRes.text()).toContain("CSRF_TOKEN");

      // 3. Direct GET /_local/status returns state + OAuth events/clients + browser profile + recentAudit
      const statusRes = await fetch(`${studioBase}/_local/status`);
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        mcpUrl: string;
        studioBaseUrl: string;
        latestPin: string;
        oauthClients: Array<{ clientId: string }>;
        oauthEvents: Array<{ kind: string }>;
        browserProfile: { profileDir: string };
        recentAudit: Array<{ tool: string }>;
      };
      expect(statusJson.mcpUrl).toBe("https://demo-node.tail999.ts.net/mcp");
      expect(statusJson.studioBaseUrl).toBe(studioBase);
      expect(statusJson.latestPin).toBe("2345-6789-ABCD");
      expect(statusJson.oauthClients.length).toBeGreaterThanOrEqual(1);
      expect(statusJson.oauthEvents.length).toBeGreaterThanOrEqual(1);
      expect(statusJson.browserProfile.profileDir).toContain("browser-profile");
      expect(statusJson.recentAudit[0]?.tool).toBe("read_file");

      // 3b. Workspace file explorer & Secret Shield preview + path traversal rejection
      writeFileSync(
        join(ws1, "secret.env"),
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\nPORT=3847\n",
        "utf8",
      );
      const filesRes = await fetch(`${studioBase}/_local/files?root=${encodeURIComponent(ws1)}`);
      expect(filesRes.status).toBe(200);
      const filesJson = (await filesRes.json()) as { entries: Array<{ name: string }> };
      expect(filesJson.entries.some((e) => e.name === "secret.env")).toBe(true);

      const previewRes = await fetch(
        `${studioBase}/_local/file-content?root=${encodeURIComponent(ws1)}&path=${encodeURIComponent(join(ws1, "secret.env"))}`,
      );
      expect(previewRes.status).toBe(200);
      const previewJson = (await previewRes.json()) as { content: string };
      expect(previewJson.content).toContain("[OpenAI key hidden]");
      expect(previewJson.content).not.toContain("sk-proj-");

      const outsideFile = join(makeTempDir("gemination-outside-"), "outside.txt");
      writeFileSync(outsideFile, "outside\n", "utf8");
      const traversalRes = await fetch(
        `${studioBase}/_local/file-content?root=${encodeURIComponent(ws1)}&path=${encodeURIComponent(outsideFile)}`,
      );
      expect(traversalRes.status).toBe(403);

      const gitRes = await fetch(`${studioBase}/_local/git?root=${encodeURIComponent(ws1)}`);
      expect(gitRes.status).toBe(200);

      // 3c. Runtime TunnelController start (custom + none) & stop via Studio API
      const prevSkip = process.env.GEMINATION_SKIP_PROBE;
      process.env.GEMINATION_SKIP_PROBE = "1";
      try {
        const startCustomRes = await fetch(`${studioBase}/_local/tunnel/start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Gemination-Local-Token": csrf,
          },
          body: JSON.stringify({ mode: "custom", publicUrl: "https://studio-custom.example.com/mcp" }),
        });
        expect(startCustomRes.status).toBe(200);
        expect(server.getPublicBaseUrl()).toBe("https://studio-custom.example.com");

        const stopTunnelRes = await fetch(`${studioBase}/_local/tunnel/stop`, {
          method: "POST",
          headers: { "X-Gemination-Local-Token": csrf },
        });
        expect(stopTunnelRes.status).toBe(200);
        expect(server.getPublicBaseUrl()).toBe(server.localBaseUrl);
      } finally {
        if (prevSkip === undefined) delete process.env.GEMINATION_SKIP_PROBE;
        else process.env.GEMINATION_SKIP_PROBE = prevSkip;
      }

      // 3d. Process manager stop endpoint
      const procInfo = pm.start('bun -e "setInterval(() => {}, 1000)"', ws1);
      const stopProcRes = await fetch(`${studioBase}/_local/processes/stop`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemination-Local-Token": csrf,
        },
        body: JSON.stringify({ id: procInfo.id }),
      });
      expect(stopProcRes.status).toBe(200);

      // 4. POST without CSRF fails with 403
      const noCsrf = await fetch(`${studioBase}/_local/rotate-pin`, { method: "POST" });
      expect(noCsrf.status).toBe(403);

      // 5. POST with CSRF rotates PIN, toggles settings, manages roots, revokes tokens
      const rotRes = await fetch(`${studioBase}/_local/rotate-pin`, {
        method: "POST",
        headers: { "X-Gemination-Local-Token": csrf },
      });
      expect(rotRes.status).toBe(200);
      const rotJson = (await rotRes.json()) as { pin: string };
      expect(rotJson.pin).not.toBe("2345-6789-ABCD");

      const settingsRes = await fetch(`${studioBase}/_local/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemination-Local-Token": csrf,
        },
        body: JSON.stringify({ allowWrite: false, shieldSecrets: false }),
      });
      expect(settingsRes.status).toBe(200);
      const savedCfg = JSON.parse(readFileSync(join(cfgDir, "config.json"), "utf8")) as {
        allowWrite: boolean;
        shieldSecrets: boolean;
      };
      expect(savedCfg.allowWrite).toBe(false);
      expect(savedCfg.shieldSecrets).toBe(false);

      const addRootRes = await fetch(`${studioBase}/_local/roots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemination-Local-Token": csrf,
        },
        body: JSON.stringify({ action: "add", path: ws2 }),
      });
      expect(addRootRes.status).toBe(200);
      expect(cfg.roots).toContain(ws2);

      const rmRootRes = await fetch(`${studioBase}/_local/roots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemination-Local-Token": csrf,
        },
        body: JSON.stringify({ action: "remove", path: ws1 }),
      });
      expect(rmRootRes.status).toBe(200);
      expect(cfg.roots).toEqual([ws2]);

      // Removing last remaining root must fail
      const rmLastRes = await fetch(`${studioBase}/_local/roots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemination-Local-Token": csrf,
        },
        body: JSON.stringify({ action: "remove", path: ws2 }),
      });
      expect(rmLastRes.status).toBe(400);

      const revokeRes = await fetch(`${studioBase}/_local/revoke-all`, {
        method: "POST",
        headers: { "X-Gemination-Local-Token": csrf },
      });
      expect(revokeRes.status).toBe(200);
    } finally {
      pm.stopAll();
      await server.stop();
    }
  });
});
