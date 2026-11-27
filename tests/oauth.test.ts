import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { OAuthServer } from "../src/oauth.ts";

let configDir: string;
let oauth: OAuthServer;
let prevPinEnv: string | undefined;
const BASE_URL = "https://gemination-test.trycloudflare.com";
const TEST_PIN = "2345-ABCD-EFGH";

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "gemination-oauth-test-"));
  prevPinEnv = process.env.GEMINATION_PIN;
  process.env.GEMINATION_PIN = TEST_PIN;
  const cfg = defaultConfig();
  cfg.roots = [configDir];
  oauth = new OAuthServer(configDir, cfg);
});

afterEach(() => {
  if (prevPinEnv === undefined) delete process.env.GEMINATION_PIN;
  else process.env.GEMINATION_PIN = prevPinEnv;
  rmSync(configDir, { recursive: true, force: true });
});

describe("OAuthServer metadata and registration", () => {
  test("advertises RFC 9728 and RFC 8414 metadata", () => {
    const pr = oauth.getProtectedResourceMetadata(BASE_URL);
    expect(pr.resource).toBe(`${BASE_URL}/mcp`);
    expect(pr.authorization_servers).toEqual([BASE_URL]);

    const asMeta = oauth.getAuthorizationServerMetadata(BASE_URL);
    expect(asMeta.issuer).toBe(BASE_URL);
    expect(asMeta.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
    expect(asMeta.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(asMeta.registration_endpoint).toBe(`${BASE_URL}/oauth/register`);
    expect(asMeta.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("DCR accepts up to 32 Google redirect URIs and rejects untrusted hosts", async () => {
    const twelveUris = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? `https://oauth-redirect.googleusercontent.com/r/app-${i}`
        : `https://oauth-redirect-sandbox.googleusercontent.com/r/app-${i}`,
    );
    const okRes = await oauth.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Gemini Web",
          redirect_uris: twelveUris,
        }),
      }),
    );
    expect(okRes.status).toBe(201);
    const okBody = (await okRes.json()) as { client_id: string; redirect_uris: string[] };
    expect(okBody.client_id.startsWith("gem_")).toBe(true);
    expect(okBody.redirect_uris.length).toBe(12);

    const badRes = await oauth.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example.com/callback"],
        }),
      }),
    );
    expect(badRes.status).toBe(400);

    const fragRes = await oauth.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://oauth-redirect.googleusercontent.com/r/app#frag"],
        }),
      }),
    );
    expect(fragRes.status).toBe(400);
  });

  test("enforces global PIN rate limit across spoofed proxy headers and consumes one-time PIN", async () => {
    delete process.env.GEMINATION_PIN;
    const cfg = defaultConfig();
    cfg.roots = [configDir];
    const localOauth = new OAuthServer(mkdtempSync(join(tmpdir(), "gemination-pin-test-")), cfg);
    const issuedPin = localOauth.resetPin();

    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/pin-test";
    const regRes = await localOauth.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    const { client_id: clientId } = (await regRes.json()) as { client_id: string };
    const challenge = pkceChallenge("verifier_abcdefghijklmnopqrstuvwxyz_0123456789");

    // Approve once with issuedPin -> one-time consumption must invalidate reusing issuedPin
    const okApprove = await localOauth.handleAuthorizePost(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          pin: issuedPin,
          decision: "approve",
        }).toString(),
      }),
      BASE_URL,
    );
    expect(okApprove.status).toBe(302);

    // Reusing the same PIN must fail (401), even when rotating spoofed IP headers 5 times -> 6th hits 429
    for (let i = 0; i < 6; i += 1) {
      const attempt = await localOauth.handleAuthorizePost(
        new Request(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cf-Connecting-IP": `203.0.113.${i + 1}`,
            "X-Forwarded-For": `198.51.100.${i + 1}`,
          },
          body: new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: challenge,
            code_challenge_method: "S256",
            pin: issuedPin,
            decision: "approve",
          }).toString(),
        }),
        BASE_URL,
      );
      expect(attempt.status).toBe(i < 5 ? 401 : 429);
    }
  });
});

