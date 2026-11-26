import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROXY_AND_TUNNEL_HEADERS = [
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "tailscale-user-login",
  "tailscale-user-name",
  "x-real-ip",
  "via",
] as const;

export function isLoopbackHostWithoutProxyHeaders(req: Request, serverPort: number): boolean {
  for (const headerName of PROXY_AND_TUNNEL_HEADERS) {
    if (req.headers.has(headerName)) {
      return false;
    }
  }

  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  if (!host) return false;
  return (
    host === `127.0.0.1:${serverPort}`
    || host === `localhost:${serverPort}`
    || host === "127.0.0.1"
    || host === "localhost"
  );
}

export function isDirectLocalRequest(req: Request, serverPort: number): boolean {
  if (!isLoopbackHostWithoutProxyHeaders(req, serverPort)) {
    return false;
  }

  const secFetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }

  return true;
}

export function isValidLocalCsrf(
  req: Request,
  expectedToken: string,
  serverPort: number,
): boolean {
  if (!isDirectLocalRequest(req, serverPort)) {
    return false;
  }

  const provided = req.headers.get("x-gemination-local-token") ?? "";
  if (!provided || !expectedToken) {
    return false;
  }

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return false;
  }

  const origin = req.headers.get("origin")?.trim().toLowerCase();
  if (origin) {
    const allowedOrigins = new Set([
      `http://127.0.0.1:${serverPort}`,
      `http://localhost:${serverPort}`,
    ]);
    if (!allowedOrigins.has(origin)) {
      return false;
    }
  }

  return true;
}

function uiAssetPath(filename: string): string {
  return fileURLToPath(new URL(`./ui/${filename}`, import.meta.url));
}

export function getDashboardCss(): string {
  return readFileSync(uiAssetPath("styles.css"), "utf8");
}

export function getDashboardJs(): string {
  return readFileSync(uiAssetPath("app.js"), "utf8");
}

export function renderDashboardHtml(csrfToken: string): string {
  const template = readFileSync(uiAssetPath("index.html"), "utf8");
  return template.replace("__GEMINATION_CSRF__", csrfToken);
}
