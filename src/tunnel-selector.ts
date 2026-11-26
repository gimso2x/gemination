import {
  formatPermissionPresetLabel,
  LinePrompt,
  promptWorkspaceAndPermissions,
  tryBrewInstall,
} from "./setup-wizard.ts";
import { inspectTailscaleStatus, type TailscaleStatusInfo } from "./tunnel.ts";
import type { GeminationConfig, TailscaleFunnelPort } from "./types.ts";

export type TunnelSelectionResult =
  | { cancelled: true }
  | { cancelled: false; mode: "tailscale"; httpsPort: TailscaleFunnelPort; updatedConfig?: GeminationConfig }
  | { cancelled: false; mode: "quick"; updatedConfig?: GeminationConfig }
  | { cancelled: false; mode: "custom"; publicUrl: string; updatedConfig?: GeminationConfig }
  | { cancelled: false; mode: "none"; updatedConfig?: GeminationConfig };

export type NormalizedUrlResult =
  | { ok: true; url: string; strippedMcpSuffix: boolean }
  | { ok: false; error: string };

export function normalizeCustomPublicUrl(raw: string): NormalizedUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "HTTPS URL을 입력해주세요." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "유효한 URL 형식이 아닙니다. 예: https://gemination.example.com" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Gemini 커넥터는 https:// 주소만 허용합니다." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "쿼리 문자열(?)이나 해시(#) 없는 기본 HTTPS URL을 입력하세요." };
  }

  let normalized = parsed.toString().replace(/\/+$/, "");
  let strippedMcpSuffix = false;
  if (normalized.endsWith("/mcp")) {
    normalized = normalized.slice(0, -4).replace(/\/+$/, "");
    strippedMcpSuffix = true;
  }

  return { ok: true, url: normalized, strippedMcpSuffix };
}

export function getDefaultMenuChoice(
  config: GeminationConfig,
  env: { tailscale: TailscaleStatusInfo; cloudflaredBinary: string | null },
): "1" | "2" | "3" | "4" {
  switch (config.tunnelMode) {
    case "tailscale":
      return "1";
    case "quick":
      return "2";
    case "custom":
      return "3";
    case "none":
      return "4";
    default:
      break;
  }

  if (config.publicUrl) return "3";
  if (env.tailscale.running && env.tailscale.publicUrl) return "1";
  if (env.cloudflaredBinary) return "2";
  return "1";
}

export function formatTunnelMenu(options: {
  config: GeminationConfig;
  tailscale: TailscaleStatusInfo;
  cloudflaredBinary: string | null;
  defaultChoice: "1" | "2" | "3" | "4";
  hideSettingsOption?: boolean;
}): string {
  const { config, tailscale, cloudflaredBinary, defaultChoice, hideSettingsOption } = options;
  const cfStatus = cloudflaredBinary ? "준비됨" : "미설치 (brew install cloudflared)";
  const savedCustom = config.publicUrl ? ` · 저장됨: ${config.publicUrl}` : "";

  return [
    "",
    "============================================================",
    " Gemination 외부 접속(터널) 방식을 선택하세요",
    "============================================================",
    `  현재 허용 폴더: ${config.roots.join(", ")}`,
    `  현재 보안 모드: ${formatPermissionPresetLabel(config)}`,
    "",
    `  [1] Tailscale Funnel (추천 · 무료 고정 HTTPS · 본인 도메인 불필요)${defaultChoice === "1" ? "  [기본값]" : ""}`,
    "      - 서버를 껐다 켜도 URL이 고정되어 Gemini 커넥터를 한 번만 등록하면 됩니다.",
    `      - 상태: ${tailscale.detail}`,
    "",
    `  [2] Cloudflare Quick Tunnel (임시 HTTPS · 계정/도메인 불필요)${defaultChoice === "2" ? "  [기본값]" : ""}`,
    "      - 주의: 서버를 껐다 켜면 URL이 매번 바뀌므로,",
    "        재시작할 때마다 gemini.google.com 커넥터를 다시 등록해야 합니다.",
    `      - 상태: ${cfStatus}`,
    "",
    `  [3] 직접 HTTPS URL 입력 (보유 도메인 / Cloudflare Named Tunnel)${defaultChoice === "3" ? "  [기본값]" : ""}`,
    `      - 고정 도메인 URL 직접 지정${savedCustom}`,
    "",
    `  [4] 로컬 전용 (127.0.0.1 · 외부 터널 없음 / 테스트용)${defaultChoice === "4" ? "  [기본값]" : ""}`,
    "      - Gemini Web(gemini.google.com)에서는 로컬 127.0.0.1에 직접 접근할 수 없습니다.",
    "",
    ...(hideSettingsOption ? [] : ["  [s] 작업 폴더 / 보안 권한 설정 변경 (Finder 폴더 선택 · 안전모드 전환)"]),
    "  [q] 취소",
    "============================================================",
    "",
  ].join("\n");
}

