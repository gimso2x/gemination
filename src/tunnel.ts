import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTunnelInstallHint, killProcessGracefully } from "./platform.ts";
import type { TailscaleFunnelPort } from "./types.ts";

export interface TunnelHandle {
  provider: "quick" | "tailscale";
  publicUrl: string;
  stop: () => Promise<void>;
}

export interface QuickTunnelOptions {
  binary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TailscaleStatusInfo {
  binary: string | null;
  installed: boolean;
  running: boolean;
  backendState?: string;
  dnsName?: string;
  publicUrl?: string;
  httpsEnabled: boolean;
  funnelCapabilityDetected: boolean;
  detail: string;
}

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TAILSCALE_FUNNEL_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net(?::\d+)?/i;
const TAILSCALE_ENABLE_URL_RE = /https:\/\/login\.tailscale\.com\/[^\s]+/i;
const MACOS_TAILSCALE_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function collectProcessStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream || typeof stream === "number") return Promise.resolve();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          onLine(line);
        }
      }
      if (buffer.trim()) {
        onLine(buffer);
      }
    } catch {
      // Stream terminated.
    } finally {
      reader.releaseLock();
    }
  })();
}

export async function startCloudflaredQuickTunnel(
  localUrl: string,
  timeoutOrOptions: number | QuickTunnelOptions = 30_000,
): Promise<TunnelHandle> {
  const opts: QuickTunnelOptions =
    typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signal = opts.signal;

  if (signal?.aborted) {
    throw new Error("Tunnel startup aborted");
  }

  const binary = opts.binary ?? findCloudflaredBinary();
  if (!binary) {
    throw new Error(
      `cloudflared 실행 파일을 찾을 수 없습니다. \`${getTunnelInstallHint("cloudflared")}\`로 설치하거나 Tailscale Funnel / \`--tunnel none --public-url <url>\`을 선택하세요.`,
    );
  }

  // Isolate quick tunnels from host cloudflared config.yml ingress rules (e.g. catch-all 404).
  const tempConfigDir = mkdtempSync(join(tmpdir(), "gemination-cloudflared-"));
  const emptyConfigPath = join(tempConfigDir, "config.yml");
  writeFileSync(emptyConfigPath, "{}\n", { encoding: "utf8", mode: 0o600 });

  let cleaned = false;
  const cleanupTempConfig = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(tempConfigDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of temporary empty config directory.
    }
  };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, "tunnel", "--config", emptyConfigPath, "--url", localUrl, "--no-autoupdate"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
  } catch (err) {
    cleanupTempConfig();
    throw err;
  }

  const logs: string[] = [];
  let settled = false;

  const stop = async (): Promise<void> => {
    killProcessGracefully(proc, false);
    const deadline = setTimeout(() => {
      killProcessGracefully(proc, true);
    }, 2000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(deadline);
      cleanupTempConfig();
    }
  };

  return new Promise<TunnelHandle>((resolve, reject) => {
    const cleanupAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      void stop();
      reject(new Error("Tunnel startup aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      void stop();
      reject(
        new Error(
          `Timed out waiting for cloudflared quick tunnel URL after ${timeoutMs}ms.\nRecent logs:\n${logs.slice(-12).join("\n")}`,
        ),
      );
    }, timeoutMs);

    const handleLine = (line: string): void => {
      if (line.trim()) {
        logs.push(line.trim());
        if (logs.length > 50) logs.shift();
      }
      const match = line.match(TRY_CLOUDFLARE_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        resolve({ provider: "quick", publicUrl: match[0], stop });
      }
    };

    void collectProcessStream(proc.stdout, handleLine);
    void collectProcessStream(proc.stderr, handleLine);
    void proc.exited.then((code) => {
      cleanupTempConfig();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        reject(
          new Error(
            `cloudflared exited unexpectedly with code ${code}.\nRecent logs:\n${logs.slice(-12).join("\n")}`,
          ),
        );
      }
    });
  });
}

