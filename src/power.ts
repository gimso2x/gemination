import { killProcessGracefully, resolveShellCommand } from "./platform.ts";

export type KeepAwakeBackend = "caffeinate" | "windows-power" | "systemd-inhibit" | "none";

export interface KeepAwakeHandle {
  active: boolean;
  backend: KeepAwakeBackend;
  stop: () => void;
}

export interface KeepAwakeController {
  isActive: () => boolean;
  getBackend: () => KeepAwakeBackend;
  setEnabled: (enabled: boolean) => boolean;
  stop: () => void;
}

/**
 * Prevents idle system sleep while Gemination is serving MCP requests:
 * - macOS: `caffeinate -i -w <pid>`
 * - Windows: PowerShell `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` tied to parent PID
 * - Linux: `systemd-inhibit` idle inhibitor
 */
export function startKeepAwake(
  enabled: boolean,
  platform: string = process.platform,
): KeepAwakeHandle {
  if (
    !enabled
    || process.env.GEMINATION_NO_CAFFEINATE === "1"
    || process.env.GEMINATION_NO_KEEP_AWAKE === "1"
  ) {
    return { active: false, backend: "none", stop: () => {} };
  }

  if (platform === "darwin") {
    const caffeinateBin = Bun.which("caffeinate");
    if (!caffeinateBin) {
      return { active: false, backend: "none", stop: () => {} };
    }
    try {
      const proc = Bun.spawn([caffeinateBin, "-i", "-w", String(process.pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      let stopped = false;
      return {
        active: true,
        backend: "caffeinate",
        stop: () => {
          if (stopped) return;
          stopped = true;
          killProcessGracefully(proc, false, platform);
        },
      };
    } catch {
      return { active: false, backend: "none", stop: () => {} };
    }
  }

  if (platform === "win32") {
    const psScript = [
      "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name Win32Power -Namespace Gemination;",
      "[Gemination.Win32Power]::SetThreadExecutionState(2147483649) | Out-Null;",
      `try { Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue } finally { [Gemination.Win32Power]::SetThreadExecutionState(2147483648) | Out-Null }`,
    ].join(" ");
    const psCmd = resolveShellCommand(psScript, "win32");
    if (!psCmd[0]?.toLowerCase().includes("powershell") && !psCmd[0]?.toLowerCase().includes("pwsh")) {
      return { active: false, backend: "none", stop: () => {} };
    }
    try {
      const proc = Bun.spawn(psCmd, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      let stopped = false;
      return {
        active: true,
        backend: "windows-power",
        stop: () => {
          if (stopped) return;
          stopped = true;
          killProcessGracefully(proc, true, platform);
        },
      };
    } catch {
      return { active: false, backend: "none", stop: () => {} };
    }
  }

  const inhibitBin = Bun.which("systemd-inhibit");
  if (!inhibitBin) {
    return { active: false, backend: "none", stop: () => {} };
  }
  try {
    const proc = Bun.spawn(
      [
        inhibitBin,
        "--what=idle",
        "--who=Gemination",
        "--why=Serving MCP requests",
        "--mode=block",
        "cat",
      ],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    let stopped = false;
    return {
      active: true,
      backend: "systemd-inhibit",
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          proc.stdin?.end();
        } catch {
          // Ignore.
        }
        killProcessGracefully(proc, false, platform);
      },
    };
  } catch {
    return { active: false, backend: "none", stop: () => {} };
  }
}

export function createKeepAwakeController(
  initialEnabled: boolean,
  platform: string = process.platform,
): KeepAwakeController {
  let handle = startKeepAwake(initialEnabled, platform);

  return {
    isActive: () => handle.active,
    getBackend: () => handle.backend,
    setEnabled: (enabled: boolean) => {
      if (enabled && handle.active) return true;
      if (!enabled && !handle.active) return false;
      handle.stop();
      handle = startKeepAwake(enabled, platform);
      return handle.active;
    },
    stop: () => {
      handle.stop();
      handle = { active: false, backend: "none", stop: () => {} };
    },
  };
}
