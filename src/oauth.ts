import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { atomicWriteFile, ensureDirSecure } from "./config.ts";
import type {
  AuthorizationCodeRecord,
  GeminationConfig,
  OAuthClientRecord,
  PersistedOAuthState,
  TokenEndpointAuthMethod,
  TokenRecord,
} from "./types.ts";

const PIN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REDIRECT_URIS = 32;
const MAX_REDIRECT_URI_LEN = 2048;
const MAX_DYNAMIC_CLIENTS = 64;
const MAX_OAUTH_BODY_BYTES = 32_768;
const MAX_STATE_BYTES = 16_384;
const MAX_SCOPE_BYTES = 256;
const PIN_RATE_LIMIT_MAX = 5;
const PIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const DCR_RATE_LIMIT_MAX = 20;
const DCR_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const ALLOWED_SCOPES = ["mcp:tools", "offline_access"];

const DEFAULT_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
  "vertexaisearch.cloud.google.com",
]);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function hashWithSaltLegacy(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`, "utf8").digest("hex");
}

function hashPinScrypt(salt: string, value: string): string {
  return `scrypt$${scryptSync(value, salt, 32).toString("hex")}`;
}

function verifyPinHash(salt: string, candidate: string, storedHash: string): boolean {
  if (storedHash.startsWith("scrypt$")) {
    const expected = storedHash.slice("scrypt$".length);
    const derived = scryptSync(candidate, salt, 32).toString("hex");
    return constantTimeEqualHex(derived, expected);
  }
  return constantTimeEqualHex(hashWithSaltLegacy(salt, candidate), storedHash);
}

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function constantTimeEqualUtf8(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateOwnerPin(): string {
  const bytes = randomBytes(12);
  let chars = "";
  for (let i = 0; i < 12; i += 1) {
    chars += PIN_ALPHABET[bytes[i]! % PIN_ALPHABET.length];
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function normalizePinInput(pin: string): string {
  return pin.trim().toUpperCase();
}

export function normalizeResourceUri(value: string): string {
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.pathname = pathname === "/" ? "" : pathname;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...headers,
    },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

export interface VerifyBearerResult {
  ok: true;
  authInfo: AuthInfo;
}

export interface VerifyBearerFailure {
  ok: false;
  status: 401;
  error: string;
  errorDescription: string;
  wwwAuthenticate: string;
}

export type OAuthLifecycleKind =
  | "registered"
  | "approved"
  | "denied"
  | "token_issued"
  | "token_refreshed"
  | "revoked"
  | "pin_rotated";

export interface OAuthLifecycleEvent {
  ts: string;
  kind: OAuthLifecycleKind;
  detail: string;
}

export interface SanitizedOAuthClient {
  clientId: string;
  clientName: string;
  createdAt: number;
  isStatic: boolean;
}

const MAX_OAUTH_EVENTS = 25;

export class OAuthServer {
  private readonly statePath: string;
  private config: GeminationConfig;
  private state: PersistedOAuthState;
  private readonly authCodes = new Map<string, AuthorizationCodeRecord>();
  private globalPinFailures: number[] = [];
  private dcrTimestamps: number[] = [];
  private readonly recentEvents: OAuthLifecycleEvent[] = [];
  private onPinConsumed?: () => void;

  constructor(configDir: string, config: GeminationConfig) {
    ensureDirSecure(configDir);
    this.statePath = join(configDir, "state.json");
    this.config = config;
    this.state = this.loadOrCreateState();
  }

  setOnPinConsumed(cb: () => void): void {
    this.onPinConsumed = cb;
  }

  updateConfig(config: GeminationConfig): void {
    this.config = config;
  }

  private recordEvent(kind: OAuthLifecycleKind, detail: string): void {
    this.recentEvents.unshift({
      ts: new Date().toISOString(),
      kind,
      detail,
    });
    if (this.recentEvents.length > MAX_OAUTH_EVENTS) {
      this.recentEvents.length = MAX_OAUTH_EVENTS;
    }
  }

  getRecentEvents(): OAuthLifecycleEvent[] {
    return [...this.recentEvents];
  }

  listClients(): SanitizedOAuthClient[] {
    return Object.values(this.state.clients)
      .map((client) => ({
        clientId: client.clientId,
        clientName: client.clientName,
        createdAt: client.createdAt,
        isStatic: Boolean(client.isStatic),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private loadOrCreateState(): PersistedOAuthState {
    if (existsSync(this.statePath)) {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedOAuthState;
      const envPin = process.env.GEMINATION_PIN?.trim();
      if (envPin) {
        const pinSalt = randomBytes(16).toString("hex");
        parsed.pinSalt = pinSalt;
        parsed.pinHash = hashPinScrypt(pinSalt, normalizePinInput(envPin));
      }
      return {
        version: 1,
        pinSalt: parsed.pinSalt,
        pinHash: parsed.pinHash,
        clients: parsed.clients ?? {},
        tokens: parsed.tokens ?? {},
      };
    }

    const pin = process.env.GEMINATION_PIN?.trim() || generateOwnerPin();
    const pinSalt = randomBytes(16).toString("hex");
    const state: PersistedOAuthState = {
      version: 1,
      pinSalt,
      pinHash: hashPinScrypt(pinSalt, normalizePinInput(pin)),
      clients: {},
      tokens: {},
    };
    this.state = state;
    this.createStaticClientInMemory();
    this.persist();
    return state;
  }

  private persist(): void {
    const now = Date.now();
    for (const [hash, record] of Object.entries(this.state.tokens)) {
      if (record.revoked || record.expiresAt <= now) {
        delete this.state.tokens[hash];
      }
    }
    atomicWriteFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, 0o600);
  }

  private createStaticClientInMemory(): { clientId: string; clientSecret: string } {
    for (const [id, client] of Object.entries(this.state.clients)) {
      if (client.isStatic) {
        delete this.state.clients[id];
      }
    }
    const clientId = `gemination-static-${randomBytes(8).toString("hex")}`;
    const clientSecret = `gsec_${randomToken(24)}`;
    this.state.clients[clientId] = {
      clientId,
      clientName: "Gemination Static Client",
      redirectUris: [
        "https://vertexaisearch.cloud.google.com/oauth-redirect",
        "https://oauth-redirect.googleusercontent.com/r/gemination",
        "https://oauth-redirect-sandbox.googleusercontent.com/r/gemination",
        "http://127.0.0.1/callback",
        "http://localhost/callback",
      ],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretHash: sha256Hex(clientSecret),
      isStatic: true,
      createdAt: Date.now(),
    };
    return { clientId, clientSecret };
  }

  initializeFreshCredentials(): { pin: string; staticClientId: string; staticClientSecret: string } {
    const pin = process.env.GEMINATION_PIN?.trim() || generateOwnerPin();
    const pinSalt = randomBytes(16).toString("hex");
    this.state.pinSalt = pinSalt;
    this.state.pinHash = hashPinScrypt(pinSalt, normalizePinInput(pin));
    this.globalPinFailures = [];
    const { clientId, clientSecret } = this.createStaticClientInMemory();
    this.persist();
    return { pin, staticClientId: clientId, staticClientSecret: clientSecret };
  }

  resetPin(explicitPin?: string): string {
    const pin = explicitPin?.trim() || process.env.GEMINATION_PIN?.trim() || generateOwnerPin();
    const pinSalt = randomBytes(16).toString("hex");
    this.state.pinSalt = pinSalt;
    this.state.pinHash = hashPinScrypt(pinSalt, normalizePinInput(pin));
    this.globalPinFailures = [];
    this.persist();
    this.recordEvent("pin_rotated", "새 로컬 승인 코드(PIN) 발급됨");
    return pin;
  }

  rotateStaticClient(): { clientId: string; clientSecret: string } {
    const creds = this.createStaticClientInMemory();
    this.persist();
    return creds;
  }

  getStaticClientId(): string | undefined {
    const found = Object.values(this.state.clients).find((c) => c.isStatic);
    return found?.clientId;
  }

  getSummary(): { clientCount: number; activeTokenCount: number; staticClientId?: string } {
    const now = Date.now();
    const activeTokenCount = Object.values(this.state.tokens).filter(
      (t) => !t.revoked && t.expiresAt > now,
    ).length;
    return {
      clientCount: Object.keys(this.state.clients).length,
      activeTokenCount,
      staticClientId: this.getStaticClientId(),
    };
  }

  revokeAllTokens(): number {
    const count = Object.keys(this.state.tokens).length;
    this.state.tokens = {};
    this.authCodes.clear();
    this.persist();
    this.recordEvent("revoked", `모든 OAuth 토큰 ${count}건 폐기됨`);
    return count;
  }

  getProtectedResourceMetadata(baseUrl: string): Record<string, unknown> {
    const cleanBase = baseUrl.replace(/\/+$/, "");
    return {
      resource: `${cleanBase}/mcp`,
      authorization_servers: [cleanBase],
      bearer_methods_supported: ["header"],
      scopes_supported: ALLOWED_SCOPES,
    };
  }

  getAuthorizationServerMetadata(baseUrl: string): Record<string, unknown> {
    const cleanBase = baseUrl.replace(/\/+$/, "");
    return {
      issuer: cleanBase,
      authorization_endpoint: `${cleanBase}/oauth/authorize`,
      token_endpoint: `${cleanBase}/oauth/token`,
      registration_endpoint: `${cleanBase}/oauth/register`,
      revocation_endpoint: `${cleanBase}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ALLOWED_SCOPES,
    };
  }

  private async readBoundedText(req: Request, maxBytes = MAX_OAUTH_BODY_BYTES): Promise<string> {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  private isDcrRateLimited(now: number): boolean {
    this.dcrTimestamps = this.dcrTimestamps.filter((ts) => now - ts < DCR_RATE_LIMIT_WINDOW_MS);
    return this.dcrTimestamps.length >= DCR_RATE_LIMIT_MAX;
  }

  private evictOldestDynamicClientsIfNeeded(): void {
    const dynamic = Object.values(this.state.clients)
      .filter((c) => !c.isStatic)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (dynamic.length >= MAX_DYNAMIC_CLIENTS) {
      const oldest = dynamic.shift();
      if (!oldest) break;
      delete this.state.clients[oldest.clientId];
    }
  }

  isRedirectUriAllowed(uriString: string): boolean {
    if (!uriString || uriString.length > MAX_REDIRECT_URI_LEN) {
      return false;
    }
    let parsed: URL;
    try {
      parsed = new URL(uriString);
    } catch {
      return false;
    }
    if (parsed.hash || parsed.username || parsed.password) {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol === "http:") {
      return hostname === "127.0.0.1" || hostname === "localhost";
    }
    if (parsed.protocol !== "https:") {
      return false;
    }
    if (DEFAULT_REDIRECT_HOSTS.has(hostname)) {
      return true;
    }
    return this.config.extraRedirectHosts.some((allowed) => allowed.toLowerCase() === hostname);
  }

  async handleRegister(req: Request): Promise<Response> {
    const now = Date.now();
    if (this.isDcrRateLimited(now)) {
      return oauthError("slow_down", "Too many client registration requests. Try again later.", 429);
    }
    this.dcrTimestamps.push(now);

    let body: Record<string, unknown>;
    try {
      const rawText = await this.readBoundedText(req);
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return oauthError("invalid_client_metadata", "Registration payload must be a JSON object", 400);
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error && err.message.includes("exceeds")
        ? err.message
        : "Invalid JSON body";
      return oauthError("invalid_client_metadata", msg, 400);
    }

    const rawRedirectUris = body.redirect_uris;
    if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array", 400);
    }
    if (rawRedirectUris.length > MAX_REDIRECT_URIS) {
      return oauthError(
        "invalid_redirect_uri",
        `Too many redirect_uris (max ${MAX_REDIRECT_URIS})`,
        400,
      );
    }

    const redirectUris: string[] = [];
    for (const entry of rawRedirectUris) {
      if (typeof entry !== "string" || !this.isRedirectUriAllowed(entry)) {
        return oauthError(
          "invalid_redirect_uri",
          `Redirect URI is not allowed: ${String(entry)}`,
          400,
        );
      }
      if (!redirectUris.includes(entry)) {
        redirectUris.push(entry);
      }
    }

    const rawAuthMethod = body.token_endpoint_auth_method;
    let tokenEndpointAuthMethod: TokenEndpointAuthMethod = "none";
    if (rawAuthMethod !== undefined) {
      if (
        rawAuthMethod !== "none"
        && rawAuthMethod !== "client_secret_post"
        && rawAuthMethod !== "client_secret_basic"
      ) {
        return oauthError(
          "invalid_client_metadata",
          `Unsupported token_endpoint_auth_method: ${String(rawAuthMethod)}`,
          400,
        );
      }
      tokenEndpointAuthMethod = rawAuthMethod;
    }

    const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length > 0
      ? body.grant_types.filter((g): g is string => typeof g === "string")
      : ["authorization_code", "refresh_token"];
    if (!grantTypes.includes("authorization_code")) {
      return oauthError("invalid_client_metadata", "grant_types must include authorization_code", 400);
    }

    const responseTypes = Array.isArray(body.response_types) && body.response_types.length > 0
      ? body.response_types.filter((r): r is string => typeof r === "string")
      : ["code"];
    if (!responseTypes.includes("code")) {
      return oauthError("invalid_client_metadata", "response_types must include code", 400);
    }

    const clientName = typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "Gemini MCP Client";

    const clientId = `gem_${randomBytes(12).toString("hex")}`;
    let plainSecret: string | undefined;
    let clientSecretHash: string | undefined;
    if (tokenEndpointAuthMethod !== "none") {
      plainSecret = `gsec_${randomToken(24)}`;
      clientSecretHash = sha256Hex(plainSecret);
    }

    const record: OAuthClientRecord = {
      clientId,
      clientName,
      redirectUris,
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod,
      clientSecretHash,
      createdAt: Date.now(),
    };
    this.evictOldestDynamicClientsIfNeeded();
    this.state.clients[clientId] = record;
    this.persist();
    this.recordEvent("registered", `${clientName} (${clientId}) 클라이언트 등록됨`);

    const responsePayload: Record<string, unknown> = {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      client_id_issued_at: Math.floor(record.createdAt / 1000),
    };
    if (plainSecret) {
      responsePayload.client_secret = plainSecret;
      responsePayload.client_secret_expires_at = 0;
    }

    return jsonResponse(responsePayload, 201);
  }

  private isResourceAcceptable(resourceParam: string | null, baseUrl: string): boolean {
    if (!resourceParam) return true;
    const normalized = normalizeResourceUri(resourceParam);
    const cleanBase = normalizeResourceUri(baseUrl);
    const mcpResource = normalizeResourceUri(`${cleanBase}/mcp`);
    return normalized === mcpResource || normalized === cleanBase;
  }

  private validateAuthorizeParams(params: {
    responseType: string | null;
    clientId: string | null;
    redirectUri: string | null;
    state: string | null;
    codeChallenge: string | null;
    codeChallengeMethod: string | null;
    scope: string | null;
    resource: string | null;
  }, baseUrl: string):
    | { ok: true; client: OAuthClientRecord; redirectUri: string; scopes: string[]; state?: string; codeChallenge?: string; resource?: string }
    | { ok: false; response: Response } {
    if (!params.clientId) {
      return { ok: false, response: oauthError("invalid_request", "Missing client_id", 400) };
    }
    const client = this.state.clients[params.clientId];
    if (!client) {
      return { ok: false, response: oauthError("invalid_client", "Unknown client_id", 400) };
    }
    if (!params.redirectUri) {
      return { ok: false, response: oauthError("invalid_request", "Missing redirect_uri", 400) };
    }
    if (!client.redirectUris.includes(params.redirectUri)) {
      return { ok: false, response: oauthError("invalid_request", "redirect_uri does not match registered client", 400) };
    }
    if (params.responseType !== "code") {
      return { ok: false, response: oauthError("unsupported_response_type", "Only response_type=code is supported", 400) };
    }
    if (params.state && Buffer.byteLength(params.state, "utf8") > MAX_STATE_BYTES) {
      return { ok: false, response: oauthError("invalid_request", `state exceeds ${MAX_STATE_BYTES} bytes`, 400) };
    }
    if (client.tokenEndpointAuthMethod === "none" && !params.codeChallenge) {
      return { ok: false, response: oauthError("invalid_request", "PKCE code_challenge is required for public clients", 400) };
    }
    if (params.codeChallenge) {
      const method = params.codeChallengeMethod ?? "plain";
      if (method !== "S256") {
        return { ok: false, response: oauthError("invalid_request", "Only code_challenge_method=S256 is supported", 400) };
      }
    }
    if (!this.isResourceAcceptable(params.resource, baseUrl)) {
      return { ok: false, response: oauthError("invalid_target", "Requested resource does not match this MCP server", 400) };
    }

    if (params.scope && Buffer.byteLength(params.scope, "utf8") > MAX_SCOPE_BYTES) {
      return { ok: false, response: oauthError("invalid_scope", `scope exceeds ${MAX_SCOPE_BYTES} bytes`, 400) };
    }
    const requestedScopes = (params.scope ?? "mcp:tools")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (requestedScopes.length > 8) {
      return { ok: false, response: oauthError("invalid_scope", "Too many requested scopes", 400) };
    }
    const scopes = requestedScopes.length > 0 ? requestedScopes : ["mcp:tools"];

    return {
      ok: true,
      client,
      redirectUri: params.redirectUri,
      scopes,
      state: params.state ?? undefined,
      codeChallenge: params.codeChallenge ?? undefined,
      resource: params.resource ? normalizeResourceUri(params.resource) : normalizeResourceUri(`${baseUrl}/mcp`),
    };
  }

  private renderConsentPage(opts: {
    client: OAuthClientRecord;
    redirectUri: string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    scope: string;
    resource?: string;
    errorMessage?: string;
    status?: number;
  }): Response {
    const rootsHtml = this.config.roots.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join("");
    const capabilities = [
      "Read / Search files in workspace",
      this.config.allowWrite ? "Write / Edit files in workspace" : "Read-only filesystem (writes disabled)",
      this.config.allowShell ? "Run shell commands & processes" : "Shell execution disabled",
    ].map((c) => `<li>${escapeHtml(c)}</li>`).join("");

    const errorBlock = opts.errorMessage
      ? `<div class="error" role="alert">${escapeHtml(opts.errorMessage)}</div>`
      : "";

    const hiddenFields = [
      ["response_type", "code"],
      ["client_id", opts.client.clientId],
      ["redirect_uri", opts.redirectUri],
      ["scope", opts.scope],
      ...(opts.state !== undefined ? [["state", opts.state]] : []),
      ...(opts.codeChallenge !== undefined ? [["code_challenge", opts.codeChallenge]] : []),
      ...(opts.codeChallengeMethod !== undefined ? [["code_challenge_method", opts.codeChallengeMethod]] : []),
      ...(opts.resource !== undefined ? [["resource", opts.resource]] : []),
    ]
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join("\n        ");

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Gemination Local MCP</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117; color: #e6edf3; display: flex; min-height: 100vh;
      align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      width: 100%; max-width: 520px; background: #161b22; border: 1px solid #30363d;
      border-radius: 14px; padding: 28px; box-sizing: border-box;
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    .sub { margin: 0 0 18px; color: #8b949e; font-size: 14px; line-height: 1.5; }
    .box {
      background: #0d1117; border: 1px solid #21262d; border-radius: 10px;
      padding: 14px 16px; margin-bottom: 16px; font-size: 13px;
    }
    .label { color: #8b949e; font-size: 12px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    ul { margin: 6px 0 0; padding-left: 18px; }
    li { margin: 4px 0; word-break: break-all; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #79c0ff; }
    .error {
      background: rgba(248, 81, 73, 0.14); border: 1px solid #f85149; color: #ffb4ae;
      border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px;
    }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] {
      width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 8px;
      border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 15px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.06em;
    }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    button {
      flex: 1; padding: 11px 16px; border-radius: 8px; border: 1px solid transparent;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .approve { background: #238636; color: #ffffff; }
    .deny { background: #21262d; border-color: #30363d; color: #e6edf3; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorize Local PC Access</h1>
    <p class="sub">
      <strong>${escapeHtml(opts.client.clientName)}</strong> (<code>${escapeHtml(opts.client.clientId)}</code>)
      requests access to your local machine via Gemination MCP.
    </p>
    ${errorBlock}
    <div class="box">
      <div class="label">Redirect Destination</div>
      <code>${escapeHtml(opts.redirectUri)}</code>
    </div>
    <div class="box">
      <div class="label">Allowed Workspace Roots</div>
      <ul>${rootsHtml}</ul>
    </div>
    <div class="box">
      <div class="label">Enabled Capabilities</div>
      <ul>${capabilities}</ul>
    </div>
    <form method="post" action="/oauth/authorize">
      ${hiddenFields}
      <label for="pin">Local Owner Approval Code (from terminal or Gemination Studio)</label>
      <input id="pin" name="pin" type="password" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX" autofocus>
      <div class="actions">
        <button class="approve" type="submit" name="decision" value="approve">Approve Connection</button>
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;

    const redirectOrigin = new URL(opts.redirectUri).origin;

    return new Response(html, {
      status: opts.status ?? 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${redirectOrigin} https:`,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  handleAuthorizeGet(url: URL, baseUrl: string): Response {
    const sp = url.searchParams;
    const validated = this.validateAuthorizeParams({
      responseType: sp.get("response_type"),
      clientId: sp.get("client_id"),
      redirectUri: sp.get("redirect_uri"),
      state: sp.get("state"),
      codeChallenge: sp.get("code_challenge"),
      codeChallengeMethod: sp.get("code_challenge_method"),
      scope: sp.get("scope"),
      resource: sp.get("resource"),
    }, baseUrl);

    if (!validated.ok) return validated.response;

    return this.renderConsentPage({
      client: validated.client,
      redirectUri: validated.redirectUri,
      state: validated.state,
      codeChallenge: validated.codeChallenge,
      codeChallengeMethod: validated.codeChallenge ? "S256" : undefined,
      scope: validated.scopes.join(" "),
      resource: sp.get("resource") ?? undefined,
    });
  }

  private isRateLimited(now: number): boolean {
    this.globalPinFailures = this.globalPinFailures.filter((ts) => now - ts < PIN_RATE_LIMIT_WINDOW_MS);
    return this.globalPinFailures.length >= PIN_RATE_LIMIT_MAX;
  }

  private recordPinFailure(now: number): void {
    this.globalPinFailures = this.globalPinFailures.filter((ts) => now - ts < PIN_RATE_LIMIT_WINDOW_MS);
    this.globalPinFailures.push(now);
  }

  private clearPinFailures(): void {
    this.globalPinFailures = [];
  }

  private pruneExpiredAuthCodes(now: number): void {
    for (const [hash, record] of this.authCodes.entries()) {
      if (record.used || record.expiresAt <= now) {
        this.authCodes.delete(hash);
      }
    }
  }

  private buildRedirectResponse(redirectUri: string, params: Record<string, string | undefined>): Response {
    const target = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) {
        target.searchParams.set(k, v);
      }
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  private async parseFormOrJson(req: Request): Promise<Record<string, string>> {
    const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
    const text = await this.readBoundedText(req);
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return out;
  }

  async handleAuthorizePost(req: Request, baseUrl: string): Promise<Response> {
    let fields: Record<string, string>;
    try {
      fields = await this.parseFormOrJson(req);
    } catch {
      return oauthError("invalid_request", "Invalid authorize form body", 400);
    }

    const validated = this.validateAuthorizeParams({
      responseType: fields.response_type ?? "code",
      clientId: fields.client_id ?? null,
      redirectUri: fields.redirect_uri ?? null,
      state: fields.state ?? null,
      codeChallenge: fields.code_challenge ?? null,
      codeChallengeMethod: fields.code_challenge_method ?? null,
      scope: fields.scope ?? null,
      resource: fields.resource ?? null,
    }, baseUrl);

    if (!validated.ok) return validated.response;

    if (fields.decision === "deny") {
      this.recordEvent("denied", `${validated.client.clientName} 접근 요청 거부됨`);
      return this.buildRedirectResponse(validated.redirectUri, {
        error: "access_denied",
        error_description: "The local owner denied access",
        state: validated.state,
      });
    }

    const now = Date.now();
    if (this.isRateLimited(now)) {
      return this.renderConsentPage({
        client: validated.client,
        redirectUri: validated.redirectUri,
        state: validated.state,
        codeChallenge: validated.codeChallenge,
        codeChallengeMethod: validated.codeChallenge ? "S256" : undefined,
        scope: validated.scopes.join(" "),
        resource: fields.resource,
        errorMessage: "Too many failed approval code attempts. Wait 5 minutes and try again.",
        status: 429,
      });
    }

    const pinInput = normalizePinInput(fields.pin ?? "");
    if (!pinInput || !verifyPinHash(this.state.pinSalt, pinInput, this.state.pinHash)) {
      this.recordPinFailure(now);
      return this.renderConsentPage({
        client: validated.client,
        redirectUri: validated.redirectUri,
        state: validated.state,
        codeChallenge: validated.codeChallenge,
        codeChallengeMethod: validated.codeChallenge ? "S256" : undefined,
        scope: validated.scopes.join(" "),
        resource: fields.resource,
        errorMessage: "Invalid local approval code.",
        status: 401,
      });
    }

    this.clearPinFailures();
    this.pruneExpiredAuthCodes(now);
    const code = randomToken(32);
    this.authCodes.set(sha256Hex(code), {
      codeHash: sha256Hex(code),
      clientId: validated.client.clientId,
      redirectUri: validated.redirectUri,
      codeChallenge: validated.codeChallenge,
      codeChallengeMethod: validated.codeChallenge ? "S256" : undefined,
      scopes: validated.scopes,
      resource: validated.resource,
      expiresAt: now + AUTH_CODE_TTL_MS,
      used: false,
    });
    this.recordEvent("approved", `${validated.client.clientName} PIN 승인 완료`);

    if (!process.env.GEMINATION_PIN?.trim()) {
      this.resetPin();
      this.onPinConsumed?.();
    }

    return this.buildRedirectResponse(validated.redirectUri, {
      code,
      state: validated.state,
    });
  }

  private authenticateTokenClient(
    req: Request,
    fields: Record<string, string>,
    fallbackClientId?: string,
  ): { ok: true; client: OAuthClientRecord } | { ok: false; response: Response } {
    let basicClientId: string | undefined;
    let basicClientSecret: string | undefined;
    const authHeader = req.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
        const colonIdx = decoded.indexOf(":");
        if (colonIdx !== -1) {
          basicClientId = decodeURIComponent(decoded.slice(0, colonIdx));
          basicClientSecret = decodeURIComponent(decoded.slice(colonIdx + 1));
        }
      } catch {
        return { ok: false, response: oauthError("invalid_client", "Malformed Basic authorization header", 401) };
      }
    }

    const clientId = basicClientId ?? fields.client_id ?? fallbackClientId;
    if (!clientId) {
      return { ok: false, response: oauthError("invalid_client", "Missing client_id", 401) };
    }
    const client = this.state.clients[clientId];
    if (!client) {
      return { ok: false, response: oauthError("invalid_client", "Unknown client_id", 401) };
    }

    if (client.tokenEndpointAuthMethod === "none") {
      return { ok: true, client };
    }

    const providedSecret = basicClientSecret ?? fields.client_secret;
    if (!providedSecret || !client.clientSecretHash) {
      return { ok: false, response: oauthError("invalid_client", "Missing client_secret", 401) };
    }
    if (!constantTimeEqualHex(sha256Hex(providedSecret), client.clientSecretHash)) {
      return { ok: false, response: oauthError("invalid_client", "Invalid client_secret", 401) };
    }
    return { ok: true, client };
  }

  private issueTokenPair(
    clientId: string,
    scopes: string[],
    resource: string | undefined,
  ): { accessToken: string; refreshToken: string; expiresIn: number } {
    const now = Date.now();
    const accessToken = `gma_${randomToken(32)}`;
    const refreshToken = `gmr_${randomToken(32)}`;
    const accessHash = sha256Hex(accessToken);
    const refreshHash = sha256Hex(refreshToken);

    this.state.tokens[accessHash] = {
      tokenHash: accessHash,
      kind: "access",
      clientId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    };
    this.state.tokens[refreshHash] = {
      tokenHash: refreshHash,
      kind: "refresh",
      clientId,
      scopes,
      resource,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      revoked: false,
      pairedAccessHash: accessHash,
    };
    this.persist();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  async handleToken(req: Request, baseUrl: string): Promise<Response> {
    let fields: Record<string, string>;
    try {
      fields = await this.parseFormOrJson(req);
    } catch {
      return oauthError("invalid_request", "Malformed token request body", 400);
    }

    const grantType = fields.grant_type;
    if (grantType === "authorization_code") {
      const code = fields.code;
      if (!code) {
        return oauthError("invalid_request", "Missing authorization code", 400);
      }
      const codeHash = sha256Hex(code);
      const codeRecord = this.authCodes.get(codeHash);
      if (!codeRecord || codeRecord.used || codeRecord.expiresAt <= Date.now()) {
        this.authCodes.delete(codeHash);
        return oauthError("invalid_grant", "Authorization code is invalid, expired, or already used", 400);
      }
      // Single-use code: mark used immediately before remaining checks.
      codeRecord.used = true;
      this.authCodes.delete(codeHash);

      const clientAuth = this.authenticateTokenClient(req, fields, codeRecord.clientId);
      if (!clientAuth.ok) return clientAuth.response;
      if (clientAuth.client.clientId !== codeRecord.clientId) {
        return oauthError("invalid_grant", "Authorization code was issued to another client", 400);
      }

      if (!fields.redirect_uri || fields.redirect_uri !== codeRecord.redirectUri) {
        return oauthError("invalid_grant", "redirect_uri mismatch", 400);
      }

      if (codeRecord.codeChallenge) {
        const verifier = fields.code_verifier;
        if (!verifier) {
          return oauthError("invalid_grant", "Missing PKCE code_verifier", 400);
        }
        const computed = sha256Base64Url(verifier);
        if (!constantTimeEqualUtf8(computed, codeRecord.codeChallenge)) {
          return oauthError("invalid_grant", "PKCE code_verifier verification failed", 400);
        }
      }

      let boundResource = codeRecord.resource;
      if (fields.resource) {
        const normalizedReqResource = normalizeResourceUri(fields.resource);
        if (!this.isResourceAcceptable(fields.resource, baseUrl)) {
          return oauthError("invalid_target", "Requested resource is not valid for this server", 400);
        }
        if (boundResource && boundResource !== normalizedReqResource) {
          return oauthError("invalid_target", "Requested resource does not match authorization request", 400);
        }
        boundResource = normalizedReqResource;
      }

      const issued = this.issueTokenPair(clientAuth.client.clientId, codeRecord.scopes, boundResource);
      this.recordEvent("token_issued", `${clientAuth.client.clientName} 액세스 토큰 발급됨`);
      return jsonResponse({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: codeRecord.scopes.join(" "),
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = fields.refresh_token;
      if (!refreshToken) {
        return oauthError("invalid_request", "Missing refresh_token", 400);
      }
      const refreshHash = sha256Hex(refreshToken);
      const record = this.state.tokens[refreshHash];
      if (!record || record.kind !== "refresh" || record.revoked || record.expiresAt <= Date.now()) {
        return oauthError("invalid_grant", "Refresh token is invalid, expired, or revoked", 400);
      }

      const clientAuth = this.authenticateTokenClient(req, fields, record.clientId);
      if (!clientAuth.ok) return clientAuth.response;
      if (clientAuth.client.clientId !== record.clientId) {
        return oauthError("invalid_grant", "Refresh token belongs to another client", 400);
      }

      if (fields.resource) {
        const normalizedReqResource = normalizeResourceUri(fields.resource);
        if (record.resource && record.resource !== normalizedReqResource) {
          return oauthError("invalid_target", "Requested resource does not match token grant", 400);
        }
      }

      // Rotate refresh token and revoke paired access token.
      record.revoked = true;
      if (record.pairedAccessHash && this.state.tokens[record.pairedAccessHash]) {
        this.state.tokens[record.pairedAccessHash]!.revoked = true;
      }
      delete this.state.tokens[refreshHash];

      const issued = this.issueTokenPair(record.clientId, record.scopes, record.resource);
      this.recordEvent("token_refreshed", `${record.clientId} 토큰 갱신됨`);
      return jsonResponse({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
        scope: record.scopes.join(" "),
      });
    }

    return oauthError("unsupported_grant_type", `Unsupported grant_type: ${String(grantType)}`, 400);
  }

  async handleRevoke(req: Request): Promise<Response> {
    let fields: Record<string, string>;
    try {
      fields = await this.parseFormOrJson(req);
    } catch {
      return oauthError("invalid_request", "Malformed revoke body", 400);
    }
    const token = fields.token;
    if (token) {
      const hash = sha256Hex(token);
      const record = this.state.tokens[hash];
      if (record) {
        record.revoked = true;
        if (record.pairedAccessHash && this.state.tokens[record.pairedAccessHash]) {
          this.state.tokens[record.pairedAccessHash]!.revoked = true;
        }
        if (record.kind === "access") {
          for (const candidate of Object.values(this.state.tokens)) {
            if (candidate.pairedAccessHash === hash) {
              candidate.revoked = true;
            }
          }
        }
        this.persist();
        this.recordEvent("revoked", `${record.clientId} 토큰 폐기됨`);
      }
    }
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  verifyBearerToken(
    authHeader: string | null,
    publicBaseUrl: string,
  ): VerifyBearerResult | VerifyBearerFailure {
    const cleanBase = publicBaseUrl.replace(/\/+$/, "");
    const resourceMetadataUrl = `${cleanBase}/.well-known/oauth-protected-resource/mcp`;
    const baseChallenge = `Bearer realm="gemination", resource_metadata="${resourceMetadataUrl}"`;

    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return {
        ok: false,
        status: 401,
        error: "unauthorized",
        errorDescription: "Missing Bearer token",
        wwwAuthenticate: baseChallenge,
      };
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "invalid_token",
        errorDescription: "Empty Bearer token",
        wwwAuthenticate: `${baseChallenge}, error="invalid_token"`,
      };
    }

    const record = this.state.tokens[sha256Hex(token)];
    if (!record || record.kind !== "access" || record.revoked || record.expiresAt <= Date.now()) {
      return {
        ok: false,
        status: 401,
        error: "invalid_token",
        errorDescription: "Access token is invalid, expired, or revoked",
        wwwAuthenticate: `${baseChallenge}, error="invalid_token"`,
      };
    }

    const expectedMcp = normalizeResourceUri(`${cleanBase}/mcp`);
    const expectedBase = normalizeResourceUri(cleanBase);
    if (record.resource && record.resource !== expectedMcp && record.resource !== expectedBase) {
      return {
        ok: false,
        status: 401,
        error: "invalid_token",
        errorDescription: "Access token audience does not match this MCP resource",
        wwwAuthenticate: `${baseChallenge}, error="invalid_token"`,
      };
    }

    return {
      ok: true,
      authInfo: {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: Math.floor(record.expiresAt / 1000),
        resource: record.resource ? new URL(record.resource) : undefined,
      },
    };
  }
}
