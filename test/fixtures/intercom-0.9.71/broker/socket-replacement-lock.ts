import { readFileSync, statSync, unlinkSync, writeFileSync } from "fs";

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
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

type Holder = { readonly kind: "live" } | { readonly kind: "abandoned"; readonly pid: number | undefined };

/** A file whose pid is dead, or that stayed unreadable past the grace period, was left by a crashed broker. */
function holderOf(path: string): Holder | undefined {
  const pid = holderPid(path);
  if (pid !== undefined) return isProcessAlive(pid) ? { kind: "live" } : { kind: "abandoned", pid };
  try {
    return Date.now() - statSync(path).mtimeMs >= UNREADABLE_FILE_GRACE_MS
      ? { kind: "abandoned", pid: undefined }
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
 * Removes an abandoned lock without ever touching a live one. Only the waiter that creates the takeover token for
 * that holder may remove its lock, and while that lock exists no newer lock can be created, so the lock it removes is
 * still the abandoned one. An abandoned token is removed so a later waiter can take over.
 */
function takeOverAbandonedLock(lockPath: string, abandonedPid: number | undefined): void {
  const token = `${lockPath}.takeover-${abandonedPid ?? "unreadable"}`;
  if (!createExclusively(token)) {
    if (holderOf(token)?.kind === "abandoned") removeFile(token);
    return;
  }
  try {
    if (holderPid(lockPath) === abandonedPid) removeFile(lockPath);
  } finally {
    removeFile(token);
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
      takeOverAbandonedLock(lockPath, holder.pid);
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
