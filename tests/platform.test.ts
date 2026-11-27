import { describe, expect, test } from "bun:test";
import {
  getGitNullHooksPath,
  getPlatformUiMeta,
  getTunnelInstallHint,
  killProcessGracefully,
  resolveShellCommand,
} from "../src/platform.ts";

describe("platform abstraction", () => {
  test("resolveShellCommand builds OS-appropriate shell invocations", () => {
    const winCmd = resolveShellCommand("echo ok", "win32");
    expect(winCmd.length).toBeGreaterThanOrEqual(4);
    expect(winCmd[winCmd.length - 1]).toBe("echo ok");
    expect(winCmd[0]!.toLowerCase()).toMatch(/(pwsh|powershell|cmd)/);

    const macCmd = resolveShellCommand("echo ok", "darwin");
    expect(macCmd[macCmd.length - 2]).toBe("-lc");
    expect(macCmd[macCmd.length - 1]).toBe("echo ok");

    const linCmd = resolveShellCommand("echo ok", "linux");
    expect(linCmd[linCmd.length - 2]).toBe("-lc");
    expect(linCmd[linCmd.length - 1]).toBe("echo ok");
  });

  test("returns OS-appropriate git null hooks path and install hints", () => {
    expect(getGitNullHooksPath("win32")).toBe("NUL");
    expect(getGitNullHooksPath("darwin")).toBe("/dev/null");
    expect(getGitNullHooksPath("linux")).toBe("/dev/null");

    expect(getTunnelInstallHint("tailscale", "darwin")).toContain("brew");
    expect(getTunnelInstallHint("tailscale", "win32")).toContain("winget");
    expect(getTunnelInstallHint("tailscale", "linux")).toContain("tailscale.com");
    expect(getTunnelInstallHint("cloudflared", "win32")).toContain("winget");
  });

  test("getPlatformUiMeta returns localized labels for all supported OSes", () => {
    const mac = getPlatformUiMeta("darwin");
    const win = getPlatformUiMeta("win32");
    const lin = getPlatformUiMeta("linux");

    expect(mac.folderPickerLabel).toContain("Finder");
    expect(win.folderPickerLabel).toContain("Windows");
    expect(lin.serviceTitle).toContain("systemd");
    expect(win.serviceTitle).toContain("Windows");
  });

  test("killProcessGracefully uses direct kill by default and terminates detached POSIX process groups when requested", async () => {
    const signals: Array<string | number | undefined> = [];
    killProcessGracefully({ pid: 999999, kill: (sig) => signals.push(sig) }, false, "linux");
    killProcessGracefully({ pid: 999999, kill: (sig) => signals.push(sig) }, true, "linux", {
      processGroup: false,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

    if (process.platform !== "win32") {
      const proc = Bun.spawn(
        ["sh", "-c", "sleep 30 & echo $!; wait"],
        { stdout: "pipe", stderr: "pipe", detached: true },
      );
      let grandchildPid = 0;
      try {
        const reader = proc.stdout.getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        grandchildPid = Number.parseInt(new TextDecoder().decode(value ?? new Uint8Array()).trim(), 10);
        expect(grandchildPid).toBeGreaterThan(0);

        killProcessGracefully(proc, true, process.platform, { processGroup: true });
        await proc.exited;

        let alive = true;
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          try {
            process.kill(grandchildPid, 0);
            await Bun.sleep(25);
          } catch {
            alive = false;
            break;
          }
        }
        expect(alive).toBe(false);
      } finally {
        if (grandchildPid > 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }
      }
    }
  });
});