export function findCloudflaredBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const override = env.CLOUDFLARED_BIN?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const resolved = Bun.which(override);
    if (resolved) return resolved;
  }

  const fromPath = Bun.which("cloudflared");
  if (fromPath) return fromPath;

  if (platform === "win32") {
    const pf = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim() || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"]?.trim() || env["PROGRAMFILES(X86)"]?.trim() || "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA?.trim() || "";
    for (const candidate of [
      join(pf, "cloudflared", "cloudflared.exe"),
      join(pf86, "cloudflared", "cloudflared.exe"),
      ...(localAppData ? [join(localAppData, "Microsoft", "WinGet", "Links", "cloudflared.exe")] : []),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  if (platform === "darwin") {
    for (const candidate of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) {
      if (existsSync(candidate)) return candidate;
    }
  } else {
    for (const candidate of ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function findTailscaleBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const override = env.TAILSCALE_BIN?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const resolved = Bun.which(override);
    if (resolved) return resolved;
  }

  const fromPath = Bun.which("tailscale");
  if (fromPath) return fromPath;

  if (platform === "darwin" && existsSync(MACOS_TAILSCALE_APP_BIN)) {
    return MACOS_TAILSCALE_APP_BIN;
  }

  if (platform === "win32") {
    const pf = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim() || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"]?.trim() || env["PROGRAMFILES(X86)"]?.trim() || "C:\\Program Files (x86)";
    for (const candidate of [
      join(pf, "Tailscale", "tailscale.exe"),
      join(pf86, "Tailscale", "tailscale.exe"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  } else if (platform === "linux") {
    for (const candidate of ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function parseTailscaleStatusJson(
  rawJson: string,
  httpsPort: TailscaleFunnelPort = 443,
): Omit<TailscaleStatusInfo, "binary" | "installed" | "detail"> {
  const data = JSON.parse(rawJson) as {
    BackendState?: unknown;
    Self?: {
      DNSName?: unknown;
      CapMap?: Record<string, unknown>;
      Capabilities?: unknown[];
    };
  };

  const backendState = typeof data.BackendState === "string" ? data.BackendState : undefined;
  const running = backendState === "Running";

  const rawDns = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.trim() : "";
  const dnsName = rawDns.replace(/\.+$/, "") || undefined;
  const publicUrl = dnsName
    ? httpsPort === 443
      ? `https://${dnsName}`
      : `https://${dnsName}:${httpsPort}`
    : undefined;

  const caps = new Set<string>();
  if (data.Self?.CapMap && typeof data.Self.CapMap === "object") {
    for (const key of Object.keys(data.Self.CapMap)) {
      caps.add(key.toLowerCase());
    }
  }
  if (Array.isArray(data.Self?.Capabilities)) {
    for (const item of data.Self.Capabilities) {
      if (typeof item === "string") {
        caps.add(item.toLowerCase());
      }
    }
  }

  let httpsEnabled = false;
  let funnelCapabilityDetected = false;
  for (const cap of caps) {
    if (cap === "https" || cap.endsWith("/https")) {
      httpsEnabled = true;
    }
    if (cap.includes("funnel")) {
      funnelCapabilityDetected = true;
    }
  }

  return {
    running,
    backendState,
    dnsName,
    publicUrl,
    httpsEnabled,
    funnelCapabilityDetected,
  };
}

function buildTailscaleStatusFromOutput(
  binary: string,
  httpsPort: TailscaleFunnelPort,
  exitCode: number | null,
  rawStdout: string,
): TailscaleStatusInfo {
  if (exitCode !== 0) {
    return {
      binary,
      installed: true,
      running: false,
      httpsEnabled: false,
      funnelCapabilityDetected: false,
      detail: "설치됨 · Tailscale 앱 실행/로그인 필요",
    };
  }

  try {
    const parsed = parseTailscaleStatusJson(rawStdout, httpsPort);
    if (!parsed.running) {
      return {
        binary,
        installed: true,
        ...parsed,
        detail: `설치됨 · 상태: ${parsed.backendState ?? "Stopped"} (Tailscale 앱 실행 후 로그인 필요)`,
      };
    }
    if (!parsed.dnsName || !parsed.publicUrl) {
      return {
        binary,
        installed: true,
        ...parsed,
        detail: "실행 중 · MagicDNS 비활성화 (Tailscale Admin -> DNS에서 MagicDNS 활성화 필요)",
      };
    }
    const detail = parsed.funnelCapabilityDetected
      ? `준비됨 · ${parsed.publicUrl}`
      : `감지됨 · ${parsed.publicUrl} (최초 1회 Funnel 활성화 링크가 표시될 수 있음)`;

    return {
      binary,
      installed: true,
      ...parsed,
      detail,
    };
  } catch {
    return {
      binary,
      installed: true,
      running: false,
      httpsEnabled: false,
      funnelCapabilityDetected: false,
      detail: "설치됨 · Tailscale 상태 조회 실패 (Tailscale 앱 실행/로그인 확인 필요)",
    };
  }
}

export function inspectTailscaleStatus(
  httpsPort: TailscaleFunnelPort = 443,
  binaryOverride?: string | null,
): TailscaleStatusInfo {
  const binary = binaryOverride !== undefined ? binaryOverride : findTailscaleBinary();
  if (!binary) {
    return {
      binary: null,
      installed: false,
      running: false,
      httpsEnabled: false,
      funnelCapabilityDetected: false,
      detail: `미설치 (${getTunnelInstallHint("tailscale")})`,
    };
  }

  const res = Bun.spawnSync([binary, "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    timeout: 5_000,
  });

  return buildTailscaleStatusFromOutput(
    binary,
    httpsPort,
    res.exitCode,
    Buffer.from(res.stdout).toString("utf8"),
  );
}

export async function inspectTailscaleStatusAsync(
  httpsPort: TailscaleFunnelPort = 443,
  binaryOverride?: string | null,
): Promise<TailscaleStatusInfo> {
  const binary = binaryOverride !== undefined ? binaryOverride : findTailscaleBinary();
  if (!binary) {
    return {
      binary: null,
      installed: false,
      running: false,
      httpsEnabled: false,
      funnelCapabilityDetected: false,
      detail: `미설치 (${getTunnelInstallHint("tailscale")})`,
    };
  }

  const proc = Bun.spawn([binary, "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Ignore.
    }
  }, 5_000);
  try {
    const [stdoutBuf, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    return buildTailscaleStatusFromOutput(
      binary,
      httpsPort,
      exitCode,
      Buffer.from(stdoutBuf).toString("utf8"),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function extractTailscaleFunnelUrl(line: string): string | null {
  const match = line.match(TAILSCALE_FUNNEL_URL_RE);
  if (!match) return null;
  return match[0].replace(/\/+$/, "");
}

export function extractTailscaleEnableUrl(line: string): string | null {
  const match = line.match(TAILSCALE_ENABLE_URL_RE);
  if (!match) return null;
  return match[0].replace(/[).,;]+$/, "");
}

export interface TailscaleFunnelOptions {
  httpsPort?: TailscaleFunnelPort;
  timeoutMs?: number;
  activationTimeoutMs?: number;
  binary?: string;
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
}

export async function startTailscaleFunnel(
  localUrl: string,
  options: TailscaleFunnelOptions = {},
): Promise<TunnelHandle> {
  if (options.signal?.aborted) {
    throw new Error("Tunnel startup aborted");
  }

  const httpsPort: TailscaleFunnelPort = options.httpsPort ?? 443;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const activationTimeoutMs = options.activationTimeoutMs ?? 120_000;

  const binary = options.binary ?? findTailscaleBinary();
  if (!binary) {
    throw new Error(
      `Tailscale CLI를 찾을 수 없습니다. \`${getTunnelInstallHint("tailscale")}\`로 설치하고 로그인한 뒤 다시 실행하세요.`,
    );
  }

  const status = await inspectTailscaleStatusAsync(httpsPort, binary);
  if (!status.running) {
    throw new Error(
      `Tailscale이 실행/로그인되어 있지 않습니다 (${status.detail}). Tailscale 앱을 켜고 로그인한 뒤 다시 시도하세요.`,
    );
  }
  if (!status.dnsName) {
    throw new Error(
      "Tailscale MagicDNS 이름을 찾을 수 없습니다. Tailscale Admin -> DNS에서 MagicDNS와 HTTPS Certificates를 활성화하세요.",
    );
  }
  if (options.signal?.aborted) {
    throw new Error("Tunnel startup aborted");
  }

  const proc = Bun.spawn([binary, "funnel", `--https=${httpsPort}`, localUrl], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const logs: string[] = [];
  let settled = false;
  let notifiedEnableUrl = false;

  const stop = async (): Promise<void> => {
    if (process.platform === "win32") {
      killProcessGracefully(proc, false);
    } else {
      try {
        proc.kill("SIGINT");
      } catch {
        // Already exited.
      }
    }
    const termTimer = setTimeout(() => {
      killProcessGracefully(proc, false);
    }, 2500);
    const killTimer = setTimeout(() => {
      killProcessGracefully(proc, true);
    }, 4000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    }
  };

  return new Promise<TunnelHandle>((resolve, reject) => {
    let activeTimeoutMs = timeoutMs;
    const cleanupAbort = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      void stop();
      reject(
        new Error(
          `Tailscale Funnel URL 대기 시간 초과 (${activeTimeoutMs}ms).\nTailscale Admin에서 MagicDNS, HTTPS Certificates, Funnel ACL 허용 여부를 확인하세요.\n최근 로그:\n${logs.slice(-12).join("\n")}`,
        ),
      );
    };

    let timer = setTimeout(() => onTimeout(), activeTimeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      void stop();
      reject(new Error("Tunnel startup aborted"));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed) {
        logs.push(trimmed);
        if (logs.length > 50) logs.shift();
      }

      const enableUrl = extractTailscaleEnableUrl(line);
      if (enableUrl && !notifiedEnableUrl && !settled) {
        notifiedEnableUrl = true;
        clearTimeout(timer);
        activeTimeoutMs = activationTimeoutMs;
        timer = setTimeout(() => onTimeout(), activeTimeoutMs);
        options.onNotice?.(
          `[Tailscale Funnel 활성화 필요] 아래 링크를 브라우저에서 열어 Funnel을 켜면 자동으로 연결이 이어집니다:\n  ${enableUrl}`,
        );
      }

      const funnelUrl = extractTailscaleFunnelUrl(line);
      if (funnelUrl && !settled) {
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        resolve({ provider: "tailscale", publicUrl: funnelUrl, stop });
      }
    };

    void collectProcessStream(proc.stdout, handleLine);
    void collectProcessStream(proc.stderr, handleLine);
    void proc.exited.then((code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanupAbort();
        reject(
          new Error(
            `tailscale funnel 이 예기치 않게 종료되었습니다 (code ${code}).\nTailscale Admin -> DNS (MagicDNS + HTTPS Certificates) 및 Access Controls(nodeAttrs: funnel) 설정을 확인하세요.\n최근 로그:\n${logs.slice(-12).join("\n")}`,
          ),
        );
      }
    });
  });
}

export interface PublicProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  detail: string;
  skipped?: boolean;
}

export interface ProbePublicEndpointOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  skipDnsWait?: boolean;
}

async function waitForCloudflareEdgeDns(hostname: string): Promise<void> {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/i.test(hostname)) {
    return;
  }
  const digBin = Bun.which("dig");
  if (!digBin) {
    await Bun.sleep(2500);
    return;
  }

  for (let i = 0; i < 6; i += 1) {
    const proc = Bun.spawn([digBin, "+short", "@1.1.1.1", "--", hostname], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore.
      }
    }, 2000);
    try {
      const [stdoutBuf, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        proc.exited,
      ]);
      const text = Buffer.from(stdoutBuf).toString("utf8").trim();
      if (exitCode === 0 && text.length > 0) {
        return;
      }
    } finally {
      clearTimeout(timer);
    }
    await Bun.sleep(1000);
  }
}

export async function probePublicEndpoint(
  publicBaseUrl: string,
  options: ProbePublicEndpointOptions = {},
): Promise<PublicProbeResult> {
  if (process.env.GEMINATION_SKIP_PROBE === "1") {
    return {
      ok: true,
      latencyMs: 0,
      detail: "프로브 건너뜀 (GEMINATION_SKIP_PROBE=1)",
      skipped: true,
    };
  }

  const cleanBase = publicBaseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(cleanBase);
  } catch {
    return {
      ok: false,
      latencyMs: 0,
      detail: `잘못된 공개 URL: ${publicBaseUrl}`,
    };
  }

  if (parsed.hostname.endsWith(".trycloudflare.com") && !options.skipDnsWait) {
    await waitForCloudflareEdgeDns(parsed.hostname);
  }

  const probeUrl = `${cleanBase}/.well-known/oauth-protected-resource/mcp`;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const timeoutMs = Math.max(500, options.timeoutMs ?? 5_000);
  const backoffMs = [800, 1500, 2500];
  let lastStatus: number | undefined;
  let lastDetail = "응답 없음";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(probeUrl, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.status === 200) {
        const body = (await res.json()) as { resource?: unknown };
        if (typeof body.resource === "string" && body.resource.endsWith("/mcp")) {
          const latencyMs = Date.now() - started;
          return {
            ok: true,
            status: res.status,
            latencyMs,
            detail: `외부 접속 확인됨 (HTTP 200 · ${latencyMs}ms)`,
          };
        }
        lastDetail = "OAuth 메타데이터 응답 형식 불일치";
      } else {
        lastDetail = `HTTP ${res.status} 응답`;
      }
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) {
      await Bun.sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]!);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    latencyMs: 0,
    detail: `외부 접속 확인 실패 (${lastDetail}) — 방금 터널이 생성되었다면 수 초 후 Gemini에서 연결하세요.`,
  };
}
