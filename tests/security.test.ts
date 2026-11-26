import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../src/config.ts";
import { AuditLogger, checkCommandSafety, resolveSafePath, SecurityError } from "../src/security.ts";

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
      resolveSafePath(`../${outsideDir.split("/").pop()}/secret.txt`, [workspaceDir], workspaceDir, {
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
    symlinkSync(join(outsideDir, "nonexistent-dir"), danglingDirLink);
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
  });

  test("blocks catastrophic commands", () => {
    expect(() => checkCommandSafety("rm -rf /")).toThrow(SecurityError);
    expect(() => checkCommandSafety("/bin/rm -rf /")).toThrow(SecurityError);
    expect(() => checkCommandSafety("rm -rf ~")).toThrow(SecurityError);
    expect(() => checkCommandSafety("mkfs.ext4 /dev/sda1")).toThrow(SecurityError);
    expect(() => checkCommandSafety(":(){ :|:& };:")).toThrow(SecurityError);
    expect(() => checkCommandSafety("dd if=/dev/zero of=/dev/disk0")).toThrow(SecurityError);
    expect(() => checkCommandSafety("shutdown -h now")).toThrow(SecurityError);
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
