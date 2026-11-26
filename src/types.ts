import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export type TunnelMode = "tailscale" | "quick" | "custom" | "none";
export type TailscaleFunnelPort = 443 | 8443 | 10000;

export interface GeminationConfig {
  port: number;
  host: "127.0.0.1";
  roots: string[];
  publicUrl?: string;
  tunnelMode?: TunnelMode;
  tailscaleFunnelPort?: TailscaleFunnelPort;
  allowShell: boolean;
  allowWrite: boolean;
  shieldSecrets: boolean;
  keepAwake: boolean;
  extraRedirectHosts: string[];
  commandTimeoutMs: number;
  maxOutputBytes: number;
}

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  clientSecretHash?: string;
  isStatic?: boolean;
  createdAt: number;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
  scopes: string[];
  resource?: string;
  expiresAt: number;
  used: boolean;
}

export interface TokenRecord {
  tokenHash: string;
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
  revoked: boolean;
  pairedAccessHash?: string;
}

export interface PersistedOAuthState {
  version: 1;
  pinSalt: string;
  pinHash: string;
  clients: Record<string, OAuthClientRecord>;
  tokens: Record<string, TokenRecord>;
}

export interface ManagedProcessInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export interface AuditEntry {
  ts: string;
  tool: string;
  clientId?: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  error?: string;
  maskedSecrets?: string[];
}

export interface ToolContext {
  config: GeminationConfig;
  configDir: string;
  defaultCwd: string;
  audit: {
    log(entry: Omit<AuditEntry, "ts">): void;
    readRecent?(limit?: number): AuditEntry[];
  };
  processManager: {
    start(command: string, cwd: string): ManagedProcessInfo;
    poll(id: string, stdoutOffset?: number, stderrOffset?: number, maxBytes?: number): {
      info: ManagedProcessInfo;
      stdoutChunk: string;
      stderrChunk: string;
      nextStdoutOffset: number;
      nextStderrOffset: number;
    };
    stop(id: string, force?: boolean): ManagedProcessInfo;
    list(): ManagedProcessInfo[];
  };
  authInfo?: AuthInfo;
}
