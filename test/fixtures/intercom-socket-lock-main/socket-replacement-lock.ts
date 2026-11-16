import { unlinkSync, writeFileSync } from "fs";
import { isAbandoned, pidOf, readFileOrUndefined, takeOverStaleLock } from "./stale-lock-file.js";

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

export async function acquireSocketReplacementLock(
  lockPath: string,
  { onWait }: SocketReplacementLockOptions = {},
): Promise<() => void> {
  let announcedWait = false;
  while (!createExclusively(lockPath)) {
    const holder = readFileOrUndefined(lockPath);
    if (isAbandoned(lockPath, holder)) {
      takeOverStaleLock(lockPath, holder, `${lockPath}.takeover-${pidOf(holder) ?? "unreadable"}`);
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
