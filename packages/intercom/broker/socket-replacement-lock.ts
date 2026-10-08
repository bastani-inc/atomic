import { randomUUID } from "crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";

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
 * Moves a dead holder's lock aside atomically. If another waiter replaced it first, the moved lock belongs to a live
 * holder and is linked back, which never overwrites a newer lock.
 */
function takeOverDeadHolder(lockPath: string, deadPid: number | undefined): void {
  const claimed = `${lockPath}.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, claimed);
  } catch {
    return;
  }
  if (holderPid(claimed) !== deadPid) {
    try {
      linkSync(claimed, lockPath);
    } catch {
      // A newer lock already governs the path.
    }
  }
  removeFile(claimed);
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
