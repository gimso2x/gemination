import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../src/config.ts";
import { AuditLogger, checkCommandSafety, isPathInside, resolveSafePath, SecurityError } from "../src/security.ts";

let workspaceDir: string;
let outsideDir: string;
let configDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "gemination-sec-ws-"));
  outsideDir = mkdtempSync(join(tmpdir(), "gemination-sec-out-"));
  configDir = mkdtempSync(join(tmpdir(), "gemination-sec-cfg-"));
  mkdirSync(join(workspaceDir, "sub"), { recursive: true });
  writeFileSync(join(workspaceDir, "sub", "hello.txt"), "hello\n");
  writeFileSync(join(outsideDir, "secret.txt"), "nope\n");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("resolveSafePath", () => {
  test("allows files inside workspace root", () => {
    const resolved = resolveSafePath("sub/hello.txt", [workspaceDir], workspaceDir, { configDir });
    expect(resolved.endsWith(join("sub", "hello.txt"))).toBe(true);
  });

  test("allows missing nested leaf when allowMissingLeaf is true", () => {
    const resolved = resolveSafePath("newdir/nested/file.ts", [workspaceDir], workspaceDir, {
      allowMissingLeaf: true,
      configDir,
    });
    expect(resolved.endsWith(join("newdir", "nested", "file.ts"))).toBe(true);
  });

  test("blocks .. traversal outside root", () => {
    expect(() =>
      resolveSafePath(`../${basename(outsideDir)}/secret.txt`, [workspaceDir], workspaceDir, {
        configDir,
      }),
    ).toThrow(SecurityError);
  });

  test("blocks sibling directory sharing prefix without separator boundary", () => {
    const siblingPrefix = `${workspaceDir}-sibling`;
    mkdirSync(siblingPrefix, { recursive: true });
    writeFileSync(join(siblingPrefix, "trap.txt"), "trap\n");
    try {
      expect(() =>
        resolveSafePath(join(siblingPrefix, "trap.txt"), [workspaceDir], workspaceDir, { configDir }),
      ).toThrow(SecurityError);
    } finally {
      rmSync(siblingPrefix, { recursive: true, force: true });
    }
  });

  test("blocks symlink pointing outside workspace root", () => {
    const linkPath = join(workspaceDir, "escape-link");
    symlinkSync(outsideDir, linkPath);
    expect(() =>
      resolveSafePath(join(linkPath, "secret.txt"), [workspaceDir], workspaceDir, { configDir }),
    ).toThrow(SecurityError);
  });

  test("blocks dangling symlink pointing outside workspace root even with allowMissingLeaf", () => {
    const danglingTarget = join(outsideDir, "does-not-exist-yet", "secret.txt");
    const danglingLink = join(workspaceDir, "dangling-out");
    symlinkSync(danglingTarget, danglingLink);
    expect(() =>
      resolveSafePath("dangling-out", [workspaceDir], workspaceDir, {
        allowMissingLeaf: true,
        configDir,
      }),
    ).toThrow(SecurityError);

    const danglingDirLink = join(workspaceDir, "dangling-dir");
    symlinkSync(join(outsideDir, "nonexistent-dir"), danglingDirLink, "dir");
    expect(() =>
      resolveSafePath("dangling-dir/nested/pwn.txt", [workspaceDir], workspaceDir, {
        allowMissingLeaf: true,
        configDir,
      }),
    ).toThrow(SecurityError);
  });

  test("blocks sensitive directories even if root is home", () => {
    const home = homedir();
    const sshDir = join(home, ".ssh");
    expect(() =>
      resolveSafePath(sshDir, [home], home, { allowMissingLeaf: true, configDir }),
    ).toThrow(SecurityError);
    expect(() =>
      resolveSafePath(join(configDir, "state.json"), [configDir], configDir, {
        allowMissingLeaf: true,
        configDir,
      }),
    ).toThrow(SecurityError);
  });
});