export interface PromptTunnelOptions {
  config: GeminationConfig;
  tailscale: TailscaleStatusInfo;
  cloudflaredBinary: string | null;
  funnelPort?: TailscaleFunnelPort;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  allowBrewInstall?: boolean;
  prompter?: LinePrompt;
  hideSettingsOption?: boolean;
}

export async function promptTunnelSelection(
  options: PromptTunnelOptions,
): Promise<TunnelSelectionResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const httpsPort: TailscaleFunnelPort = options.funnelPort ?? options.config.tailscaleFunnelPort ?? 443;
  const allowBrew = Boolean(
    options.allowBrewInstall ?? (process.platform === "darwin" && Boolean((input as { isTTY?: boolean }).isTTY) && Boolean(Bun.which("brew"))),
  );

  let workingConfig = options.config;
  let configModified = false;
  let tailscaleStatus = options.tailscale;
  let cfBinary = options.cloudflaredBinary;

  const printMenu = (): "1" | "2" | "3" | "4" => {
    const def = getDefaultMenuChoice(workingConfig, {
      tailscale: tailscaleStatus,
      cloudflaredBinary: cfBinary,
    });
    output.write(
      formatTunnelMenu({
        config: workingConfig,
        tailscale: tailscaleStatus,
        cloudflaredBinary: cfBinary,
        defaultChoice: def,
        hideSettingsOption: options.hideSettingsOption,
      }),
    );
    return def;
  };

  let defaultChoice = printMenu();
  const ownsPrompter = !options.prompter;
  const prompter = options.prompter ?? new LinePrompt(input, output);
  const promptHint = options.hideSettingsOption ? "선택 [1-4, q=취소]" : "선택 [1-4, s=설정, q=취소]";

  try {
    while (true) {
      const answer = await prompter.ask(`${promptHint} (Enter = ${defaultChoice}): `);
      if (answer === null) {
        return { cancelled: true };
      }

      const trimmed = answer.trim().toLowerCase();
      const choice = trimmed === "" ? defaultChoice : trimmed;

      if (choice === "q" || choice === "quit" || choice === "exit") {
        return { cancelled: true };
      }

      if (!options.hideSettingsOption && (choice === "s" || choice === "setup")) {
        const res = await promptWorkspaceAndPermissions(prompter, workingConfig, output, {
          allowMacOsFinder: Boolean((input as { isTTY?: boolean }).isTTY),
        });
        if (res.cancelled) return { cancelled: true };
        workingConfig = res.config;
        configModified = true;
        defaultChoice = printMenu();
        continue;
      }

      if (choice === "1") {
        if (!tailscaleStatus.installed) {
          output.write(
            "\n[안내] Tailscale이 설치되어 있지 않습니다.\n"
            + "  1) `brew install --cask tailscale` 또는 App Store에서 Tailscale 설치\n"
            + "  2) Tailscale 앱 실행 및 로그인 후 [1]을 다시 선택하세요.\n"
            + "  (바로 테스트하려면 [2] Cloudflare Quick Tunnel을 선택할 수 있습니다.)\n\n",
          );
          if (allowBrew) {
            const installAns = await prompter.ask("Homebrew로 Tailscale을 지금 설치할까요? [y/N]: ");
            if (installAns?.trim().toLowerCase() === "y") {
              if (tryBrewInstall("tailscale")) {
                tailscaleStatus = inspectTailscaleStatus(httpsPort);
                output.write("[완료] Tailscale 설치됨. Tailscale 앱을 실행해 로그인한 뒤 [1]을 선택하세요.\n\n");
              }
            }
          }
          continue;
        }
        if (!tailscaleStatus.running) {
          output.write(
            `\n[안내] Tailscale 로그인/실행이 필요합니다. (${tailscaleStatus.detail})\n`
            + "  Tailscale 앱을 켜고 로그인한 뒤 [1]을 다시 선택하세요.\n\n",
          );
          continue;
        }
        if (!tailscaleStatus.dnsName) {
          output.write(
            "\n[안내] Tailscale MagicDNS가 비활성화되어 있습니다.\n"
            + "  Tailscale Admin Console -> DNS에서 MagicDNS와 HTTPS Certificates를 켠 뒤 [1]을 다시 선택하세요.\n\n",
          );
          continue;
        }
        return {
          cancelled: false,
          mode: "tailscale",
          httpsPort,
          ...(configModified ? { updatedConfig: workingConfig } : {}),
        };
      }

      if (choice === "2") {
        if (!cfBinary) {
          output.write(
            "\n[안내] cloudflared가 설치되어 있지 않습니다.\n"
            + "  설치 명령: `brew install cloudflared`\n\n",
          );
          if (allowBrew) {
            const installAns = await prompter.ask("Homebrew로 cloudflared를 지금 설치할까요? [y/N]: ");
            if (installAns?.trim().toLowerCase() === "y") {
              if (tryBrewInstall("cloudflared")) {
                cfBinary = Bun.which("cloudflared");
                if (cfBinary) {
                  return {
                    cancelled: false,
                    mode: "quick",
                    ...(configModified ? { updatedConfig: workingConfig } : {}),
                  };
                }
              }
            }
          }
          continue;
        }
        return {
          cancelled: false,
          mode: "quick",
          ...(configModified ? { updatedConfig: workingConfig } : {}),
        };
      }

      if (choice === "3") {
        while (true) {
          const savedPrompt = workingConfig.publicUrl ? ` (Enter = ${workingConfig.publicUrl})` : "";
          const urlAnswer = await prompter.ask(`고정 HTTPS URL 입력${savedPrompt} [b=뒤로]: `);
          if (urlAnswer === null) {
            return { cancelled: true };
          }
          const rawUrl = urlAnswer.trim();
          if (rawUrl.toLowerCase() === "b" || rawUrl.toLowerCase() === "back") {
            break;
          }
          const candidate = rawUrl === "" && workingConfig.publicUrl ? workingConfig.publicUrl : rawUrl;
          const normalized = normalizeCustomPublicUrl(candidate);
          if (!normalized.ok) {
            output.write(`[오류] ${normalized.error}\n`);
            continue;
          }
          if (normalized.strippedMcpSuffix) {
            output.write(`[안내] 끝의 /mcp 경로는 자동으로 제거하고 기본 URL(${normalized.url})로 저장합니다.\n`);
          }
          return {
            cancelled: false,
            mode: "custom",
            publicUrl: normalized.url,
            ...(configModified ? { updatedConfig: workingConfig } : {}),
          };
        }
        continue;
      }

      if (choice === "4") {
        return {
          cancelled: false,
          mode: "none",
          ...(configModified ? { updatedConfig: workingConfig } : {}),
        };
      }

      output.write("[오류] 1, 2, 3, 4, s 또는 q 중에서 입력해주세요.\n");
    }
  } finally {
    if (ownsPrompter) {
      prompter.close();
    }
  }
}
