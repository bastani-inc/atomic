import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { withFileLock } from "./file-lock.js";

interface ExecutionLeaseOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}

const OWNER_FILE = "owner.json";
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_HEARTBEAT_MS = 30_000;
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

export function executionLeasePath(filePath: string): string {
  return `${filePath}.active`;
}

export function claimExecutionLease(filePath: string, token: string): boolean {
  return withFileLock(filePath, () => {
    const leasePath = executionLeasePath(filePath);
    if (existsSync(leasePath)) {
      const owner = readOwner(leasePath);
      if (owner?.token === token) {
        startHeartbeat(leasePath, token);
        return true;
      }
      if (leaseIsActive(leasePath, owner)) return false;
      rmSync(leasePath, { recursive: true, force: true });
    }
    const temporaryPath = `${leasePath}.claim-${token}`;
    rmSync(temporaryPath, { recursive: true, force: true });
    mkdirSync(temporaryPath, { mode: 0o700 });
    try {
      const owner: ExecutionLeaseOwner = { pid: process.pid, host: hostname(), token, acquiredAt: Date.now() };
      writeFileSync(`${temporaryPath}/${OWNER_FILE}`, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
      renameSync(temporaryPath, leasePath);
    } finally {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
    startHeartbeat(leasePath, token);
    return true;
  });
}

export function hasActiveExecutionLease(filePath: string): boolean {
  return withFileLock(filePath, () => {
    const leasePath = executionLeasePath(filePath);
    if (!existsSync(leasePath)) return false;
    const owner = readOwner(leasePath);
    if (leaseIsActive(leasePath, owner)) return true;
    stopHeartbeat(leasePath);
    rmSync(leasePath, { recursive: true, force: true });
    return false;
  });
}

export function releaseExecutionLease(filePath: string, token: string): void {
  const leasePath = executionLeasePath(filePath);
  stopHeartbeat(leasePath);
  withFileLock(filePath, () => {
    if (readOwner(leasePath)?.token === token) rmSync(leasePath, { recursive: true, force: true });
  });
}

function leaseIsActive(leasePath: string, owner: ExecutionLeaseOwner | undefined): boolean {
  if (heartbeatAge(leasePath) > STALE_HEARTBEAT_MS) return false;
  if (owner === undefined) return existsSync(`${leasePath}/${OWNER_FILE}`);
  if (owner.host !== hostname()) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function heartbeatAge(leasePath: string): number {
  try {
    return Date.now() - statSync(`${leasePath}/${OWNER_FILE}`).mtimeMs;
  } catch {
    try {
      return Date.now() - statSync(leasePath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

function startHeartbeat(leasePath: string, token: string): void {
  if (heartbeats.has(leasePath)) return;
  const timer = setInterval(() => {
    if (readOwner(leasePath)?.token !== token) {
      stopHeartbeat(leasePath);
      return;
    }
    try {
      const now = new Date();
      utimesSync(`${leasePath}/${OWNER_FILE}`, now, now);
    } catch {
      stopHeartbeat(leasePath);
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  heartbeats.set(leasePath, timer);
}

function stopHeartbeat(leasePath: string): void {
  const timer = heartbeats.get(leasePath);
  if (timer !== undefined) clearInterval(timer);
  heartbeats.delete(leasePath);
}

function readOwner(leasePath: string): ExecutionLeaseOwner | undefined {
  try {
    const parsed: object = JSON.parse(readFileSync(`${leasePath}/${OWNER_FILE}`, "utf-8"));
    if (!isOwner(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isOwner(value: object): value is ExecutionLeaseOwner {
  const owner = value as Partial<ExecutionLeaseOwner>;
  return typeof owner.pid === "number"
    && typeof owner.host === "string"
    && typeof owner.token === "string"
    && typeof owner.acquiredAt === "number";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
