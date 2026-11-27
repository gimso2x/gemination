import { randomBytes } from "node:crypto";
import { killProcessGracefully, resolveShellCommand } from "./platform.ts";
import { buildSanitizedChildEnv } from "./security.ts";
import type { ManagedProcessInfo } from "./types.ts";

const MAX_CONCURRENT_PROCESSES = 16;
const MAX_STREAM_BUFFER_BYTES = 512 * 1024;
const DEFAULT_POLL_BYTES = 32 * 1024;

interface StreamBuffer {
  chunks: Uint8Array[];
  bufferBytes: number;
  baseOffset: number;
  totalBytes: number;
  truncated: boolean;
}

interface ManagedEntry {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt?: string;
  stdout: StreamBuffer;
  stderr: StreamBuffer;
}

function createStreamBuffer(): StreamBuffer {
  return {
    chunks: [],
    bufferBytes: 0,
    baseOffset: 0,
    totalBytes: 0,
    truncated: false,
  };
}

function appendStreamChunk(buf: StreamBuffer, chunk: Uint8Array): void {
  if (chunk.byteLength === 0) return;
  buf.chunks.push(chunk);
  buf.bufferBytes += chunk.byteLength;
  buf.totalBytes += chunk.byteLength;

  while (buf.bufferBytes > MAX_STREAM_BUFFER_BYTES && buf.chunks.length > 0) {
    const oldest = buf.chunks[0]!;
    const excess = buf.bufferBytes - MAX_STREAM_BUFFER_BYTES;
    if (oldest.byteLength <= excess) {
      buf.chunks.shift();
      buf.bufferBytes -= oldest.byteLength;
      buf.baseOffset += oldest.byteLength;
      buf.truncated = true;
    } else {
      buf.chunks[0] = oldest.subarray(excess);
      buf.bufferBytes -= excess;
      buf.baseOffset += excess;
      buf.truncated = true;
    }
  }
}

function readStreamSlice(
  buf: StreamBuffer,
  requestedOffset = 0,
  maxBytes = DEFAULT_POLL_BYTES,
): { text: string; nextOffset: number } {
  const effectiveStart = Math.max(buf.baseOffset, requestedOffset);
  if (effectiveStart >= buf.totalBytes || buf.bufferBytes === 0) {
    return { text: "", nextOffset: buf.totalBytes };
  }

  const limit = Math.max(1, Math.min(maxBytes, MAX_STREAM_BUFFER_BYTES));
  const combined = new Uint8Array(buf.bufferBytes);
  let pos = 0;
  for (const chunk of buf.chunks) {
    combined.set(chunk, pos);
    pos += chunk.byteLength;
  }

  const relativeStart = effectiveStart - buf.baseOffset;
  const relativeEnd = Math.min(combined.byteLength, relativeStart + limit);
  const slice = combined.subarray(relativeStart, relativeEnd);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(slice),
    nextOffset: buf.baseOffset + relativeEnd,
  };
}

async function drainReadable(
  stream: ReadableStream<Uint8Array> | number | undefined | null,
  target: StreamBuffer,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) appendStreamChunk(target, value);
    }
  } catch {
    // Stream closed or terminated.
  } finally {
    reader.releaseLock();
  }
}

export class ProcessManager {
  private readonly entries = new Map<string, ManagedEntry>();

  private pruneFinishedIfFull(): void {
    const runningCount = Array.from(this.entries.values()).filter((e) => e.status === "running").length;
    if (runningCount >= MAX_CONCURRENT_PROCESSES) {
      throw new Error(`Maximum concurrent managed processes (${MAX_CONCURRENT_PROCESSES}) reached`);
    }
    if (this.entries.size >= MAX_CONCURRENT_PROCESSES * 2) {
      for (const [id, entry] of this.entries) {
        if (entry.status !== "running") {
          this.entries.delete(id);
          if (this.entries.size < MAX_CONCURRENT_PROCESSES * 2) break;
        }
      }
    }
  }

  private toInfo(entry: ManagedEntry): ManagedProcessInfo {
    return {
      id: entry.id,
      pid: entry.proc.pid,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stdoutBytes: entry.stdout.totalBytes,
      stderrBytes: entry.stderr.totalBytes,
      truncated: entry.stdout.truncated || entry.stderr.truncated,
    };
  }

  start(command: string, cwd: string): ManagedProcessInfo {
    this.pruneFinishedIfFull();
    const id = `proc_${randomBytes(6).toString("hex")}`;
    const useProcessGroup = process.platform !== "win32";
    const proc = Bun.spawn(resolveShellCommand(command), {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: buildSanitizedChildEnv(),
      detached: useProcessGroup,
    });

    const entry: ManagedEntry = {
      id,
      proc,
      command,
      cwd,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      stdout: createStreamBuffer(),
      stderr: createStreamBuffer(),
    };
    this.entries.set(id, entry);

    void drainReadable(proc.stdout, entry.stdout);
    void drainReadable(proc.stderr, entry.stderr);
    void proc.exited.then((code) => {
      if (entry.status === "running") {
        entry.status = "exited";
      }
      entry.exitCode = code;
      entry.endedAt = new Date().toISOString();
    });

    return this.toInfo(entry);
  }

  poll(
    id: string,
    stdoutOffset = 0,
    stderrOffset = 0,
    maxBytes = DEFAULT_POLL_BYTES,
  ): {
    info: ManagedProcessInfo;
    stdoutChunk: string;
    stderrChunk: string;
    nextStdoutOffset: number;
    nextStderrOffset: number;
  } {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Unknown process id: ${id}`);
    }
    const stdoutSlice = readStreamSlice(entry.stdout, stdoutOffset, maxBytes);
    const stderrSlice = readStreamSlice(entry.stderr, stderrOffset, maxBytes);
    return {
      info: this.toInfo(entry),
      stdoutChunk: stdoutSlice.text,
      stderrChunk: stderrSlice.text,
      nextStdoutOffset: stdoutSlice.nextOffset,
      nextStderrOffset: stderrSlice.nextOffset,
    };
  }

  stop(id: string, force = false): ManagedProcessInfo {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Unknown process id: ${id}`);
    }
    if (entry.status === "running") {
      const sig = force ? "SIGKILL" : "SIGTERM";
      entry.signal = sig;
      entry.status = "killed";
      killProcessGracefully(entry.proc, force, process.platform, {
        processGroup: process.platform !== "win32",
      });
      entry.endedAt = new Date().toISOString();
    }
    return this.toInfo(entry);
  }

  list(): ManagedProcessInfo[] {
    return Array.from(this.entries.values()).map((entry) => this.toInfo(entry));
  }

  stopAll(): void {
    const useProcessGroup = process.platform !== "win32";
    for (const entry of this.entries.values()) {
      if (entry.status === "running") {
        killProcessGracefully(entry.proc, true, process.platform, {
          processGroup: useProcessGroup,
        });
        entry.status = "killed";
        entry.signal = "SIGKILL";
        entry.endedAt = new Date().toISOString();
      }
    }
  }
}
