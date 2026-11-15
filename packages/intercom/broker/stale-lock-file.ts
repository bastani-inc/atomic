import { randomUUID } from "crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";

/** Locks and tokens get their pid as they are created, so one still unreadable after this was left by a crash. */
const UNREADABLE_FILE_GRACE_MS = 1_000;

/** The file's content, or undefined when it is absent or cannot be read. */
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
    // Already removed.
  }
}

/**
 * Removes `path` only while it is still exactly the file its caller read as `inspected` and judged stale (undefined
 * when that file was unreadable). The file is first renamed to a unique name, which is atomic on POSIX and Windows, so
 * the content checked is the content removed. A file that replaced the inspected one meanwhile is put back, unless
 * another file has taken the path since. Returns whether the inspected file was removed.
 */
export function removeFileIfUnchanged(path: string, inspected: string | undefined): boolean {
  const parked = `${path}.${randomUUID()}.stale`;
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
      // A newer file holds the path, and only one file can.
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

/** The pid a lock or token holding `${pid}\n` records, or undefined when it records none. */
export function pidOf(content: string | undefined): number | undefined {
  const pid = Number.parseInt(content ?? "", 10);
  return Number.isFinite(pid) ? pid : undefined;
}

/**
 * A lock or token read as `content` was left by a crashed process once its pid is dead, or once it stayed unreadable
 * past the grace period.
 */
export function isAbandoned(path: string, content: string | undefined): boolean {
  const pid = pidOf(content);
  if (pid !== undefined) return !isProcessAlive(pid);
  try {
    return Date.now() - statSync(path).mtimeMs >= UNREADABLE_FILE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Removes the stale lock at `lockPath`, read as `inspected`, unless another process is already replacing it. Only the
 * process that creates `token` may remove the lock, and it removes it only while it is still the inspected one, so two
 * processes that saw one stale lock cannot both replace it, and a lock written since is never removed. A token left by
 * a crashed process is removed, so a later attempt can take over.
 */
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
    if (readFileOrUndefined(lockPath) === inspected) removeFileIfUnchanged(lockPath, inspected);
  } finally {
    removeFileIfUnchanged(token, tokenContent);
  }
}
