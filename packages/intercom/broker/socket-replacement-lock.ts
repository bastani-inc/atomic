import { readFileSync, unlinkSync, writeFileSync } from "fs";

/** A holder only probes, unlinks and binds; a lock held longer than this belongs to a hung broker. */
export const SOCKET_REPLACEMENT_LOCK_MAX_WAIT_MS = 5_000;
const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;

export interface SocketReplacementLockOptions {
  readonly maxWaitMs?: number;
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

function removeLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // The holder or another waiter already removed it.
  }
}

/**
 * Serializes stale-socket replacement across brokers, so a broker that probed the socket as stale cannot unlink a
 * socket another broker bound in the meantime: the holder re-probes before it unlinks. Resolves with the release
 * function, which removes the lock only while this process still holds it.
 */
export async function acquireSocketReplacementLock(
  lockPath: string,
  { maxWaitMs = SOCKET_REPLACEMENT_LOCK_MAX_WAIT_MS, onWait }: SocketReplacementLockOptions = {},
): Promise<() => void> {
  const deadline = Date.now() + maxWaitMs;
  let announcedWait = false;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return () => {
        if (holderPid(lockPath) === process.pid) removeLock(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = holderPid(lockPath);
    if ((holder !== undefined && !isProcessAlive(holder)) || Date.now() >= deadline) {
      removeLock(lockPath);
      continue;
    }
    if (!announcedWait) {
      announcedWait = true;
      onWait?.();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_REPLACEMENT_LOCK_POLL_MS));
  }
}
