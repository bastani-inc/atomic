import { readFileSync, unlinkSync, writeFileSync } from "fs";

const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;
/** A holder writes its pid as it creates the lock, so a lock unreadable for this long was left by a crashed broker. */
const UNREADABLE_LOCK_GRACE_MS = 1_000;

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

function holderPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
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
 * Removes a dead holder's lock without ever touching a live one. Only the waiter that creates the takeover token for
 * that holder may remove its lock, and while that lock exists no newer lock can be created, so the lock it removes is
 * still the dead holder's.
 */
function takeOverDeadHolder(lockPath: string, deadPid: number | undefined): void {
  const token = `${lockPath}.takeover-${deadPid ?? "unreadable"}`;
  try {
    writeFileSync(token, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const tokenHolder = holderPid(token);
    if (tokenHolder !== undefined && !isProcessAlive(tokenHolder)) removeFile(token);
    return;
  }
  try {
    if (holderPid(lockPath) === deadPid) removeFile(lockPath);
  } finally {
    removeFile(token);
  }
}

/**
 * Serializes stale-socket replacement across brokers, so a broker that probed the socket as stale cannot unlink a
 * socket another broker bound in the meantime: the holder re-probes before it unlinks. A live holder's lock is never
 * taken; a dead holder's lock is. Resolves with the release function, which removes the lock only while this process
 * holds it.
 */
export async function acquireSocketReplacementLock(
  lockPath: string,
  { onWait }: SocketReplacementLockOptions = {},
): Promise<() => void> {
  let announcedWait = false;
  let unreadableSince: number | undefined;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return () => {
        if (holderPid(lockPath) === process.pid) removeFile(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = holderPid(lockPath);
    unreadableSince = holder === undefined ? (unreadableSince ?? Date.now()) : undefined;
    const unreadableTooLong = unreadableSince !== undefined && Date.now() - unreadableSince >= UNREADABLE_LOCK_GRACE_MS;
    if ((holder !== undefined && !isProcessAlive(holder)) || unreadableTooLong) {
      takeOverDeadHolder(lockPath, holder);
      unreadableSince = undefined;
      continue;
    }
    if (!announcedWait) {
      announcedWait = true;
      onWait?.();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_REPLACEMENT_LOCK_POLL_MS));
  }
}
