import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Automatically masks unmistakable API keys, tokens, private keys, and secret-named
 * settings before MCP tool outputs or local previews leave the workspace boundary.
 *
 * Intentionally avoids entropy guessing so git SHAs, UUIDs, and ordinary code stay intact.
 */
export type SecretKind =
  | "private key"
  | "OpenAI key"
  | "Anthropic key"
  | "GitHub token"
  | "AWS access key"
  | "Stripe key"
  | "Slack token"
  | "Google API key"
  | "JSON Web Token"
  | "Gemination token"
  | "Bearer token"
  | "credentialed URL"
  | "secret setting";

const marker = (kind: SecretKind): string => `[${kind} hidden]`;
const VALUE_MARKER = "[value hidden]";

const TRIGGER =
  /sk-|gh[pousr]_|github_pat_|AKIA|ASIA|[sr]k_(?:live|test)_|xox[abprs]-|AIza|eyJ|gma_|gmr_|gsec_|PRIVATE KEY|Bearer[ \t]+|https?:\/\/[^:\s/@"']+:[^@\s/"']+@|(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|PIN)["']?\s*[:=]/;

const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, SecretKind]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{32,}/g, "Anthropic key"],
  [/\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, "OpenAI key"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, "GitHub token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS access key"],
  [/\b[sr]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/g, "Stripe key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JSON Web Token"],
  [/\b(?:gma|gmr|gsec)_[A-Za-z0-9_-]{16,}\b/g, "Gemination token"],
  [/\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}={0,2}\b/g, "Bearer token"],
  [/\bhttps?:\/\/[^:\s/@"']+:[^@\s/"']+@/gi, "credentialed URL"],
];

const PRIVATE_KEY =
  /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)[\s\S]*?(-----END \2PRIVATE KEY\3-----)/g;

const SETTING_HEAD = /^([ \t]*(?:export[ \t]+)?)(["']?)([A-Z][A-Z0-9_]*)\2[ \t]*[:=][ \t]*/;
const SECRET_NAME =
  /(?:^|_)(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|PASS|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|SIGNING_KEY|ENCRYPTION_KEY|MASTER_KEY|CLIENT_SECRET|CREDENTIALS?|AUTH_TOKEN|PIN)$/;

const PLACEHOLDER =
  /^(?:\$\{[^{}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^<>]*>|\{\{[^{}]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%|x{4,}|\*{3,}|change[-_ ]?me|your[-_ a-z]*|example[-_a-z]*|placeholder|todo|none|null|true|false|redacted|\.\.\.)$/i;

interface Hit {
  start: number;
  end: number;
  kind: SecretKind;
  replacement: string;
}

function settingHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const testLog =
    /^# TOTAL: \d/m.test(text) ||
    (text.match(/^(?:PASS|FAIL|XFAIL|XPASS|SKIP|ERROR): \S/gm)?.length ?? 0) >= 2;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    const head = SETTING_HEAD.exec(line);
    if (
      head &&
      SECRET_NAME.test(head[3]!) &&
      !(testLog && head[3] === "PASS" && head[0].trimEnd().endsWith(":"))
    ) {
      let rest = line.slice(head[0].length).replace(/[ \t]+$/, "");
      if (rest.endsWith(",")) rest = rest.slice(0, -1).replace(/[ \t]+$/, "");
      const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
      const value = quote
        ? (rest.length >= 2 && rest.endsWith(quote) ? rest.slice(1, -1) : null)
        : rest;
      const plain = value !== null && (quote ? !value.includes(quote) : !/["']/.test(value));
      if (value && plain && !PLACEHOLDER.test(value)) {
        const start = lineStart + head[0].length + quote.length;
        hits.push({
          start,
          end: start + value.length,
          kind: "secret setting",
          replacement: VALUE_MARKER,
        });
      }
    }

    if (newline < 0) break;
    lineStart = newline + 1;
  }

  return hits;
}

export function maskSecrets(text: string): { text: string; masked: SecretKind[] } {
  if (!text || !TRIGGER.test(text)) return { text, masked: [] };

  const hits: Hit[] = [];
  for (const match of text.matchAll(PRIVATE_KEY)) {
    hits.push({
      start: match.index!,
      end: match.index! + match[0].length,
      kind: "private key",
      replacement: `${match[1]}\n${marker("private key")}\n${match[4]}`,
    });
  }
  for (const [pattern, kind] of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      hits.push({
        start: match.index!,
        end: match.index! + match[0].length,
        kind,
        replacement: marker(kind),
      });
    }
  }
  hits.push(...settingHits(text));
  if (hits.length === 0) return { text, masked: [] };

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  const masked: SecretKind[] = [];
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    out += text.slice(cursor, hit.start) + hit.replacement;
    cursor = hit.end;
    masked.push(hit.kind);
  }
  return { text: out + text.slice(cursor), masked };
}

function maskValue(value: unknown, masked: SecretKind[]): unknown {
  if (typeof value === "string") {
    const shielded = maskSecrets(value);
    if (shielded.masked.length === 0) return value;
    masked.push(...shielded.masked);
    return shielded.text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const out = maskValue(item, masked);
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const out = maskValue(v, masked);
      if (out !== v) changed = true;
      next[k] = out;
    }
    return changed ? next : value;
  }
  return value;
}

export function shieldToolResult<T extends CallToolResult>(
  result: T,
): { result: T; masked: SecretKind[] } {
  const masked: SecretKind[] = [];
  let changed = false;

  const content = result.content.map((item) => {
    if (item.type !== "text") return item;
    const shielded = maskSecrets(item.text);
    if (shielded.masked.length === 0) return item;
    changed = true;
    masked.push(...shielded.masked);
    return { ...item, text: shielded.text };
  });

  const extraStructured: SecretKind[] = [];
  const structured =
    result.structuredContent === undefined
      ? undefined
      : maskValue(result.structuredContent, extraStructured);
  if (structured !== result.structuredContent) changed = true;
  if (extraStructured.length > 0 && masked.length === 0) {
    masked.push(...extraStructured);
  }

  if (!changed) return { result, masked };
  return {
    result: {
      ...result,
      content,
      ...(structured !== undefined ? { structuredContent: structured as Record<string, unknown> } : {}),
    },
    masked,
  };
}
