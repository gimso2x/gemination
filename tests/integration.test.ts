import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { startGeminationHttpServer, type GeminationHttpServerHandle } from "../src/http-server.ts";
import { OAuthServer } from "../src/oauth.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { AuditLogger } from "../src/security.ts";

let workspaceDir: string;
let configDir: string;
let serverHandle: GeminationHttpServerHandle;
let processManager: ProcessManager;
let prevPinEnv: string | undefined;
const TEST_PIN = "9999-TEST-CODE";

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

async function mcpPost(
  mcpUrl: string,
  token: string,
  payload: unknown,
): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "gemination-e2e-ws-"));
  configDir = mkdtempSync(join(tmpdir(), "gemination-e2e-cfg-"));
  prevPinEnv = process.env.GEMINATION_PIN;
  process.env.GEMINATION_PIN = TEST_PIN;
  const cfg = defaultConfig();
  cfg.port = 0;
  cfg.roots = [realpathSync(workspaceDir)];

  const oauth = new OAuthServer(configDir, cfg);
  processManager = new ProcessManager();
  serverHandle = startGeminationHttpServer({
    config: cfg,
    configDir,
    oauth,
    audit: new AuditLogger(configDir),
    processManager,
  });
});

afterEach(async () => {
  if (prevPinEnv === undefined) delete process.env.GEMINATION_PIN;
  else process.env.GEMINATION_PIN = prevPinEnv;
  processManager.stopAll();
  await serverHandle.stop();
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("Full HTTP OAuth + Streamable HTTP MCP integration", () => {
  test("401 discovery -> DCR -> PIN consent -> PKCE token -> MCP initialize/list/call -> refresh -> revoke", async () => {
    const baseUrl = serverHandle.getPublicBaseUrl();
    const mcpUrl = `${baseUrl}/mcp`;

    // 1. Unauthenticated /mcp returns 401 + WWW-Authenticate resource_metadata
    const unauthRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(unauthRes.status).toBe(401);
    const wwwAuth = unauthRes.headers.get("www-authenticate") ?? "";
    const metaMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
    expect(metaMatch).not.toBeNull();

    // 2. Fetch protected resource metadata & authorization server metadata
    const prRes = await fetch(metaMatch![1]!);
    expect(prRes.status).toBe(200);
    const pr = (await prRes.json()) as { resource: string; authorization_servers: string[] };
    expect(pr.resource).toBe(mcpUrl);

    const asRes = await fetch(`${pr.authorization_servers[0]}/.well-known/oauth-authorization-server`);
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      revocation_endpoint: string;
    };

    // 3. Dynamic Client Registration
    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/e2e-connector";
    const regRes = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Gemini E2E Client",
        redirect_uris: [redirectUri],
      }),
    });
    expect(regRes.status).toBe(201);
    const client = (await regRes.json()) as { client_id: string };

    // 4. Authorize GET + POST with PIN and PKCE
    const state = "gemini_state_" + "x".repeat(2500);
    const verifier = "pkce_e2e_verifier_0123456789_abcdefghijk";
    const challenge = sha256Base64Url(verifier);

    const authGetUrl = new URL(asMeta.authorization_endpoint);
    authGetUrl.searchParams.set("response_type", "code");
    authGetUrl.searchParams.set("client_id", client.client_id);
    authGetUrl.searchParams.set("redirect_uri", redirectUri);
    authGetUrl.searchParams.set("state", state);
    authGetUrl.searchParams.set("code_challenge", challenge);
    authGetUrl.searchParams.set("code_challenge_method", "S256");
    authGetUrl.searchParams.set("resource", pr.resource);
    const authPageRes = await fetch(authGetUrl);
    expect(authPageRes.status).toBe(200);

    const authPostRes = await fetch(asMeta.authorization_endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: pr.resource,
        pin: TEST_PIN,
        decision: "approve",
      }).toString(),
    });
    expect(authPostRes.status).toBe(302);
    const callbackUrl = new URL(authPostRes.headers.get("location")!);
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    const code = callbackUrl.searchParams.get("code")!;

    // 5. Token exchange
    const tokenRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: pr.resource,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    // 6. MCP Streamable HTTP: initialize -> notifications/initialized -> tools/list -> tools/call
    const initRes = await mcpPost(mcpUrl, tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gemini-e2e", version: "1.0.0" },
      },
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as { result: { serverInfo: { name: string } } };
    expect(initJson.result.serverInfo.name).toBe("gemination");

    const notifRes = await mcpPost(mcpUrl, tokens.access_token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes.status).toBe(202);

    const listRes = await mcpPost(mcpUrl, tokens.access_token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toContain("run_command");
    expect(listJson.result.tools.map((t) => t.name)).toContain("batch_edit");

    const writeCall = await mcpPost(mcpUrl, tokens.access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "write_file", arguments: { path: "e2e.txt", content: "hello-gemini" } },
    });
    expect(writeCall.status).toBe(200);

    const readCall = await mcpPost(mcpUrl, tokens.access_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "e2e.txt" } },
    });
    expect(readCall.status).toBe(200);
    const readJson = (await readCall.json()) as { result: { content: Array<{ text: string }> } };
    expect(readJson.result.content[0]?.text).toContain("hello-gemini");

    // 7. Refresh token & revoke
    const refreshRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { access_token: string };

    const revokeRes = await fetch(asMeta.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshed.access_token }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await mcpPost(mcpUrl, refreshed.access_token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
    });
    expect(afterRevoke.status).toBe(401);
  });
});
