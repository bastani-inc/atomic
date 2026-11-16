import { randomUUID } from "crypto";
import { linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

const UNREADABLE_FILE_GRACE_MS = 1_000;

export const PARKED_FILE_MAX_AGE_MS = 60_000;

const PARKED_SUFFIX = /\.(\d+)\.[0-9a-f-]{36}\.stale$/;

export function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
  }
}

export function removeFileIfUnchanged(path: string, inspected: string | undefined): boolean {
  const parked = `${path}.${Date.now()}.${randomUUID()}.stale`;
  try {
    renameSync(path, parked);
  } catch {
    return false;
  }
  const removed = readFileOrUndefined(parked) === inspected;
  if (!removed) {
    try {
      linkSync(parked, path);
    } catch {
    }
  }
  removeFile(parked);
  return removed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pidOf(content: string | undefined): number | undefined {
  const pid = Number.parseInt(content ?? "", 10);
  return Number.isFinite(pid) ? pid : undefined;
}

export function isAbandoned(path: string, content: string | undefined): boolean {
  const pid = pidOf(content);
  if (pid !== undefined) return !isProcessAlive(pid);
  try {
    return Date.now() - statSync(path).mtimeMs >= UNREADABLE_FILE_GRACE_MS;
  } catch {
    return false;
  }
}

function removeLeftoverParkedFiles(lockPath: string): void {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(directory)) {
    const parkedAt = name.startsWith(prefix) ? PARKED_SUFFIX.exec(name)?.[1] : undefined;
    if (parkedAt === undefined) continue;
    const path = join(directory, name);
    const pid = pidOf(readFileOrUndefined(path));
    const holderDead = pid !== undefined && !isProcessAlive(pid);
    if (holderDead || Date.now() - Number(parkedAt) > PARKED_FILE_MAX_AGE_MS) removeFile(path);
  }
}

export function takeOverStaleLock(lockPath: string, inspected: string | undefined, token: string): void {
  const tokenContent = `${process.pid}\n`;
  try {
    writeFileSync(token, tokenContent, { flag: "wx" });
  } catch {
    const holder = readFileOrUndefined(token);
    if (isAbandoned(token, holder)) removeFileIfUnchanged(token, holder);
    return;
  }
  try {
    removeLeftoverParkedFiles(lockPath);
    if (readFileOrUndefined(lockPath) === inspected) removeFileIfUnchanged(lockPath, inspected);
  } finally {
    removeFileIfUnchanged(token, tokenContent);
  }
}
