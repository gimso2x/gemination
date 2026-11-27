import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

let compiledWinDispatcher: string | null = null;
let dispatcherTempDir: string | null = null;

function ensureWinDispatcher(): string {
  if (compiledWinDispatcher && existsSync(compiledWinDispatcher)) {
    return compiledWinDispatcher;
  }
  dispatcherTempDir = mkdtempSync(join(tmpdir(), "gemination-mock-disp-"));
  const srcPath = join(dispatcherTempDir, "dispatcher.ts");
  const outPath = join(dispatcherTempDir, "dispatcher.exe");
  writeFileSync(
    srcPath,
    [
      'import { existsSync } from "node:fs";',
      'import { dirname, join, parse } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      "const parsed = parse(process.execPath);",
      'const impl = join(dirname(process.execPath), `${parsed.name}.impl.mjs`);',
      "if (!existsSync(impl)) process.exit(127);",
      "await import(pathToFileURL(impl).href);",
      "",
    ].join("\n"),
    "utf8",
  );
  const built = Bun.spawnSync([process.execPath, "build", "--compile", srcPath, "--outfile", outPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(
      `Failed to compile Windows mock dispatcher: ${Buffer.from(built.stderr).toString("utf8")}`,
    );
  }
  compiledWinDispatcher = outPath;
  process.on("exit", () => {
    if (dispatcherTempDir) {
      try {
        rmSync(dispatcherTempDir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows handle locks at process teardown.
      }
    }
  });
  return outPath;
}

/**
 * Create an executable mock CLI binary inside `dir` backed by `jsBody` executed via Bun.
 * On POSIX this writes a lightweight `#!/usr/bin/env sh` wrapper calling `bun`.
 * On Windows this writes a `.impl.mjs` paired with a compiled native `.exe` dispatcher so `CreateProcess` / `Bun.spawn` works without `.cmd`.
 */
export function makeMockCli(dir: string, baseName: string, jsBody: string): string {
  const stem = baseName.replace(/\.(sh|cmd|exe)$/i, "");
  const implPath = join(dir, `${stem}.impl.mjs`);
  writeFileSync(implPath, jsBody, "utf8");

  if (process.platform === "win32") {
    const dispatcher = ensureWinDispatcher();
    const exePath = join(dir, `${stem}.exe`);
    try {
      linkSync(dispatcher, exePath);
    } catch {
      copyFileSync(dispatcher, exePath);
    }
    return exePath;
  }

  const shPath = join(dir, stem);
  writeFileSync(shPath, `#!/usr/bin/env sh\nexec bun "${implPath}" "$@"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return shPath;
}
