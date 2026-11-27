import { existsSync } from "node:fs";

export type SupportedPlatform = "darwin" | "win32" | "linux" | string;

export interface PlatformUiMeta {
  platform: SupportedPlatform;
  folderPickerLabel: string;
  keepAwakeLabel: string;
  serviceTitle: string;
  tailscaleInstallHint: string;
  cloudflaredInstallHint: string;
}

export function resolveShellCommand(
  command: string,
  platform: SupportedPlatform = process.platform,
): string[] {
  if (platform === "win32") {
    const pwsh = Bun.which("pwsh");
    if (pwsh) {
      return [pwsh, "-NoProfile", "-NonInteractive", "-Command", command];
    }
    const powershell =
      Bun.which("powershell")
      ?? (existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : null);
    if (powershell) {
      return [powershell, "-NoProfile", "-NonInteractive", "-Command", command];
    }
    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    return [comspec, "/d", "/s", "/c", command];
  }

  const candidates = [process.env.SHELL?.trim(), "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return [candidate, "-lc", command];
    }
  }
  return ["/bin/sh", "-lc", command];
}

export function getGitNullHooksPath(platform: SupportedPlatform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

export function getTunnelInstallHint(
  kind: "tailscale" | "cloudflared",
  platform: SupportedPlatform = process.platform,
): string {
  if (kind === "tailscale") {
    switch (platform) {
      case "darwin":
        return "brew install --cask tailscale";
      case "win32":
        return "winget install Tailscale.Tailscale";
      default:
        return "curl -fsSL https://tailscale.com/install.sh | sh";
    }
  }

  switch (platform) {
    case "darwin":
      return "brew install cloudflared";
    case "win32":
      return "winget install Cloudflare.cloudflared";
    default:
      return "cloudflared 패키지 설치 (developers.cloudflare.com)";
  }
}

export function tryCopyToClipboard(
  text: string,
  platform: SupportedPlatform = process.platform,
): boolean {
  const input = Buffer.from(text, "utf8");
  const trySpawn = (cmd: string[]): boolean => {
    try {
      const res = Bun.spawnSync(cmd, { stdin: input, stdout: "ignore", stderr: "ignore" });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  };

  if (platform === "darwin") {
    return trySpawn(["pbcopy"]);
  }

  if (platform === "win32") {
    const clipBin = Bun.which("clip") ?? "clip";
    return trySpawn([clipBin]);
  }

  if (Bun.which("wl-copy") && trySpawn(["wl-copy"])) return true;
  if (Bun.which("xclip") && trySpawn(["xclip", "-selection", "clipboard"])) return true;
  if (Bun.which("xsel") && trySpawn(["xsel", "--clipboard", "--input"])) return true;
  return false;
}

export function killProcessGracefully(
  proc: { pid?: number; kill: (sig?: number | NodeJS.Signals) => void },
  force = false,
  platform: SupportedPlatform = process.platform,
  options?: { processGroup?: boolean },
): void {
  if (platform === "win32") {
    if (typeof proc.pid === "number" && proc.pid > 0) {
      try {
        Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        // Ignore taskkill error and fall back to proc.kill().
      }
    }
    try {
      proc.kill();
    } catch {
      // Ignore already exited.
    }
    return;
  }

  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (options?.processGroup && typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to direct process signal if group leader already exited or EPERM.
    }
  }

  try {
    proc.kill(signal);
  } catch {
    // Ignore already exited.
  }
}

export function getPlatformUiMeta(
  platform: SupportedPlatform = process.platform,
): PlatformUiMeta {
  const folderPickerLabel =
    platform === "darwin"
      ? "Finder에서 폴더 선택"
      : platform === "win32"
        ? "Windows 탐색기에서 폴더 선택"
        : "폴더 선택 창 열기";

  const keepAwakeLabel =
    platform === "darwin"
      ? "유휴 잠자기 방지 (caffeinate)"
      : platform === "win32"
        ? "유휴 잠자기 방지 (Windows)"
        : "유휴 잠자기 방지 (systemd-inhibit)";

  const serviceTitle =
    platform === "darwin"
      ? "macOS 백그라운드 상시 실행 (LaunchAgent)"
      : platform === "win32"
        ? "Windows 로그인 시 백그라운드 자동 시작 (Startup)"
        : "Linux 백그라운드 상시 실행 (systemd --user)";

  return {
    platform,
    folderPickerLabel,
    keepAwakeLabel,
    serviceTitle,
    tailscaleInstallHint: getTunnelInstallHint("tailscale", platform),
    cloudflaredInstallHint: getTunnelInstallHint("cloudflared", platform),
  };
}
