import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, ensureDirSecure } from "./config.ts";

export const LOCK_FILENAME = "gemination.lock";

export interface InstanceLockRecord {
  pid: number;
  instanceId: string;
  port: number;
  localBaseUrl?: string;
  studioBaseUrl?: string;
  publicBaseUrl?: string;
  tunnelMode?: string;
  startedAt: string;
}

export class InstanceAlreadyRunningError extends Error {
  readonly existing: Partial<InstanceLockRecord>;

  constructor(existing: Partial<InstanceLockRecord>, configDir: string) {
    const pidText = typeof existing.pid === "number" ? `PID ${existing.pid}` : "다른 프로세스";
    const lines = [
      `Gemination 서버가 이미 실행 중입니다 (${pidText}, 설정 폴더: ${configDir}).`,
      ...(existing.localBaseUrl ? [`  - 로컬 대시보드: ${existing.localBaseUrl}/`] : []),
      ...(existing.publicBaseUrl ? [`  - Gemini MCP URL: ${existing.publicBaseUrl}/mcp`] : []),
      "  기존 서버를 그대로 쓰시거나 종료한 뒤 다시 실행하세요. (별도 프로필은 `--profile <name>` 사용)",
    ];
    super(lines.join("\n"));
    this.name = "InstanceAlreadyRunningError";
    this.existing = existing;
  }
}

export interface InstanceLockHandle {
  record: InstanceLockRecord;
  update: (patch: Partial<InstanceLockRecord>) => void;
  release: () => void;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means process exists under another UID; only ESRCH means gone.
    return code !== "ESRCH";
  }
}

function writeLockExclusive(lockPath: string, record: InstanceLockRecord): void {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, 0, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeLockReplace(lockPath: string, record: InstanceLockRecord): void {
  atomicWriteFile(lockPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export function acquireInstanceLock(
  configDir: string,
  initial: Omit<InstanceLockRecord, "pid" | "instanceId" | "startedAt"> & { instanceId?: string },
): InstanceLockHandle {
  ensureDirSecure(configDir);
  const lockPath = join(configDir, LOCK_FILENAME);
  let record: InstanceLockRecord = {
    pid: process.pid,
    instanceId: initial.instanceId ?? crypto.randomUUID(),
    port: initial.port,
    localBaseUrl: initial.localBaseUrl,
    studioBaseUrl: initial.studioBaseUrl,
    publicBaseUrl: initial.publicBaseUrl,
    tunnelMode: initial.tunnelMode,
    startedAt: new Date().toISOString(),
  };

  try {
    writeLockExclusive(lockPath, record);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }

    let parsed: Partial<InstanceLockRecord> = {};
    try {
      parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<InstanceLockRecord>;
    } catch {
      parsed = {};
    }

    if (typeof parsed.pid === "number" && parsed.pid > 0 && isPidAlive(parsed.pid)) {
      throw new InstanceAlreadyRunningError(parsed, configDir);
    }

    // Stale lock from a crashed process — remove and retry once atomically.
    rmSync(lockPath, { force: true });
    try {
      writeLockExclusive(lockPath, record);
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
        let contender: Partial<InstanceLockRecord> = {};
        try {
          contender = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<InstanceLockRecord>;
        } catch {
          contender = {};
        }
        throw new InstanceAlreadyRunningError(contender, configDir);
      }
      throw retryErr;
    }
  }

  let released = false;

  const isOwnedByUs = (): boolean => {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<InstanceLockRecord>;
      return current.instanceId === record.instanceId;
    } catch {
      return false;
    }
  };

  return {
    get record() {
      return record;
    },
    update(patch: Partial<InstanceLockRecord>): void {
      if (released || !isOwnedByUs()) return;
      record = {
        ...record,
        ...patch,
        pid: record.pid,
        instanceId: record.instanceId,
        startedAt: record.startedAt,
      };
      try {
        writeLockReplace(lockPath, record);
      } catch {
        // Non-fatal if lock disappears during shutdown.
      }
    },
    release(): void {
      if (released) return;
      released = true;
      if (isOwnedByUs()) {
        rmSync(lockPath, { force: true });
      }
    },
  };
}

export function readInstanceLock(configDir: string): {
  running: boolean;
  record?: InstanceLockRecord;
} {
  const lockPath = join(configDir, LOCK_FILENAME);
  if (!existsSync(lockPath)) {
    return { running: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as InstanceLockRecord;
    if (typeof parsed.pid === "number" && parsed.pid > 0 && isPidAlive(parsed.pid)) {
      return { running: true, record: parsed };
    }
    return { running: false, record: parsed };
  } catch {
    return { running: false };
  }
}
