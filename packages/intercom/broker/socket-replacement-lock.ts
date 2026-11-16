import { randomUUID } from "crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import {
  createLockFile,
  holderRecord,
  isAbandoned,
  pidOf,
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
   * Whether this broker still holds the lock, checked immediately before each act under it: unlinking, binding or
   * closing the socket (#5220). False once its generation is no longer the latest, its legacy lock file is no longer
   * its own, or a broker of an earlier version holds a takeover token, and so may be moving the legacy file. A broker
   * that finds it false has lost the lock, or may share it, and must not act.
   */
  held(): boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The directory of generation `generation` of the lock at `lockPath`. */
function generationPath(lockPath: string, generation: number): string {
  return `${lockPath}.gen${generation}`;
}

/** The record inside a generation: its holder, or {@link RELEASED}. */
function generationRecord(lockPath: string, generation: number): string | undefined {
  return readFileOrUndefined(join(generationPath(lockPath, generation), "owner"));
}

/** The generations of the lock at `lockPath` that are on disk, highest first. */
function generations(lockPath: string): number[] {
  const prefix = `${basename(lockPath)}.gen`;
  const found: number[] = [];
  for (const name of readdirSync(dirname(lockPath))) {
    if (!name.startsWith(prefix)) continue;
    const digits = name.slice(prefix.length);
    if (/^\d+$/.test(digits)) found.push(Number(digits));
  }
  return found.sort((a, b) => b - a);
}

/** The prefix of the directories in which generations are made before they are moved into place. */
function stagingPrefix(lockPath: string): string {
  return `${basename(lockPath)}.staging-`;
}

/**
 * Makes generation `generation` holding `record`, complete or not at all (#5220): its directory is made under a name of
 * its own with the record already written in it, and then moved into place, which fails while that generation is
 * there. No reader ever sees a generation without its record, on any file system, so none is ever judged by a time
 * grace. True when it is in place.
 */
function createGeneration(lockPath: string, generation: number, record: string): boolean {
  const staging = join(dirname(lockPath), `${stagingPrefix(lockPath)}${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(staging);
    writeFileSync(join(staging, "owner"), record);
    renameSync(staging, generationPath(lockPath, generation));
    return true;
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

/** Whether a generation read as `record` leaves the lock free: released, or held by a process that is gone. */
function generationFree(path: string, record: string): boolean {
  return record === RELEASED || isAbandoned(path, record);
}

/**
 * Removes generations older than `generation`, which hold nothing, and staging directories of processes that died
 * while making a generation. Only the holder of the latest generation calls this.
 */
function removeLeftovers(lockPath: string, generation: number): void {
  for (const older of generations(lockPath)) {
    if (older < generation) rmSync(generationPath(lockPath, older), { recursive: true, force: true });
  }
  const prefix = stagingPrefix(lockPath);
  for (const name of readdirSync(dirname(lockPath))) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isFinite(pid) && isAbandoned(lockPath, `${pid}\n`)) {
      rmSync(join(dirname(lockPath), name), { recursive: true, force: true });
    }
  }
}

/** The takeover tokens, `<lock>.takeover-<holder>`, that brokers of earlier versions take to replace a stale lock. */
function takeoverTokens(lockPath: string): string[] {
  const token = new RegExp(`^${basename(lockPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.takeover-[^.]+$`);
  return readdirSync(dirname(lockPath))
    .filter((name) => token.test(name))
    .map((name) => join(dirname(lockPath), name));
}

/** Whether a broker that may still act holds a takeover token: its holder runs, or it cannot be shown to be gone. */
function liveTakeoverToken(lockPath: string, own?: string): boolean {
  return takeoverTokens(lockPath).some((token) => {
    if (token === own) return false;
    const content = readFileOrUndefined(token);
    return content !== undefined && !isAbandoned(token, content);
  });
}

/**
 * Replaces the legacy lock file read as `holder`, which is abandoned, the way earlier versions do (#5220): under their
 * takeover token for that holder, so no broker of an earlier version replaces the same file meanwhile, re-reading the
 * file under the token, and moving it aside and removing it only when it is still the one judged. A file moved that is
 * not is put back while the path is free, and otherwise left parked, never removed. A token a dead broker left is
 * moved the same way.
 */
function replaceAbandonedLegacy(lockPath: string, holder: string, record: string): void {
  const token = `${lockPath}.takeover-${pidOf(holder) ?? "unreadable"}`;
  if (!createLockFile(token, record)) {
    const tokenHolder = readFileOrUndefined(token);
    if (tokenHolder !== undefined && isAbandoned(token, tokenHolder)) removeFileIfUnchanged(token, tokenHolder);
    return;
  }
  try {
    if (readFileOrUndefined(token) !== record || readFileOrUndefined(lockPath) !== holder) return;
    if (!isAbandoned(lockPath, holder)) return;
    removeFileIfUnchanged(lockPath, holder);
  } finally {
    removeFileIfUnchanged(token, record);
  }
}

/**
 * Serializes stale-socket replacement across brokers, so a broker that probed the socket as stale cannot unlink a
 * socket another broker bound in the meantime: the holder re-probes before it unlinks (#3505).
 *
 * The lock is a series of generations, directories `<lock>.gen<n>` naming their holder, and the latest one decides
 * (#5220). A broker takes the lock by making the generation after the latest, complete or not at all, once the latest
 * is released or its holder is gone; exactly one broker makes each generation, and no broker moves or removes a
 * generation another may hold. A broker that made a generation which is not the latest (it judged an older one)
 * removes its own and looks again. The holder releases the lock by making the next generation, released, and removing
 * its own, so one released generation stays, and the numbering never starts again.
 *
 * Brokers of earlier versions take the single file `lockPath`. The holder of the latest generation takes that file too,
 * replacing an abandoned one only as they do, under their takeover token, and {@link SocketReplacementLock.held} says
 * whether it still holds both and no broker of an earlier version is replacing a lock.
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
      const content = generationRecord(lockPath, latest);
      // Being removed, as an older generation by a broker that took the lock: it is not the latest for long.
      if (content === undefined) {
        await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
        continue;
      }
      if (!generationFree(join(generationPath(lockPath, latest), "owner"), content)) {
        await waiting();
        continue;
      }
    }
    const next = (latest ?? 0) + 1;
    if (createGeneration(lockPath, next, record)) {
      if (generations(lockPath)[0] === next) {
        generation = next;
        break;
      }
      // A later generation was taken meanwhile: this one, made from an older judgment, holds nothing.
      rmSync(generationPath(lockPath, next), { recursive: true, force: true });
    }
    await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
  }
  removeLeftovers(lockPath, generation);
  const holdsGeneration = () =>
    generations(lockPath)[0] === generation && generationRecord(lockPath, generation) === record;

  // Copies of the legacy file a removal left parked, whose holder is gone, are removed here, by the only new broker
  // that moves that file; one naming a running broker is that broker's and is kept.
  try {
    removeLeftoverParkedFiles(lockPath);
  } catch {
    // Best effort: a parked file is only clutter.
  }
  const held = () =>
    holdsGeneration() && readFileOrUndefined(lockPath) === record && !liveTakeoverToken(lockPath);
  // The single lock file earlier versions take, and then no broker of an earlier version still replacing one: a broker
  // holding a takeover token may yet move that file, so this one waits, holding both, until none does.
  for (;;) {
    if (readFileOrUndefined(lockPath) !== record && !createLockFile(lockPath, record)) {
      const holder = readFileOrUndefined(lockPath);
      if (holder !== undefined && isAbandoned(lockPath, holder)) replaceAbandonedLegacy(lockPath, holder, record);
      else await waiting();
      continue;
    }
    if (held()) break;
    await waiting();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeFileIfUnchanged(lockPath, record);
    if (!holdsGeneration()) return;
    // Its own generation is removed once the released one is in place, so a broker that idles out leaves one released
    // generation (#4727). That one stays: removed, numbering would start again, and a broker paused with a judgment of
    // an older generation could then take one that looks like the latest.
    if (createGeneration(lockPath, generation + 1, RELEASED)) {
      rmSync(generationPath(lockPath, generation), { recursive: true, force: true });
    }
  };
  return Object.assign(release, { held });
}
