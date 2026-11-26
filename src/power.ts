export interface KeepAwakeHandle {
  active: boolean;
  stop: () => void;
}

export interface KeepAwakeController {
  isActive: () => boolean;
  setEnabled: (enabled: boolean) => boolean;
  stop: () => void;
}

/**
 * Prevents macOS idle system sleep while Gemination is serving MCP requests.
 * Uses `caffeinate -i -w <pid>` so macOS automatically releases the assertion
 * if the parent Bun process exits unexpectedly.
 */
export function startKeepAwake(enabled: boolean): KeepAwakeHandle {
  if (!enabled || process.platform !== "darwin" || process.env.GEMINATION_NO_CAFFEINATE === "1") {
    return { active: false, stop: () => {} };
  }

  const caffeinateBin = Bun.which("caffeinate");
  if (!caffeinateBin) {
    return { active: false, stop: () => {} };
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
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // Already exited.
        }
      },
    };
  } catch {
    return { active: false, stop: () => {} };
  }
}

export function createKeepAwakeController(initialEnabled: boolean): KeepAwakeController {
  let handle = startKeepAwake(initialEnabled);

  return {
    isActive: () => handle.active,
    setEnabled: (enabled: boolean) => {
      if (enabled && handle.active) return true;
      if (!enabled && !handle.active) return false;
      handle.stop();
      handle = startKeepAwake(enabled);
      return handle.active;
    },
    stop: () => {
      handle.stop();
      handle = { active: false, stop: () => {} };
    },
  };
}
