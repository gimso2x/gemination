import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { expandTilde, normalizeRoots } from "./config.ts";
import type { GeminationConfig } from "./types.ts";

export class LinePrompt {
  private readonly rl: ReturnType<typeof createInterface>;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    const isTty = Boolean((input as { isTTY?: boolean }).isTTY);
    this.rl = createInterface({
      input,
      output,
      terminal: isTty,
    });
    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        this.lines.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      while (this.waiters.length > 0) {
        this.waiters.shift()!(null);
      }
    });
  }

  async ask(promptText: string): Promise<string | null> {
    this.output.write(promptText);
    if (this.lines.length > 0) {
      return this.lines.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<string | null>((resolvePromise) => {
      this.waiters.push(resolvePromise);
    });
  }

  close(): void {
    if (!this.closed) {
      this.rl.close();
    }
  }
}

function getMacOsFinderArgs(osascriptBin: string, promptText: string): string[] {
  return [
    osascriptBin,
    "-e",
    "on run argv",
    "-e",
    "POSIX path of (choose folder with prompt (item 1 of argv))",
    "-e",
    "end run",
    "--",
    promptText,
  ];
}

export function pickFolderWithMacOsFinder(promptText = "Gemini가 접근할 작업 폴더를 선택하세요"): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.CI === "1" || process.env.CI === "true" || process.env.GEMINATION_NO_FINDER === "1") {
    return null;
  }
  const osascriptBin = Bun.which("osascript");
  if (!osascriptBin) return null;

  const res = Bun.spawnSync(getMacOsFinderArgs(osascriptBin, promptText), {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  if (res.exitCode !== 0) return null;
  const picked = Buffer.from(res.stdout).toString("utf8").trim().replace(/\/+$/, "");
  return picked || null;
}

export async function pickFolderWithMacOsFinderAsync(
  promptText = "Gemini가 접근할 작업 폴더를 선택하세요",
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (process.env.CI === "1" || process.env.CI === "true" || process.env.GEMINATION_NO_FINDER === "1") {
    return null;
  }
  const osascriptBin = Bun.which("osascript");
  if (!osascriptBin) return null;

  const proc = Bun.spawn(getMacOsFinderArgs(osascriptBin, promptText), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }, 60_000);
  try {
    const [stdoutBuf, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const picked = Buffer.from(stdoutBuf).toString("utf8").trim().replace(/\/+$/, "");
    return picked || null;
  } finally {
    clearTimeout(timer);
  }
}

export function openInBrowser(url: string): boolean {
  if (process.env.CI === "1" || process.env.CI === "true" || process.env.GEMINATION_NO_OPEN === "1") {
    return false;
  }
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      void proc.exited;
      return true;
    }
    if (process.platform === "linux" && Bun.which("xdg-open")) {
      const proc = Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      void proc.exited;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function tryBrewInstall(kind: "tailscale" | "cloudflared"): boolean {
  if (process.platform !== "darwin" || process.env.CI === "1" || process.env.CI === "true") {
    return false;
  }
  const brewBin = Bun.which("brew");
  if (!brewBin) return false;

  const args =
    kind === "tailscale"
      ? [brewBin, "install", "--cask", "tailscale"]
      : [brewBin, "install", "cloudflared"];

  const res = Bun.spawnSync(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return res.exitCode === 0;
}

export function formatPermissionPresetLabel(config: GeminationConfig): string {
  const mode = !config.allowWrite && !config.allowShell
    ? "읽기 전용 (안전 모드)"
    : config.allowWrite && !config.allowShell
      ? "파일 수정만 허용 (셸 꺼짐)"
      : config.allowWrite && config.allowShell
        ? "개발 모드 (읽기/쓰기/셸 모두 허용)"
        : "커스텀 (읽기 + 셸 허용)";
  const shield = config.shieldSecrets ? "시크릿 마스킹 ON" : "시크릿 마스킹 OFF";
  return `${mode} · ${shield}`;
}

export async function promptWorkspaceAndPermissions(
  prompter: LinePrompt,
  config: GeminationConfig,
  output: NodeJS.WritableStream,
  options: { allowMacOsFinder?: boolean } = {},
): Promise<{ cancelled: boolean; config: GeminationConfig }> {
  const updated: GeminationConfig = {
    ...config,
    roots: [...config.roots],
  };

  const canFinder = Boolean(
    options.allowMacOsFinder ?? (process.platform === "darwin" && Boolean((output as { isTTY?: boolean }).isTTY)),
  );

  output.write(
    [
      "",
      "------------------------------------------------------------",
      " 1단계 · 허용할 작업 폴더 설정",
      "------------------------------------------------------------",
      `  현재 폴더: ${updated.roots.join(", ")}`,
      "  [1] 현재 폴더 그대로 유지 (기본값)",
      ...(canFinder ? ["  [2] macOS Finder 창에서 폴더 선택 (추가/변경)"] : []),
      `  [${canFinder ? "3" : "2"}] 폴더 경로 직접 입력 (쉼표 , 로 여러 개 지정 가능)`,
      "  [b] 돌아가기",
      "",
    ].join("\n"),
  );

  while (true) {
    const maxOpt = canFinder ? 3 : 2;
    const raw = await prompter.ask(`폴더 설정 [1-${maxOpt}, b=돌아가기] (Enter = 1): `);
    if (raw === null) return { cancelled: true, config };
    const choice = (raw.trim() || "1").toLowerCase();
    if (choice === "b" || choice === "back") {
      return { cancelled: false, config };
    }
    if (choice === "1") {
      break;
    }
    if (canFinder && choice === "2") {
      output.write("Finder 폴더 선택 창을 여는 중...\n");
      const picked = pickFolderWithMacOsFinder();
      if (!picked) {
        output.write("[안내] 폴더 선택이 취소되었습니다. 다시 선택해주세요.\n");
        continue;
      }
      const modeAns = await prompter.ask("기존 목록에 [a] 추가할까요, 이 폴더로 [r] 교체할까요? (Enter = r): ");
      if (modeAns === null) return { cancelled: true, config };
      const normalized = normalizeRoots(
        modeAns.trim().toLowerCase() === "a" ? [...updated.roots, picked] : [picked],
      );
      updated.roots = normalized;
      output.write(`[완료] 허용 폴더: ${updated.roots.join(", ")}\n`);
      break;
    }
    if ((canFinder && choice === "3") || (!canFinder && choice === "2")) {
      const pathAns = await prompter.ask("절대 또는 ~ 경로 입력 (예: ~/Projects, ~/Documents): ");
      if (pathAns === null) return { cancelled: true, config };
      const candidates = pathAns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => resolve(expandTilde(s)));
      if (candidates.length === 0) {
        output.write("[오류] 최소 1개 이상의 폴더 경로를 입력하세요.\n");
        continue;
      }
      const invalid = candidates.filter((dir) => !existsSync(dir) || !statSync(dir).isDirectory());
      if (invalid.length > 0) {
        output.write(`[오류] 존재하지 않는 디렉터리입니다: ${invalid.join(", ")}\n`);
        continue;
      }
      updated.roots = normalizeRoots(candidates);
      output.write(`[완료] 허용 폴더: ${updated.roots.join(", ")}\n`);
      break;
    }
    output.write(`[오류] 1~${maxOpt} 또는 b 중에서 입력하세요.\n`);
  }

  output.write(
    [
      "",
      "------------------------------------------------------------",
      " 2단계 · 보안 권한 프리셋 선택",
      "------------------------------------------------------------",
      "  [1] 개발 모드 (파일 읽기/쓰기 + 셸 명령 모두 허용) — 일반 코딩용",
      "  [2] 안전 모드 (읽기/검색/Git 조회만 허용, 쓰기·셸 차단) — 입문/조회 전용",
      "  [3] 파일 수정만 허용 (쓰기 허용, 셸 명령 차단)",
      "  (모든 모드에서 API 키·토큰·개인키 출력은 자동 마스킹됩니다.)",
      "",
    ].join("\n"),
  );

  const defaultPreset = !updated.allowWrite && !updated.allowShell
    ? "2"
    : updated.allowWrite && !updated.allowShell
      ? "3"
      : "1";

  while (true) {
    const raw = await prompter.ask(`권한 선택 [1-3] (Enter = ${defaultPreset}): `);
    if (raw === null) return { cancelled: true, config };
    const choice = (raw.trim() || defaultPreset).toLowerCase();
    if (choice === "1") {
      updated.allowWrite = true;
      updated.allowShell = true;
      updated.shieldSecrets = true;
      break;
    }
    if (choice === "2") {
      updated.allowWrite = false;
      updated.allowShell = false;
      updated.shieldSecrets = true;
      break;
    }
    if (choice === "3") {
      updated.allowWrite = true;
      updated.allowShell = false;
      updated.shieldSecrets = true;
      break;
    }
    output.write("[오류] 1, 2, 3 중에서 입력하세요.\n");
  }

  output.write(`[완료] ${formatPermissionPresetLabel(updated)}\n`);
  return { cancelled: false, config: updated };
}