describe("OAuthServer authorization, PKCE, RFC 8707, and revocation", () => {
  test("long state (>4KB), PKCE S256, single-use code, refresh rotation, and revoke", async () => {
    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/gemination-check";
    const regRes = await oauth.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    const reg = (await regRes.json()) as { client_id: string };

    const longState = "s".repeat(4096);
    const verifier = "verifier_abcdefghijklmnopqrstuvwxyz_0123456789";
    const challenge = pkceChallenge(verifier);

    const getUrl = new URL(`${BASE_URL}/oauth/authorize`);
    getUrl.searchParams.set("response_type", "code");
    getUrl.searchParams.set("client_id", reg.client_id);
    getUrl.searchParams.set("redirect_uri", redirectUri);
    getUrl.searchParams.set("state", longState);
    getUrl.searchParams.set("code_challenge", challenge);
    getUrl.searchParams.set("code_challenge_method", "S256");
    getUrl.searchParams.set("resource", `${BASE_URL}/mcp`);

    const getRes = oauth.handleAuthorizeGet(getUrl, BASE_URL);
    expect(getRes.status).toBe(200);
    const csp = getRes.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://oauth-redirect.googleusercontent.com");
    const html = await getRes.text();
    expect(html).toContain("Authorize Local PC Access");

    const postBody = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      state: longState,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${BASE_URL}/mcp`,
      pin: TEST_PIN,
      decision: "approve",
    });

    const postRes = await oauth.handleAuthorizePost(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: postBody.toString(),
      }),
      BASE_URL,
    );
    expect(postRes.status).toBe(302);
    const location = new URL(postRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe(longState);
    const code = location.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    // Wrong PKCE verifier fails and consumes the single-use code.
    const badTokenRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: reg.client_id,
          code_verifier: "wrong_verifier",
        }).toString(),
      }),
      BASE_URL,
    );
    expect(badTokenRes.status).toBe(400);

    // Approve a fresh code and exchange cleanly.
    const postRes2 = await oauth.handleAuthorizePost(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: postBody.toString(),
      }),
      BASE_URL,
    );
    const code2 = new URL(postRes2.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: redirectUri,
          client_id: reg.client_id,
          code_verifier: verifier,
          resource: `${BASE_URL}/mcp`,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };

    // Replay of code2 must fail.
    const replayRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: redirectUri,
          client_id: reg.client_id,
          code_verifier: verifier,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(replayRes.status).toBe(400);

    // Bearer verification succeeds for matching resource, fails for wrong resource.
    expect(oauth.verifyBearerToken(`Bearer ${tokens.access_token}`, BASE_URL).ok).toBe(true);
    expect(oauth.verifyBearerToken(`Bearer ${tokens.access_token}`, "https://other.example").ok).toBe(false);

    // Refresh token rotation invalidates old refresh token and old access token.
    const refreshRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: reg.client_id,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(refreshRes.status).toBe(200);
    const rotated = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    expect(oauth.verifyBearerToken(`Bearer ${tokens.access_token}`, BASE_URL).ok).toBe(false);
    expect(oauth.verifyBearerToken(`Bearer ${rotated.access_token}`, BASE_URL).ok).toBe(true);

    // Revoke invalidates new access token.
    const revokeRes = await oauth.handleRevoke(
      new Request(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: rotated.access_token }).toString(),
      }),
    );
    expect(revokeRes.status).toBe(200);
    expect(oauth.verifyBearerToken(`Bearer ${rotated.access_token}`, BASE_URL).ok).toBe(false);
  });

  test("rate-limits failed PIN attempts with 429 after 5 failures", async () => {
    const redirectUri = "https://vertexaisearch.cloud.google.com/oauth-redirect";
    const staticId = oauth.getStaticClientId()!;
    for (let i = 0; i < 5; i += 1) {
      const res = await oauth.handleAuthorizePost(
        new Request(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.2.3.4" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: staticId,
            redirect_uri: redirectUri,
            pin: "WRONG-PIN",
            decision: "approve",
          }).toString(),
        }),
        BASE_URL,
      );
      expect(res.status).toBe(401);
    }

    const lockedRes = await oauth.handleAuthorizePost(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.2.3.4" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: staticId,
          redirect_uri: redirectUri,
          pin: TEST_PIN,
          decision: "approve",
        }).toString(),
      }),
      BASE_URL,
    );
    expect(lockedRes.status).toBe(429);
  });

  test("static confidential client authenticates with both Basic and POST body", async () => {
    const creds = oauth.rotateStaticClient();
    const redirectUri = "https://vertexaisearch.cloud.google.com/oauth-redirect";
    const approve = async (): Promise<string> => {
      const res = await oauth.handleAuthorizePost(
        new Request(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            response_type: "code",
            client_id: creds.clientId,
            redirect_uri: redirectUri,
            pin: TEST_PIN,
            decision: "approve",
          }).toString(),
        }),
        BASE_URL,
      );
      return new URL(res.headers.get("location")!).searchParams.get("code")!;
    };

    const code1 = await approve();
    const basicHeader = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const basicTokenRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicHeader}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code1,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(basicTokenRes.status).toBe(200);

    const code2 = await approve();
    const postTokenRes = await oauth.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2,
          redirect_uri: redirectUri,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(postTokenRes.status).toBe(200);
  });
});

describe("OAuthServer DCR active session protection", () => {
  const redirectUri = "https://oauth-redirect.googleusercontent.com/r/dcr-protection";
  const verifier = "verifier_abcdefghijklmnopqrstuvwxyz_0123456789";

  async function registerClient(server: OAuthServer, name: string): Promise<string> {
    const res = await server.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri] }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    return body.client_id;
  }

  async function authorizeClient(server: OAuthServer, clientId: string): Promise<string> {
    const res = await server.handleAuthorizePost(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: "S256",
          resource: `${BASE_URL}/mcp`,
          pin: TEST_PIN,
          decision: "approve",
        }).toString(),
      }),
      BASE_URL,
    );
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!).searchParams.get("code")!;
  }

  async function exchangeCode(
    server: OAuthServer,
    clientId: string,
    code: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const res = await server.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: `${BASE_URL}/mcp`,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; refresh_token: string };
  }

  test("preserves dynamic client with active tokens across >=64 subsequent DCR registrations and refresh", async () => {
    const activeClientId = await registerClient(oauth, "Owner Gemini");
    const code = await authorizeClient(oauth, activeClientId);
    const tokens = await exchangeCode(oauth, activeClientId, code);

    const cfg = defaultConfig();
    cfg.roots = [configDir];
    let current = oauth;
    for (let i = 0; i < 70; i += 1) {
      if (i % 15 === 0) {
        current = new OAuthServer(configDir, cfg);
      }
      await registerClient(current, `Idle-${i}`);
    }

    const dynamicClients = current.listClients().filter((c) => !c.isStatic);
    expect(dynamicClients.length).toBeLessThanOrEqual(64);
    expect(dynamicClients.some((c) => c.clientId === activeClientId)).toBe(true);

    const refreshRes = await current.handleToken(
      new Request(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: activeClientId,
        }).toString(),
      }),
      BASE_URL,
    );
    expect(refreshRes.status).toBe(200);
  });

  test("protects client holding an unexpired unused authorization code from eviction", async () => {
    const cfg = defaultConfig();
    cfg.roots = [configDir];
    let current = oauth;
    for (let i = 0; i < 63; i += 1) {
      if (i % 15 === 0) {
        current = new OAuthServer(configDir, cfg);
      }
      await registerClient(current, `Idle-${i}`);
    }

    const activeServer = new OAuthServer(configDir, cfg);
    const pendingClientId = await registerClient(activeServer, "Pending Exchange");
    const code = await authorizeClient(activeServer, pendingClientId);

    for (let i = 0; i < 5; i += 1) {
      await registerClient(activeServer, `Flood-${i}`);
    }

    const dynamicClients = activeServer.listClients().filter((c) => !c.isStatic);
    expect(dynamicClients.length).toBeLessThanOrEqual(64);
    expect(dynamicClients.some((c) => c.clientId === pendingClientId)).toBe(true);

    const tokens = await exchangeCode(activeServer, pendingClientId, code);
    expect(tokens.access_token.startsWith("gma_")).toBe(true);
  });

  test("returns 503 temporarily_unavailable without evicting when all 64 dynamic slots have active tokens", async () => {
    const cfg = defaultConfig();
    cfg.roots = [configDir];
    const activeIds: string[] = [];
    let current = oauth;
    for (let i = 0; i < 64; i += 1) {
      if (i > 0 && i % 15 === 0) {
        current = new OAuthServer(configDir, cfg);
      }
      const cid = await registerClient(current, `Active-${i}`);
      const code = await authorizeClient(current, cid);
      await exchangeCode(current, cid, code);
      activeIds.push(cid);
    }

    const overflowRes = await current.handleRegister(
      new Request(`${BASE_URL}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Overflow", redirect_uris: [redirectUri] }),
      }),
    );
    expect(overflowRes.status).toBe(503);
    const overflowBody = (await overflowRes.json()) as { error: string };
    expect(overflowBody.error).toBe("temporarily_unavailable");

    const remainingIds = new Set(current.listClients().filter((c) => !c.isStatic).map((c) => c.clientId));
    expect(remainingIds.size).toBe(64);
    for (const id of activeIds) {
      expect(remainingIds.has(id)).toBe(true);
    }
  });
});