describe("checkCommandSafety", () => {
  test("allows normal development commands", () => {
    expect(() => checkCommandSafety("ls -la && git status")).not.toThrow();
    expect(() => checkCommandSafety("bun test tests")).not.toThrow();
    expect(() => checkCommandSafety("rm -rf ./dist")).not.toThrow();
    expect(() => checkCommandSafety('git commit -m "fix graceful shutdown"')).not.toThrow();
    expect(() => checkCommandSafety('git commit -m "fix; shutdown bug"')).not.toThrow();
    expect(() => checkCommandSafety("git commit -m 'handle reboot cleanly'")).not.toThrow();
    expect(() => checkCommandSafety("rg shutdown src/")).not.toThrow();
    expect(() => checkCommandSafety("grep -n poweroff src/app.ts")).not.toThrow();
    expect(() => checkCommandSafety('echo "halt and catch fire"')).not.toThrow();
    expect(() => checkCommandSafety("bun run shutdown-helper.ts")).not.toThrow();
    expect(() => checkCommandSafety("command -v reboot")).not.toThrow();
  });

  test("blocks catastrophic commands", () => {
    expect(() => checkCommandSafety("rm -rf /")).toThrow(SecurityError);
    expect(() => checkCommandSafety("/bin/rm -rf /")).toThrow(SecurityError);
    expect(() => checkCommandSafety("rm -rf ~")).toThrow(SecurityError);
    expect(() => checkCommandSafety("mkfs.ext4 /dev/sda1")).toThrow(SecurityError);
    expect(() => checkCommandSafety(":(){ :|:& };:")).toThrow(SecurityError);
    expect(() => checkCommandSafety("dd if=/dev/zero of=/dev/disk0")).toThrow(SecurityError);
    expect(() => checkCommandSafety("shutdown -h now")).toThrow(SecurityError);
    expect(() => checkCommandSafety("/sbin/shutdown -h now")).toThrow(SecurityError);
    expect(() => checkCommandSafety('"shutdown" -h now')).toThrow(SecurityError);
    expect(() => checkCommandSafety("'reboot'")).toThrow(SecurityError);
    expect(() => checkCommandSafety('shut""down -h now')).toThrow(SecurityError);
    expect(() => checkCommandSafety("re\\boot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("sudo shutdown -h now")).toThrow(SecurityError);
    expect(() => checkCommandSafety('sudo "reboot"')).toThrow(SecurityError);
    expect(() => checkCommandSafety("sudo -n /usr/sbin/reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("sudo -u root shutdown -h now")).toThrow(SecurityError);
    expect(() => checkCommandSafety("sudo -nu root reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("env -u PATH reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("env -S reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("exec -a fake reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("$'\\''; reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("{ shutdown -h now; }")).toThrow(SecurityError);
    expect(() => checkCommandSafety("if reboot; then :; fi")).toThrow(SecurityError);
    expect(() => checkCommandSafety(">/dev/null reboot")).toThrow(SecurityError);
    expect(() => checkCommandSafety("FOO=1 poweroff")).toThrow(SecurityError);
    expect(() => checkCommandSafety("echo ok && halt")).toThrow(SecurityError);
    expect(() => checkCommandSafety("if true; then shutdown -h now; fi")).toThrow(SecurityError);
    expect(() => checkCommandSafety('echo "$(reboot)"')).toThrow(SecurityError);
    expect(() => checkCommandSafety('echo "`poweroff`"')).toThrow(SecurityError);
    expect(() => checkCommandSafety("C:\\Windows\\System32\\shutdown.exe /s /t 0")).toThrow(SecurityError);
    expect(() => checkCommandSafety("Remove-Item -Recurse -Force C:\\")).toThrow(SecurityError);
    expect(() => checkCommandSafety("rd /s /q C:\\Windows")).toThrow(SecurityError);
    expect(() => checkCommandSafety("rd /q /s C:\\Windows")).toThrow(SecurityError);
    expect(() => checkCommandSafety('Remove-Item "C:\\"`\n-Recurse -Force')).toThrow(SecurityError);
    expect(() => checkCommandSafety("Stop-Computer -Force")).toThrow(SecurityError);
  });

  test("isPathInside handles Windows case-insensitive paths, macOS case-insensitive denied checks, and separator boundaries", () => {
    expect(isPathInside("c:\\users\\alice\\Project\\sub\\file.ts", "C:\\Users\\Alice\\project", "win32")).toBe(true);
    expect(isPathInside("C:\\Users\\Alice\\project-other\\file.ts", "C:\\Users\\Alice\\project", "win32")).toBe(false);
    expect(isPathInside("/Users/alice/project", "/Users/alice/project", "darwin")).toBe(true);
    expect(isPathInside("/Users/alice/project/sub/file.ts", "/Users/alice/project", "darwin")).toBe(true);
    expect(isPathInside("/Users/alice/project-other", "/Users/alice/project", "darwin")).toBe(false);

    if (process.platform === "darwin" || process.platform === "win32") {
      const home = homedir();
      expect(() =>
        resolveSafePath(join(home, ".NPMRC"), [home], home, { allowMissingLeaf: true, configDir }),
      ).toThrow(SecurityError);
    }
  });
});

describe("configDir and audit masking", () => {
  test("getConfigDir falls back on empty values and rejects literal undefined/null", () => {
    const prev = process.env.GEMINATION_CONFIG_DIR;
    try {
      process.env.GEMINATION_CONFIG_DIR = "";
      expect(getConfigDir("")).toBe(join(homedir(), ".config", "gemination"));
      expect(() => getConfigDir("undefined")).toThrow();
      expect(() => getConfigDir("null")).toThrow();
    } finally {
      if (prev === undefined) delete process.env.GEMINATION_CONFIG_DIR;
      else process.env.GEMINATION_CONFIG_DIR = prev;
    }
  });

  test("AuditLogger redacts API keys and Gemination tokens before writing", () => {
    const audit = new AuditLogger(configDir);
    const fakeKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    audit.log({
      tool: "run_command",
      ok: true,
      durationMs: 5,
      summary: `run: curl -H "Authorization: Bearer gma_abcdefghijklmnop12345" && echo ${fakeKey}`,
    });
    const raw = readFileSync(join(configDir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain(fakeKey);
    expect(raw).not.toContain("gma_abcdefghijklmnop12345");
  });
});
