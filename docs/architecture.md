# Gemination Architecture

## 1. End-to-End Dual-Port Request Flow

```text
Gemini Web (gemini.google.com)
   │  1) POST /mcp (unauthenticated) -> 401 + WWW-Authenticate (resource_metadata)
   │  2) GET /.well-known/oauth-protected-resource/mcp (RFC 9728)
   │  3) GET /.well-known/oauth-authorization-server (RFC 8414)
   │  4) POST /oauth/register (RFC 7591 Dynamic Client Registration)
   │  5) User browser -> GET/POST /oauth/authorize (one-time PIN consent + PKCE S256)
   │  6) POST /oauth/token (authorization_code -> Bearer access + refresh token)
   │  7) POST /mcp (Authorization: Bearer <token>, JSON-RPC over Streamable HTTP)
   ▼
Tunnel Layer (src/tunnel.ts + src/tunnel-controller.ts)
   ├─ Tailscale Funnel (`*.ts.net`, recommended fixed HTTPS without custom domain)
   ├─ Cloudflare Quick Tunnel (`*.trycloudflare.com`, temporary HTTPS)
   └─ Custom HTTPS URL (Cloudflare Named Tunnel / reverse proxy)
   ▼
Bun Listener 1 — Public MCP & OAuth Server (127.0.0.1:3847, src/http-server.ts)
   ├─ Strictly rejects `/` and `/_local/*` (HTTP 404)
   ├─ OAuthServer (src/oauth.ts)
   └─ Stateless McpServer + WebStandardStreamableHTTPServerTransport (src/tools.ts)
         ├─ Secret Shield (src/secrets-shield.ts)
         ├─ Path Jail & Command Guardrails (src/security.ts)
         └─ ProcessManager (src/process-manager.ts)

Local Owner Browser / Chrome `--app` Window
   ▼
Bun Listener 2 — Loopback-Only Studio UI Server (127.0.0.1:3848, src/dashboard.ts + src/ui/*)
   ├─ Direct loopback only (`isDirectLocalRequest` checks Host, proxy headers, `Sec-Fetch-Site`)
   ├─ Zero CORS headers; POST mutations gated by `X-Gemination-Local-Token` CSRF token + Origin check
   └─ Controls TunnelController, OAuth PIN/Revoke, Workspace Roots + Finder picker, Secret-Shielded File/Git Explorer, Chrome Login Launcher (src/browser-launcher.ts)
```

## 2. Gemini Web Compatibility Design

1. **Stateless Streamable HTTP (`sessionIdGenerator: undefined`, `enableJsonResponse: true`)**
   - Gemini's connector runtime does not preserve sticky local process memory across restarts or tunnel reconnects.
   - Each authenticated `POST /mcp` request creates a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`, executes the JSON-RPC call, returns a direct `application/json` response, and cleans up immediately.
2. **Google Redirect Host Allowlist & Multi-URI DCR**
   - `POST /oauth/register` accepts up to 32 `redirect_uris` per registration (up to 64 stored dynamic clients, rate-limited with 32 KiB request body caps, rejecting URL fragments and userinfo).
   - Allowed redirect hosts by default:
     - `https://oauth-redirect.googleusercontent.com/*`
     - `https://oauth-redirect-sandbox.googleusercontent.com/*`
     - `https://vertexaisearch.cloud.google.com/*`
     - `http://127.0.0.1:*/*` and `http://localhost:*/*`
     - Custom hosts explicitly configured via `extraRedirectHosts` in `config.json`.
3. **Long OAuth `state` Support**
   - `gemination` supports `state` parameters up to 16,384 bytes cleanly through both GET and HTML POST consent forms.
4. **RFC 9728 & RFC 8707 Resource Binding**
   - Both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` advertise `"resource": "<publicBaseUrl>/mcp"`.
   - Supplied `resource` parameters are normalized and bound into the issued token and verified on every `/mcp` request.

## 3. Supporting Runtime Components

- **Dual-Port Isolation (`src/http-server.ts`, `src/dashboard.ts`)**: Studio UI and `/_local/*` endpoints bind on a separate loopback port (`port + 1`, default `3848`) that is never targeted by tunnels or reverse proxies. Listener 1 (`port`, default `3847`) returns `404` for `/` and `/_local/*`, and omits wildcard CORS on `/healthz`, `/oauth/register`, `/oauth/authorize`, and `/oauth/revoke`.
- **Dedicated Browser Launcher (`src/browser-launcher.ts`)**: Opens Gemini Web in an isolated Chromium profile under `<configDir>/browser-profile` so Google Web sessions stay persistent without storing passwords or cookies inside Gemination state.
- **Process, Lock & Power Lifecycle (`src/lock.ts`, `src/power.ts`, `src/service.ts`)**: Atomic instance locking prevents duplicate daemons on the same config dir; `KeepAwakeController` toggles macOS `caffeinate`; LaunchAgent helpers manage optional background auto-start.
- **UI Architecture**: See [docs/design.md](design.md) for the Studio UI tokens, typography, and responsive layout contract.

## 4. Security Controls

- **Zero plaintext secrets on disk**: PINs use per-state random salt + `scrypt` (`timingSafeEqual` verification); access tokens, refresh tokens, auth codes, and static client secrets are hashed with SHA-256 before persistence/lookup.
- **One-time PIN & global brute-force protection**: After approval, the generated session PIN rotates automatically (unless `GEMINATION_PIN` env is explicitly pinned). Failed PIN attempts on `POST /oauth/authorize` trigger a global rate limit of 5 attempts per 5 minutes (HTTP `429`), independent of proxy headers.
- **Workspace jail & dangling-symlink protection**: `resolveSafePath` inspects path components and symlink chains via `lstatSync` + `readlinkSync` + `realpathSync`, enforcing workspace roots and blocking `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.config/{gh,gcloud,gemination}`, `~/Library/Keychains`, Chrome user data, `/etc/shadow`, and `/etc/sudoers`.
- **Argument & git-hook hardening**: `search_files` binds ripgrep flags with `-e`, `--glob=`, and `--`; `git_inspect` and Studio Git views pass safe `git -c` overrides and disable external diffs/textconv; `.git/config` and `.git/hooks` writes are blocked under `--no-shell`.
- **Secret Shield & Audit Log**: `src/secrets-shield.ts` redacts provider keys, JWTs, PEM keys, `gma_`/`gmr_`/`gsec_`, `Bearer` tokens, credentialed URLs, and secret settings in both MCP tool outputs, local previews, error messages, and `audit.jsonl`.
- **Command guardrails**: `checkCommandSafety` blocks catastrophic destructive shell patterns as an accidental-damage guardrail (not an OS container sandbox); use `--read-only` / `--no-shell` when working on untrusted repositories.
