import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { version as PKG_VERSION } from "../package.json";
import {
  GEMINI_WEB_URL,
  getBrowserProfileStatus,
  openGeminiLoginWindow,
  openTailscaleApp,
  resetDedicatedBrowserProfile,
} from "./browser-launcher.ts";
import { expandTilde, normalizeRoots, saveConfig } from "./config.ts";
import {
  getDashboardCss,
  getDashboardJs,
  isDirectLocalRequest,
  isLoopbackHostWithoutProxyHeaders,
  isValidLocalCsrf,
  renderDashboardHtml,
} from "./dashboard.ts";
import {
  detectLocalClients,
  isLocalMcpClientId,
  registerLocalClient,
  unregisterLocalClient,
} from "./mcp-clients.ts";
import type { OAuthServer } from "./oauth.ts";
import { getPlatformUiMeta, killProcessGracefully } from "./platform.ts";
import type { KeepAwakeController } from "./power.ts";
import type { ProcessManager } from "./process-manager.ts";
import { maskSecrets } from "./secrets-shield.ts";
import {
  AuditLogger,
  buildSanitizedChildEnv,
  getSensitiveDeniedPaths,
  isPathInside,
  resolveSafePath,
  SecurityError,
} from "./security.ts";
import { getBackgroundServiceStatus } from "./service.ts";
import { isNativeFolderPickerAvailable, pickFolderDialogAsync } from "./setup-wizard.ts";
import { createGeminationMcpServer, SAFE_GIT_ARGS } from "./tools.ts";
import type { TunnelController } from "./tunnel-controller.ts";
import {
  findCloudflaredBinary,
  inspectTailscaleStatusAsync,
  type PublicProbeResult,
  type TailscaleStatusInfo,
} from "./tunnel.ts";
import type { GeminationConfig, TailscaleFunnelPort, TunnelMode } from "./types.ts";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOCAL_PREVIEW_READ_BYTES = 131_072;
const TAILSCALE_CACHE_TTL_MS = 10_000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v);
    }
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function maybeCors(req: Request, serverPort: number, res: Response): Response {
  return isLoopbackHostWithoutProxyHeaders(req, serverPort) ? res : withCors(res);
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function localJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function runGitCommandAsync(
  gitBin: string,
  args: string[],
  cwd: string,
  timeoutMs = 4_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([gitBin, ...SAFE_GIT_ARGS, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...buildSanitizedChildEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => {
    killProcessGracefully(proc, true);
  }, timeoutMs);
  try {
    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);
    return {
      exitCode,
      stdout: Buffer.from(stdoutBuf).toString("utf8"),
      stderr: Buffer.from(stderrBuf).toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ServerRuntimeMeta {
  tunnelMode?: string;
  probeStatus?: PublicProbeResult;
  keepAwake?: boolean;
  initialPin?: string;
  profile?: string;
}

export interface HttpServerOptions {
  config: GeminationConfig;
  configDir: string;
  oauth: OAuthServer;
  audit: AuditLogger;
  processManager: ProcessManager;
  uiPort?: number;
  persistedPort?: number;
  initialPublicBaseUrl?: string;
  runtimeMeta?: ServerRuntimeMeta;
  tunnelController?: TunnelController;
  keepAwakeController?: KeepAwakeController;
}

export interface GeminationHttpServerHandle {
  port: number;
  studioPort: number;
  localBaseUrl: string;
  studioBaseUrl: string;
  getPublicBaseUrl: () => string;
  setPublicBaseUrl: (url: string) => void;
  setRuntimeMeta: (patch: Partial<ServerRuntimeMeta>) => void;
  setTunnelController: (controller: TunnelController) => void;
  rotatePin: () => string;
  getLatestPin: () => string | undefined;
  stop: () => Promise<void>;
}

function collectWorkspaceTree(
  rootDir: string,
  deniedPaths: string[],
  maxDepth = 2,
  maxEntries = 120,
): string[] {
  const lines: string[] = [];
  const skipNames = new Set([".git", "node_modules", ".DS_Store", "dist", "build"]);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

  const walk = (dir: string, relPrefix: string, depth: number): void => {
    if (lines.length >= maxEntries || depth > maxDepth) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (lines.length >= maxEntries) break;
      if (skipNames.has(d.name)) continue;
      const fullPath = join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (deniedPaths.some((denied) => isPathInside(fullPath, denied, process.platform, caseInsensitive))) {
        continue;
      }
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        lines.push(`${rel}/`);
        if (depth < maxDepth) {
          walk(fullPath, rel, depth + 1);
        }
      } else {
        lines.push(rel);
      }
    }
  };

  walk(rootDir, "", 0);
  return lines;
}

export function startGeminationHttpServer(options: HttpServerOptions): GeminationHttpServerHandle {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let explicitPublicBaseUrl = options.initialPublicBaseUrl?.replace(/\/+$/, "");
  const localCsrfToken = randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  let runtimeMeta: ServerRuntimeMeta = { ...(options.runtimeMeta ?? {}) };
  let latestSessionPin: string | undefined = options.runtimeMeta?.initialPin;
  let tunnelController: TunnelController | undefined = options.tunnelController;
  let tailscaleCache: { expiresAt: number; port: TailscaleFunnelPort; info: TailscaleStatusInfo } | null = null;

  options.oauth.setOnPinConsumed(() => {
    latestSessionPin = undefined;
  });

  const persistConfig = (): void => {
    saveConfig(
      {
        ...options.config,
        port: options.persistedPort ?? options.config.port,
      },
      options.configDir,
    );
  };

  const getTailscaleStatusCached = async (httpsPort: TailscaleFunnelPort): Promise<TailscaleStatusInfo> => {
    const now = Date.now();
    if (tailscaleCache && tailscaleCache.port === httpsPort && tailscaleCache.expiresAt > now) {
      return tailscaleCache.info;
    }
    const info = await inspectTailscaleStatusAsync(httpsPort);
    tailscaleCache = {
      expiresAt: now + TAILSCALE_CACHE_TTL_MS,
      port: httpsPort,
      info,
    };
    return info;
  };

  // Listener 1: MCP & OAuth endpoint server (exposed through tunnel) — never serves `/` or `/_local/*`.
  const mcpHttpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: options.config.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    idleTimeout: 120,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const boundPort = mcpHttpServer.port ?? options.config.port;

      if (pathname === "/" || pathname.startsWith("/_local/")) {
        return jsonResponse({ error: "not_found", message: `No route for ${req.method} ${pathname}` }, 404);
      }

      if (req.method === "OPTIONS") {
        if (!isLoopbackHostWithoutProxyHeaders(req, boundPort)) {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return new Response(null, { status: 204 });
      }

      const publicBaseUrl = explicitPublicBaseUrl ?? `http://127.0.0.1:${boundPort}`;

      if (req.method === "GET" && (pathname === "/healthz" || pathname === "/readyz")) {
        return jsonResponse(
          {
            ok: true,
            name: "gemination",
            version: PKG_VERSION,
          },
          200,
          { "Cache-Control": "no-store" },
        );
      }

      if (
        req.method === "GET"
        && (pathname === "/.well-known/oauth-protected-resource"
          || pathname === "/.well-known/oauth-protected-resource/mcp")
      ) {
        return maybeCors(req, boundPort, jsonResponse(options.oauth.getProtectedResourceMetadata(publicBaseUrl)));
      }

      if (
        req.method === "GET"
        && (pathname === "/.well-known/oauth-authorization-server"
          || pathname === "/.well-known/oauth-authorization-server/mcp"
          || pathname === "/.well-known/openid-configuration")
      ) {
        return maybeCors(req, boundPort, jsonResponse(options.oauth.getAuthorizationServerMetadata(publicBaseUrl)));
      }

      if (req.method === "POST" && pathname === "/oauth/register") {
        return await options.oauth.handleRegister(req);
      }

      if (req.method === "GET" && pathname === "/oauth/authorize") {
        return options.oauth.handleAuthorizeGet(url, publicBaseUrl);
      }

      if (req.method === "POST" && pathname === "/oauth/authorize") {
        return await options.oauth.handleAuthorizePost(req, publicBaseUrl);
      }

      if (req.method === "POST" && pathname === "/oauth/token") {
        return maybeCors(req, boundPort, await options.oauth.handleToken(req, publicBaseUrl));
      }

      if (req.method === "POST" && pathname === "/oauth/revoke") {
        return await options.oauth.handleRevoke(req);
      }

      if (pathname === "/mcp") {
        const authResult = options.oauth.verifyBearerToken(
          req.headers.get("authorization"),
          publicBaseUrl,
        );
        if (!authResult.ok) {
          return maybeCors(
            req,
            boundPort,
            jsonResponse(
              {
                error: authResult.error,
                error_description: authResult.errorDescription,
              },
              401,
              {
                "WWW-Authenticate": authResult.wwwAuthenticate,
                "Cache-Control": "no-store",
              },
            ),
          );
        }

        if (req.method !== "POST") {
          return maybeCors(
            req,
            boundPort,
            jsonResponse(
              {
                jsonrpc: "2.0",
                error: { code: -32000, message: "Method not allowed in stateless Streamable HTTP mode" },
                id: null,
              },
              405,
              { Allow: "POST, OPTIONS" },
            ),
          );
        }

        const mcpServer = createGeminationMcpServer({
          config: options.config,
          configDir: options.configDir,
          defaultCwd: options.config.roots[0] ?? process.cwd(),
          audit: options.audit,
          processManager: options.processManager,
          authInfo: authResult.authInfo,
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        try {
          await mcpServer.connect(transport);
          const response = await transport.handleRequest(req, { authInfo: authResult.authInfo });
          return maybeCors(req, boundPort, response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return maybeCors(
            req,
            boundPort,
            jsonResponse(
              {
                jsonrpc: "2.0",
                error: { code: -32603, message },
                id: null,
              },
              500,
            ),
          );
        } finally {
          await Promise.allSettled([transport.close(), mcpServer.close()]);
        }
      }

      return jsonResponse({ error: "not_found", message: `No route for ${req.method} ${pathname}` }, 404);
    },
  });

  const mcpBoundPort = mcpHttpServer.port ?? options.config.port;
  const localBaseUrl = `http://127.0.0.1:${mcpBoundPort}`;
  const requestedUiPort = options.uiPort ?? (options.config.port === 0 ? 0 : mcpBoundPort + 1);

  // Listener 2: Loopback-only Studio UI & `/_local/*` control plane (never exposed through tunnel).
  const studioHttpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: requestedUiPort,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    idleTimeout: 120,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const uiBoundPort = studioHttpServer.port ?? requestedUiPort;

      if (req.method === "OPTIONS") {
        return localJson({ error: "method_not_allowed" }, 405);
      }

      if (!isDirectLocalRequest(req, uiBoundPort)) {
        return localJson({ error: "not_found" }, 404);
      }

      const publicBaseUrl = explicitPublicBaseUrl ?? localBaseUrl;

      if (req.method === "GET" && pathname === "/") {
        return new Response(renderDashboardHtml(localCsrfToken), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (req.method === "GET" && pathname === "/_local/assets/styles.css") {
        return new Response(getDashboardCss(), {
          status: 200,
          headers: {
            "Content-Type": "text/css; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (req.method === "GET" && pathname === "/_local/assets/app.js") {
        return new Response(getDashboardJs(), {
          status: 200,
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (req.method === "GET" && pathname === "/_local/status") {
        const tSnap = tunnelController?.getSnapshot() ?? {
          state: explicitPublicBaseUrl && !explicitPublicBaseUrl.startsWith("http://127.0.0.1") ? "connected" : "idle",
          mode: (runtimeMeta.tunnelMode ?? options.config.tunnelMode ?? "none") as TunnelMode,
          publicUrl: explicitPublicBaseUrl,
          probeStatus: runtimeMeta.probeStatus,
        };
        const tailscaleStatus = await getTailscaleStatusCached(options.config.tailscaleFunnelPort ?? 443);
        const cloudflaredInstalled = Boolean(findCloudflaredBinary());
        const browserProfile = getBrowserProfileStatus(options.configDir);
        const rawProcesses = options.processManager.list();
        const processes = options.config.shieldSecrets
          ? rawProcesses.map((p) => ({ ...p, command: maskSecrets(p.command).text }))
          : rawProcesses;
        const serviceStatus = getBackgroundServiceStatus({
          configDir: options.configDir,
          profile: runtimeMeta.profile,
          skipServiceControl: true,
        });
        const platformMeta = getPlatformUiMeta();
        const folderPickerSupported = isNativeFolderPickerAvailable();
        const localClients = detectLocalClients(projectRoot, options.configDir);

        return localJson({
          ok: true,
          localBaseUrl,
          studioBaseUrl: `http://127.0.0.1:${uiBoundPort}`,
          publicBaseUrl,
          mcpUrl: `${publicBaseUrl}/mcp`,
          tunnelMode: tSnap.mode,
          tunnelState: tSnap,
          probeStatus: tSnap.probeStatus ?? runtimeMeta.probeStatus,
          keepAwake: Boolean(runtimeMeta.keepAwake),
          keepAwakeBackend: options.keepAwakeController?.getBackend?.() ?? "none",
          platformMeta,
          folderPickerSupported,
          localClients,
          startedAt,
          latestPin: latestSessionPin,
          tailscaleStatus,
          cloudflaredInstalled,
          browserProfile,
          serviceStatus,
          config: {
            port: mcpBoundPort,
            roots: options.config.roots,
            allowWrite: options.config.allowWrite,
            allowShell: options.config.allowShell,
            shieldSecrets: options.config.shieldSecrets,
            keepAwake: options.config.keepAwake,
          },
          oauthSummary: options.oauth.getSummary(),
          oauthClients: options.oauth.listClients(),
          oauthEvents: options.oauth.getRecentEvents(),
          processes,
          activeProcesses: processes.filter((p) => p.status === "running").length,
          recentAudit: options.audit.readRecent ? options.audit.readRecent(40) : [],
        });
      }

      if (req.method === "GET" && pathname === "/_local/files") {
        const defaultRoot = options.config.roots[0] ?? process.cwd();
        const reqRoot = url.searchParams.get("root")?.trim();
        const baseRoot = reqRoot && options.config.roots.includes(reqRoot) ? reqRoot : defaultRoot;
        const targetParam = url.searchParams.get("path")?.trim() || baseRoot;
        try {
          const directory = resolveSafePath(targetParam, options.config.roots, baseRoot, {
            configDir: options.configDir,
          });
          const st = statSync(directory);
          if (!st.isDirectory()) {
            return localJson({ error: `디렉터리가 아닙니다: ${directory}` }, 400);
          }
          let canonicalRoot = baseRoot;
          try {
            canonicalRoot = realpathSync(baseRoot);
          } catch {
            // Keep baseRoot.
          }
          const parentCandidate = dirname(directory);
          const parent =
            directory !== canonicalRoot && isPathInside(parentCandidate, canonicalRoot)
              ? parentCandidate
              : null;

          const rawEntries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          const entries: Array<{ name: string; path: string; type: "directory" | "file"; size?: number }> = [];
          for (const entry of rawEntries) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            const full = join(directory, entry.name);
            let kind: "directory" | "file" = "file";
            let size: number | undefined;
            try {
              const entryStat = statSync(full);
              if (entryStat.isDirectory()) {
                kind = "directory";
              } else {
                size = entryStat.size;
              }
            } catch {
              kind = entry.isDirectory() ? "directory" : "file";
            }
            entries.push({ name: entry.name, path: full, type: kind, size });
            if (entries.length >= 300) break;
          }
          return localJson({ ok: true, root: canonicalRoot, directory, parent, entries });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return localJson({ error: msg }, err instanceof SecurityError ? 403 : 400);
        }
      }

      if (req.method === "GET" && pathname === "/_local/file-content") {
        const defaultRoot = options.config.roots[0] ?? process.cwd();
        const reqRoot = url.searchParams.get("root")?.trim();
        const baseRoot = reqRoot && options.config.roots.includes(reqRoot) ? reqRoot : defaultRoot;
        const fileParam = url.searchParams.get("path")?.trim() || "";
        if (!fileParam) {
          return localJson({ error: "path 쿼리 파라미터가 필요합니다." }, 400);
        }
        try {
          const target = resolveSafePath(fileParam, options.config.roots, baseRoot, {
            configDir: options.configDir,
          });
          const st = statSync(target);
          if (!st.isFile()) {
            return localJson({ error: `일반 파일이 아닙니다: ${target}` }, 400);
          }
          const raw = Buffer.from(
            await Bun.file(target).slice(0, MAX_LOCAL_PREVIEW_READ_BYTES).arrayBuffer(),
          );
          if (raw.subarray(0, Math.min(raw.byteLength, 4096)).includes(0)) {
            return localJson({ error: "바이너리 파일은 미리보기를 지원하지 않습니다." }, 400);
          }
          const lines = raw.toString("utf8").split(/\r?\n/);
          const truncated =
            st.size > MAX_LOCAL_PREVIEW_READ_BYTES || lines.length > 250 || raw.byteLength > 32_768;
          let content = lines.slice(0, 250).join("\n").slice(0, 32_768);
          if (options.config.shieldSecrets) {
            content = maskSecrets(content).text;
          }
          return localJson({ ok: true, path: target, totalLines: lines.length, truncated, content });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return localJson({ error: msg }, err instanceof SecurityError ? 403 : 400);
        }
      }

      if (req.method === "GET" && pathname === "/_local/git") {
        const defaultRoot = options.config.roots[0] ?? process.cwd();
        const reqRoot = url.searchParams.get("root")?.trim() || defaultRoot;
        try {
          const repoDir = resolveSafePath(reqRoot, options.config.roots, defaultRoot, {
            configDir: options.configDir,
          });
          const gitBin = Bun.which("git") ?? "git";
          const statusProc = await runGitCommandAsync(gitBin, ["status", "--short", "--branch"], repoDir);
          if (statusProc.exitCode !== 0) {
            return localJson({
              ok: true,
              isGitRepo: false,
              status: "Git 저장소가 아닙니다.",
              diff: "",
            });
          }
          const diffProc = await runGitCommandAsync(
            gitBin,
            ["diff", "--no-ext-diff", "--no-textconv"],
            repoDir,
          );
          let diff = diffProc.stdout.slice(0, 20_000);
          if (options.config.shieldSecrets) {
            diff = maskSecrets(diff).text;
          }
          return localJson({
            ok: true,
            isGitRepo: true,
            status: statusProc.stdout.trim(),
            diff: diff.trim(),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return localJson({ error: msg }, err instanceof SecurityError ? 403 : 400);
        }
      }

      if (req.method === "POST" && pathname.startsWith("/_local/")) {
        if (!isValidLocalCsrf(req, localCsrfToken, uiBoundPort)) {
          return localJson({ error: "Invalid or missing local CSRF token" }, 403);
        }

        if (pathname === "/_local/rotate-pin") {
          latestSessionPin = options.oauth.resetPin();
          return localJson({ ok: true, pin: latestSessionPin });
        }

        if (pathname === "/_local/revoke-all") {
          const revokedCount = options.oauth.revokeAllTokens();
          return localJson({ ok: true, revokedCount });
        }

        if (pathname === "/_local/settings") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          if (typeof body.allowWrite === "boolean") {
            options.config.allowWrite = body.allowWrite;
          }
          if (typeof body.allowShell === "boolean") {
            options.config.allowShell = body.allowShell;
          }
          if (typeof body.shieldSecrets === "boolean") {
            options.config.shieldSecrets = body.shieldSecrets;
          }
          if (typeof body.keepAwake === "boolean") {
            options.config.keepAwake = body.keepAwake;
            if (options.keepAwakeController) {
              runtimeMeta.keepAwake = options.keepAwakeController.setEnabled(body.keepAwake);
            } else {
              runtimeMeta.keepAwake = body.keepAwake;
            }
          }
          options.oauth.updateConfig(options.config);
          persistConfig();
          return localJson({
            ok: true,
            config: {
              allowWrite: options.config.allowWrite,
              allowShell: options.config.allowShell,
              shieldSecrets: options.config.shieldSecrets,
              keepAwake: options.config.keepAwake,
            },
          });
        }

        if (pathname === "/_local/roots") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          const action = body.action;
          const rawPath = typeof body.path === "string" ? body.path.trim() : "";
          if (!rawPath) {
            return localJson({ error: "경로를 입력하세요." }, 400);
          }

          if (action === "add") {
            const resolved = resolve(expandTilde(rawPath));
            if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
              return localJson({ error: `존재하는 디렉터리가 아닙니다: ${resolved}` }, 400);
            }
            options.config.roots = normalizeRoots([...options.config.roots, resolved]);
            options.oauth.updateConfig(options.config);
            persistConfig();
            return localJson({ ok: true, roots: options.config.roots });
          }

          if (action === "remove") {
            const [target] = normalizeRoots([rawPath]);
            const next = options.config.roots.filter((r) => r !== target && r !== rawPath);
            if (next.length === 0) {
              return localJson({ error: "최소 1개 이상의 작업 폴더가 필요합니다." }, 400);
            }
            options.config.roots = next;
            options.oauth.updateConfig(options.config);
            persistConfig();
            return localJson({ ok: true, roots: options.config.roots });
          }

          return localJson({ error: "action은 'add' 또는 'remove'여야 합니다." }, 400);
        }

        if (pathname === "/_local/roots/pick") {
          if (!isNativeFolderPickerAvailable()) {
            return localJson({
              ok: true,
              cancelled: true,
              unsupported: true,
              roots: options.config.roots,
            });
          }
          const picked = await pickFolderDialogAsync();
          if (!picked) {
            return localJson({ ok: true, cancelled: true, roots: options.config.roots });
          }
          options.config.roots = normalizeRoots([...options.config.roots, picked]);
          options.oauth.updateConfig(options.config);
          persistConfig();
          return localJson({ ok: true, cancelled: false, added: picked, roots: options.config.roots });
        }

        if (pathname === "/_local/browser/open-gemini") {
          let body: Record<string, unknown> = {};
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            body = {};
          }
          const mode = body.mode === "default" ? "default" : "dedicated";
          let urlParam = GEMINI_WEB_URL;
          if (typeof body.url === "string" && !/[\s\r\n\0"']/.test(body.url)) {
            try {
              const parsedUrl = new URL(body.url);
              if (parsedUrl.origin === "https://gemini.google.com") {
                urlParam = parsedUrl.toString();
              }
            } catch {
              urlParam = GEMINI_WEB_URL;
            }
          }
          const launched = openGeminiLoginWindow(options.configDir, { mode, url: urlParam });
          return localJson({ ok: true, ...launched });
        }

        if (pathname === "/_local/clients/register") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          if (!isLocalMcpClientId(body.client)) {
            return localJson({ error: "지원하지 않는 MCP 클라이언트입니다." }, 400);
          }
          persistConfig();
          try {
            const res = registerLocalClient(body.client, projectRoot, options.configDir);
            return localJson({
              ok: true,
              ...res,
              localClients: detectLocalClients(projectRoot, options.configDir),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return localJson({ error: msg }, 400);
          }
        }

        if (pathname === "/_local/clients/unregister") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          if (!isLocalMcpClientId(body.client)) {
            return localJson({ error: "지원하지 않는 MCP 클라이언트입니다." }, 400);
          }
          try {
            const res = unregisterLocalClient(body.client);
            return localJson({
              ok: true,
              ...res,
              localClients: detectLocalClients(projectRoot, options.configDir),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return localJson({ error: msg }, 400);
          }
        }

        if (pathname === "/_local/context-pack") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          const requestedRoot =
            typeof body.root === "string" && body.root.trim()
              ? body.root.trim()
              : (options.config.roots[0] ?? process.cwd());
          let safeRoot: string;
          try {
            safeRoot = resolveSafePath(
              requestedRoot,
              options.config.roots,
              options.config.roots[0] ?? process.cwd(),
              { configDir: options.configDir },
            );
          } catch (err) {
            if (err instanceof SecurityError) {
              return localJson({ error: err.message }, 403);
            }
            throw err;
          }
          if (!existsSync(safeRoot) || !statSync(safeRoot).isDirectory()) {
            return localJson({ error: "작업 루트가 존재하는 디렉터리가 아닙니다." }, 400);
          }

          const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          const denied = getSensitiveDeniedPaths(options.configDir);
          const tree = collectWorkspaceTree(safeRoot, denied, 2, 120);

          let gitStatusText = "";
          let gitDiffText = "";
          const gitBin = Bun.which("git");
          if (gitBin) {
            const stRes = await runGitCommandAsync(gitBin, ["status", "--short", "--branch"], safeRoot);
            if (stRes.exitCode === 0) {
              gitStatusText = stRes.stdout.trim();
              const diffRes = await runGitCommandAsync(
                gitBin,
                ["diff", "--no-ext-diff", "--no-textconv"],
                safeRoot,
              );
              if (diffRes.exitCode === 0) {
                const rawDiff = diffRes.stdout.trim();
                gitDiffText = rawDiff.length > 12_288 ? `${rawDiff.slice(0, 12_288)}\n... (truncated)` : rawDiff;
              }
            }
          }

          const sections: string[] = [
            `[로컬 작업 폴더: ${safeRoot}]`,
            "",
            "### 프로젝트 파일 구조 (상위 2단계)",
            "```text",
            tree.length > 0 ? tree.join("\n") : "(빈 디렉터리)",
            "```",
          ];
          if (gitStatusText) {
            sections.push("", "### Git 상태", "```text", gitStatusText, "```");
          }
          if (gitDiffText) {
            sections.push("", "### 현재 미커밋 Git Diff", "```diff", gitDiffText, "```");
          }
          sections.push(
            "",
            "### 요청 작업",
            userPrompt || "위 프로젝트 구조와 변경사항을 분석하고 핵심 개선점 또는 다음 단계를 제안해줘.",
          );

          const rawComposed = sections.join("\n");
          const composedPrompt = options.config.shieldSecrets ? maskSecrets(rawComposed).text : rawComposed;
          return localJson({
            ok: true,
            root: safeRoot,
            masked: Boolean(options.config.shieldSecrets),
            composedPrompt,
          });
        }

        if (pathname === "/_local/browser/reset-profile") {
          const removed = resetDedicatedBrowserProfile(options.configDir);
          return localJson({ ok: true, removed });
        }

        if (pathname === "/_local/tunnel/open-tailscale") {
          const opened = openTailscaleApp();
          return localJson({ ok: true, opened });
        }

        if (pathname === "/_local/tunnel/start") {
          if (!tunnelController) {
            return localJson({ error: "현재 실행 모드에서는 런타임 터널 전환이 비활성화되어 있습니다." }, 400);
          }
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          const mode = body.mode;
          if (mode !== "tailscale" && mode !== "quick" && mode !== "custom" && mode !== "none") {
            return localJson({ error: "유효하지 않은 터널 모드입니다." }, 400);
          }
          const publicUrl = typeof body.publicUrl === "string" ? body.publicUrl : undefined;
          const httpsPort =
            body.httpsPort === 8443 || body.httpsPort === 10000 ? (body.httpsPort as TailscaleFunnelPort) : 443;
          tailscaleCache = null;
          try {
            const snap = await tunnelController.start({
              mode,
              publicUrl,
              httpsPort,
              openEnableUrl: true,
            });
            return localJson({ ok: true, tunnelState: snap });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return localJson({ error: msg }, 400);
          }
        }

        if (pathname === "/_local/tunnel/stop") {
          if (!tunnelController) {
            return localJson({ error: "런타임 터널 컨트롤러가 없습니다." }, 400);
          }
          tailscaleCache = null;
          const snap = await tunnelController.stop();
          return localJson({ ok: true, tunnelState: snap });
        }

        if (pathname === "/_local/processes/stop") {
          let body: Record<string, unknown>;
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return localJson({ error: "JSON 본문 형식이 올바르지 않습니다." }, 400);
          }
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            return localJson({ error: "프로세스 ID가 필요합니다." }, 400);
          }
          try {
            const info = options.processManager.stop(id, false);
            return localJson({ ok: true, process: info });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return localJson({ error: msg }, 404);
          }
        }
      }

      return localJson({ error: "not_found" }, 404);
    },
  });

  const studioPort = studioHttpServer.port ?? requestedUiPort;
  const studioBaseUrl = `http://127.0.0.1:${studioPort}`;

  return {
    port: mcpBoundPort,
    studioPort,
    localBaseUrl,
    studioBaseUrl,
    getPublicBaseUrl: () => explicitPublicBaseUrl ?? localBaseUrl,
    setPublicBaseUrl: (nextUrl: string) => {
      explicitPublicBaseUrl = nextUrl.trim().replace(/\/+$/, "");
    },
    setRuntimeMeta: (patch: Partial<ServerRuntimeMeta>) => {
      runtimeMeta = { ...runtimeMeta, ...patch };
      if (patch.initialPin !== undefined) {
        latestSessionPin = patch.initialPin;
      }
    },
    setTunnelController: (controller: TunnelController) => {
      tunnelController = controller;
    },
    rotatePin: () => {
      latestSessionPin = options.oauth.resetPin();
      return latestSessionPin;
    },
    getLatestPin: () => latestSessionPin,
    stop: async () => {
      await Promise.all([mcpHttpServer.stop(true), studioHttpServer.stop(true)]);
    },
  };
}
