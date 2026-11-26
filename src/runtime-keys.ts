import { emitKeypressEvents } from "node:readline";

export interface RuntimeHotkeyHandlers {
  onCopyUrl: () => void | Promise<void>;
  onRotatePin: () => void | Promise<void>;
  onOpenDashboard: () => void | Promise<void>;
  onOpenGemini: () => void | Promise<void>;
  onRevokeAll: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}

export function attachRuntimeHotkeys(handlers: RuntimeHotkeyHandlers): () => void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return () => {};
  }

  emitKeypressEvents(stdin);
  const previousRaw = Boolean((stdin as { isRaw?: boolean }).isRaw);
  try {
    stdin.setRawMode(true);
  } catch {
    return () => {};
  }
  stdin.resume();

  let busy = false;
  const runSafely = (fn: () => void | Promise<void>): void => {
    if (busy) return;
    busy = true;
    Promise.resolve(fn())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[단축키 오류] ${msg}`);
      })
      .finally(() => {
        busy = false;
      });
  };

  const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      runSafely(handlers.onQuit);
      return;
    }
    const name = key.name?.toLowerCase();
    switch (name) {
      case "c":
        runSafely(handlers.onCopyUrl);
        break;
      case "p":
        runSafely(handlers.onRotatePin);
        break;
      case "d":
        runSafely(handlers.onOpenDashboard);
        break;
      case "g":
        runSafely(handlers.onOpenGemini);
        break;
      case "r":
        runSafely(handlers.onRevokeAll);
        break;
      case "q":
        runSafely(handlers.onQuit);
        break;
      default:
        break;
    }
  };

  stdin.on("keypress", onKeypress);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    stdin.off("keypress", onKeypress);
    try {
      stdin.setRawMode(previousRaw);
    } catch {
      // Ignore TTY cleanup failure.
    }
    try {
      stdin.pause();
    } catch {
      // Ignore.
    }
  };
}
