import { statSync, unlinkSync, writeFileSync } from "fs";
import { readFileOrUndefined, takeOverStaleLock } from "./stale-lock-file.js";

const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;
/** Locks and tokens get their pid as they are created, so one still unreadable after this was left by a crash. */
const UNREADABLE_FILE_GRACE_MS = 1_000;

export interface SocketReplacementLockOptions {
  readonly onWait?: () => void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderPid(path: string): number | undefined {
  return pidOf(readFileOrUndefined(path));
}

function pidOf(content: string | undefined): number | undefined {
  const pid = Number.parseInt(content?.trim() ?? "", 10);
  return Number.isFinite(pid) ? pid : undefined;
}

type Holder =
  | { readonly kind: "live" }
  | { readonly kind: "abandoned"; readonly pid: number | undefined; readonly content: string | undefined };

/** A file whose pid is dead, or that stayed unreadable past the grace period, was left by a crashed broker. */
function holderOf(path: string): Holder | undefined {
  const content = readFileOrUndefined(path);
  const pid = pidOf(content);
  if (pid !== undefined) return isProcessAlive(pid) ? { kind: "live" } : { kind: "abandoned", pid, content };
  try {
    return Date.now() - statSync(path).mtimeMs >= UNREADABLE_FILE_GRACE_MS
      ? { kind: "abandoned", pid: undefined, content }
      : { kind: "live" };
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

function createExclusively(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Serializes stale-socket replacement across brokers, so a broker that probed the socket as stale cannot unlink a
 * socket another broker bound in the meantime: the holder re-probes before it unlinks. A live holder's lock is never
 * taken; an abandoned one is. Resolves with the release function, which removes the lock only while this process
 * holds it.
 */
export async function acquireSocketReplacementLock(
  lockPath: string,
  { onWait }: SocketReplacementLockOptions = {},
): Promise<() => void> {
  let announcedWait = false;
  while (!createExclusively(lockPath)) {
    const holder = holderOf(lockPath);
    if (holder?.kind === "abandoned") {
      // Only the waiter holding the takeover token for that holder removes its lock, and only while it is still
      // the abandoned one, so a lock written since is never removed.
      takeOverStaleLock(lockPath, holder.content, `${lockPath}.takeover-${holder.pid ?? "unreadable"}`);
    } else if (holder?.kind === "live" && !announcedWait) {
      announcedWait = true;
      onWait?.();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_REPLACEMENT_LOCK_POLL_MS));
  }
  return () => {
    if (holderPid(lockPath) === process.pid) removeFile(lockPath);
  };
}
