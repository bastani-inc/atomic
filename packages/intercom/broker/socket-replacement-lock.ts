import { unlinkSync } from "fs";
import {
  createLockFile,
  holderRecord,
  isAbandoned,
  pidOf,
  readFileOrUndefined,
  takeOverStaleLock,
  takeTokenTakeover,
} from "./stale-lock-file.js";

const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;

export interface SocketReplacementLockOptions {
  readonly onWait?: () => void;
}

function holderPid(path: string): number | undefined {
  return pidOf(readFileOrUndefined(path));
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already removed.
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
  // Made complete, so a lock being taken is never seen empty and taken from its maker as abandoned (#5220).
  while (!createLockFile(lockPath, holderRecord())) {
    const holder = readFileOrUndefined(lockPath);
    if (isAbandoned(lockPath, holder)) {
      // Only the waiter holding the takeover token for that holder removes its lock, and only while it is still
      // the abandoned one, judged again under the token, so a lock written since is never removed.
      takeOverStaleLock(
        lockPath,
        holder,
        (current) => isAbandoned(lockPath, current),
        () => takeTokenTakeover(`${lockPath}.takeover-${pidOf(holder) ?? "unreadable"}`),
      );
    } else if (!announcedWait) {
      announcedWait = true;
      onWait?.();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SOCKET_REPLACEMENT_LOCK_POLL_MS));
  }
  return () => {
    if (holderPid(lockPath) === process.pid) removeFile(lockPath);
  };
}
