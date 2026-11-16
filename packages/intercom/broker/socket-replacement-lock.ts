import { readdirSync, unlinkSync } from "fs";
import { basename, dirname } from "path";
import {
  createLockFile,
  holderRecord,
  isAbandoned,
  readFileOrUndefined,
  removeFileIfUnchanged,
  removeLeftoverParkedFiles,
} from "./stale-lock-file.js";

const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;

/** What a holder writes as the next generation when it releases the lock. */
const RELEASED = "released\n";

export interface SocketReplacementLockOptions {
  readonly onWait?: () => void;
}

/** The socket-replacement lock this broker holds: calling it releases the lock. */
export interface SocketReplacementLock {
  (): void;
  /**
   * Whether this broker still holds the lock, checked just before it acts under it (#5220). False once its generation
   * is no longer the latest, or its lock file was moved or replaced: a broker that finds that has lost the lock and
   * must not act as its holder.
   */
  held(): boolean;
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already removed.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The file of generation `generation` of the lock at `lockPath`. */
function generationPath(lockPath: string, generation: number): string {
  return `${lockPath}.g${generation}`;
}

/** The generations of the lock at `lockPath` that are on disk, highest first. */
function generations(lockPath: string): number[] {
  const prefix = `${basename(lockPath)}.g`;
  const found: number[] = [];
  for (const name of readdirSync(dirname(lockPath))) {
    if (!name.startsWith(prefix)) continue;
    const digits = name.slice(prefix.length);
    if (/^\d+$/.test(digits)) found.push(Number(digits));
  }
  return found.sort((a, b) => b - a);
}

/**
 * Whether the latest generation, read as `content`, leaves the lock free: released, or held by a process that is
 * gone, or a record that stayed incomplete and unchanged for a grace period, as one left by a process killed while
 * writing it on a file system without hard links (#5220).
 */
function generationFree(path: string, content: string | undefined): boolean {
  if (content === RELEASED) return true;
  return isAbandoned(path, content);
}

/**
 * Serializes stale-socket replacement across brokers, so a broker that probed the socket as stale cannot unlink a
 * socket another broker bound in the meantime: the holder re-probes before it unlinks (#3505).
 *
 * The lock is a series of generations, files `<lock>.g<n>`, and the latest one decides (#5220). A broker takes the lock
 * by creating the generation after the latest, complete or not at all, when the latest is released or its holder is
 * gone; creating a file fails while one is there, so exactly one broker takes each generation, and no broker ever
 * moves or removes a generation another may hold. A broker that created a generation which is not the latest (it
 * judged an older one) removes its own and looks again. Nothing is ever taken over by moving a file aside, so a broker
 * paused or killed at any point can neither take a live broker's lock nor lose one it holds.
 *
 * Brokers of earlier versions take the single file `lockPath`; a broker holding the latest generation takes that file
 * too, and waits while an earlier broker that still runs holds it, so the two never replace the socket at once.
 *
 * Resolves with the lock, which releases it when called, and whose `held()` says whether this broker still holds it.
 */
export async function acquireSocketReplacementLock(
  lockPath: string,
  { onWait }: SocketReplacementLockOptions = {},
): Promise<SocketReplacementLock> {
  const record = holderRecord();
  let announcedWait = false;
  const waiting = async () => {
    if (!announcedWait) {
      announcedWait = true;
      onWait?.();
    }
    await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
  };
  let generation: number;
  for (;;) {
    const latest = generations(lockPath)[0];
    if (latest !== undefined) {
      const path = generationPath(lockPath, latest);
      const content = readFileOrUndefined(path);
      // Gone meanwhile, as an older generation removed by a broker that took the lock, or unreadable for a moment.
      if (content === undefined) {
        await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
        continue;
      }
      if (!generationFree(path, content)) {
        await waiting();
        continue;
      }
    }
    const next = (latest ?? 0) + 1;
    if (createLockFile(generationPath(lockPath, next), record)) {
      if (generations(lockPath)[0] === next) {
        generation = next;
        break;
      }
      // A later generation was taken meanwhile: this one, made from an older judgment, holds nothing.
      removeFile(generationPath(lockPath, next));
    }
    await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
  }
  // Older generations hold nothing now; only this broker removes them.
  for (const older of generations(lockPath)) if (older < generation) removeFile(generationPath(lockPath, older));

  const mine = generationPath(lockPath, generation);
  const holdsGeneration = () =>
    generations(lockPath)[0] === generation && readFileOrUndefined(mine) === record;
  // Copies of the legacy file a removal left parked, whose holder is gone, are removed by the latest generation's holder,
  // the only broker that moves that file (#5220); one naming a running broker is that broker's and is kept.
  try {
    removeLeftoverParkedFiles(lockPath);
  } catch {
    // Best effort: a parked file is only clutter.
  }
  // The single lock file earlier versions take.
  for (;;) {
    if (createLockFile(lockPath, record)) break;
    const holder = readFileOrUndefined(lockPath);
    // Only the holder of the latest generation removes it, and only while it is still the abandoned one it judged.
    if (holder !== undefined && isAbandoned(lockPath, holder)) removeFileIfUnchanged(lockPath, holder);
    else await waiting();
  }

  const held = () => holdsGeneration() && readFileOrUndefined(lockPath) === record;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeFileIfUnchanged(lockPath, record);
    if (!holdsGeneration()) return;
    try {
      // Its own generation is removed once the released one is in place, so a broker that idles out leaves exactly one
      // file, the released marker (#4727, #5220). The marker itself stays: removed, numbering would start again, and a
      // broker paused with a judgment of an older generation could then take one that looks like the latest.
      if (createLockFile(generationPath(lockPath, generation + 1), RELEASED)) removeFile(mine);
    } catch {
      // Not written: the lock is free once this broker is gone.
    }
  };
  return Object.assign(release, { held });
}
