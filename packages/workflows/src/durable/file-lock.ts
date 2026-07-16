import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { FileDurableState } from "./file-state.js";
import { invalidateDurableFileStateCache } from "./file-backend-cache.js";

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}

const LOCK_OWNER_FILE = "owner.json";
const STALE_LOCK_MS = 30_000;

export function writeDurableFileState(filePath: string, state: FileDurableState): void {
  const dir = dirname(filePath);
  ensureSecureDir(dir);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
  chmodBestEffort(tmp, 0o600);
  renameSync(tmp, filePath);
  chmodBestEffort(filePath, 0o600);
  invalidateDurableFileStateCache(filePath);
}

export function withDurableFileLock<T>(filePath: string, fn: () => T): T {
  const dir = dirname(filePath);
  ensureSecureDir(dir);
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        chmodBestEffort(lockDir, 0o700);
        writeLockOwner(lockDir);
      } catch (ownerErr) {
        rmSync(lockDir, { recursive: true, force: true });
        throw ownerErr;
      }
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (tryReclaimStaleLock(lockDir, STALE_LOCK_MS)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out acquiring durable workflow state lock: ${lockDir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Async variant of {@link withDurableFileLock}: identical ownership, stale-lock
 * reclamation, and timeout semantics, but contention waits with an event-loop
 * friendly `setTimeout` sleep instead of pinning the main thread in
 * `Atomics.wait` (which could stall the TUI for up to the full 5 s deadline).
 */
export async function withDurableFileLockAsync<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const dir = dirname(filePath);
  ensureSecureDir(dir);
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        chmodBestEffort(lockDir, 0o700);
        writeLockOwner(lockDir);
      } catch (ownerErr) {
        rmSync(lockDir, { recursive: true, force: true });
        throw ownerErr;
      }
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      if (tryReclaimStaleLock(lockDir, STALE_LOCK_MS)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out acquiring durable workflow state lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

const durableWriteQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize async durable writers per state file inside this process so
 * checkpoint order is preserved without spinning on the lock directory.
 */
export function enqueueDurableFileWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = durableWriteQueues.get(filePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  durableWriteQueues.set(filePath, settled);
  void settled.finally(() => {
    if (durableWriteQueues.get(filePath) === settled) durableWriteQueues.delete(filePath);
  });
  return run;
}

function tryReclaimStaleLock(lockDir: string, staleMs: number): boolean {
  if (!isStaleLock(lockDir, staleMs)) return false;
  const owner = readLockOwner(lockDir);
  if (owner === undefined || !isLockOwnerAbandoned(owner)) return false;
  const quarantine = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockDir, quarantine);
  } catch {
    return false;
  }
  const quarantinedOwner = readLockOwner(quarantine);
  if (!sameLockOwner(owner, quarantinedOwner)) {
    restoreQuarantinedLock(lockDir, quarantine);
    return false;
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // The stale lock has already been moved away from the active lock path.
  }
  return true;
}

function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function writeLockOwner(lockDir: string): void {
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    acquiredAt: Date.now(),
  };
  const ownerPath = `${lockDir}/${LOCK_OWNER_FILE}`;
  writeFileSync(ownerPath, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
  chmodBestEffort(ownerPath, 0o600);
}

function readLockOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${lockDir}/${LOCK_OWNER_FILE}`, "utf-8"));
    return isLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<LockOwner>;
  return typeof record.pid === "number" && typeof record.host === "string"
    && typeof record.token === "string" && typeof record.acquiredAt === "number";
}

function isLockOwnerAbandoned(owner: LockOwner): boolean {
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return errorCode(err) === "ESRCH";
  }
}

function sameLockOwner(a: LockOwner, b: LockOwner | undefined): boolean {
  return b !== undefined && a.pid === b.pid && a.host === b.host && a.token === b.token;
}

function restoreQuarantinedLock(lockDir: string, quarantine: string): void {
  try {
    if (!existsSync(lockDir)) renameSync(quarantine, lockDir);
    else rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // Best-effort: never delete the active lock path after a failed compare.
  }
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodBestEffort(dir, 0o700);
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // chmod is unavailable or unsupported on some filesystems/platforms.
  }
}
