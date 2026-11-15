import { randomUUID } from "crypto";
import { linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/** Locks and tokens get their pid as they are created, so one still unreadable after this was left by a crash. */
const UNREADABLE_FILE_GRACE_MS = 1_000;

/**
 * A parked file is renamed, read and removed at once, so one parked longer than this was left by a process that
 * crashed in between.
 */
export const PARKED_FILE_MAX_AGE_MS = 60_000;

/**
 * `${path}.<parked at, ms>.<uuid>.stale`, or `.new` for a lock being made: the time is in the name, since a rename
 * keeps the mtime.
 */
const PARKED_SUFFIX = /\.(\d+)\.[0-9a-f-]{36}\.(?:stale|new)$/;

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
 * Creates the lock or token file at `path` holding `content`; false when one is there already (#5220). It is written in
 * full under a name of its own and then linked into place, which fails while anything is at `path`, so it is never
 * seen empty: a file created and then written is empty in between, and an empty lock reads as one a crashed process
 * left, which another process would take over from a creator that then believes it holds the lock.
 */
export function createLockFile(path: string, content: string): boolean {
  const made = `${path}.${Date.now()}.${randomUUID()}.new`;
  writeFileSync(made, content, { flag: "wx" });
  let linked: boolean | undefined;
  try {
    linkSync(made, path);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") linked = false;
    // Any other failure is a file system without hard links (FAT, exFAT, some SMB shares): created below instead.
  } finally {
    removeFile(made);
  }
  return linked ?? createExclusively(path, content);
}

/**
 * Creates `path` holding `content` where no hard link can be made: created and then written, so a reader may see it
 * empty or partly written for a moment. Each record ends its lines with a newline, and readers judge a record whose
 * last line is unterminated, or that is empty, as still being written until {@link UNREADABLE_FILE_GRACE_MS} has passed.
 */
function createExclusively(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** `content` without a last line that is not yet terminated, as a record still being written ends. */
export function completeLines(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return content.slice(0, content.lastIndexOf("\n") + 1);
}

/**
 * Removes `path` only while it is still exactly the file its caller read as `inspected` and judged stale (undefined
 * when that file was unreadable). The file is first renamed to a unique name, which is atomic on POSIX and Windows, so
 * the content checked is the content removed. A file that replaced the inspected one meanwhile is put back, unless
 * another file has taken the path since. Returns whether the inspected file was removed.
 */
export function removeFileIfUnchanged(path: string, inspected: string | undefined): boolean {
  const parked = `${path}.${Date.now()}.${randomUUID()}.stale`;
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
 * When process `pid` started, where that can be read without `@bastani/atomic`, which the broker cannot load (#2208):
 * on Linux, the boot and the start time since boot from `/proc`. Undefined elsewhere or once the process is gone.
 */
export function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Fields after the command name, which may hold spaces and parentheses: the start time is the 22nd field.
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (started === undefined || !/^\d+$/.test(started) || boot === "") return undefined;
    return `${boot}/${started}`;
  } catch {
    return undefined;
  }
}

/** What a lock or token of this process records: its pid and, where it can be read, when it started. */
export function holderRecord(): string {
  return `${process.pid}\n${processStart(process.pid) ?? ""}\n`;
}

/**
 * A lock or token read as `content` was left by a crashed process once its pid is dead, or runs another process
 * that started at another time than the one it records (#5220), or once it stayed unreadable past the grace period. A
 * start that cannot be read now never makes a running pid another process, as for #5164.
 */
export function isAbandoned(path: string, written: string | undefined): boolean {
  const content = completeLines(written);
  const pid = pidOf(content);
  if (pid !== undefined) {
    if (!isProcessAlive(pid)) return true;
    const recorded = content?.split("\n")[1] ?? "";
    if (recorded === "") return false;
    const started = processStart(pid);
    return started !== undefined && started !== recorded;
  }
  return unreadableLongEnough(path);
}

/**
 * Whether the lock at `path`, which records no holder, is old enough to have been left by a crash: a lock is made
 * complete (see {@link createLockFile}), but one written by an earlier version may still be being written.
 */
export function unreadableLongEnough(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs >= UNREADABLE_FILE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Removes the files a crashed process parked beside `lockPath` while it removed that lock or its takeover token, or
 * left while making one: those whose content names a dead holder, and those parked longer than
 * {@link PARKED_FILE_MAX_AGE_MS}. A file another process parked or is making a moment ago for a live holder is left to
 * that process.
 */
function removeLeftoverParkedFiles(lockPath: string): void {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(directory)) {
    const parkedAt = name.startsWith(prefix) ? PARKED_SUFFIX.exec(name)?.[1] : undefined;
    if (parkedAt === undefined) continue;
    const path = join(directory, name);
    const pid = pidOf(readFileOrUndefined(path));
    const holderDead = pid !== undefined && !isProcessAlive(pid);
    if (holderDead || Date.now() - Number(parkedAt) > PARKED_FILE_MAX_AGE_MS) removeFile(path);
  }
}

/** The right to remove one stale lock, held by one process at a time. */
export interface LockTakeover {
  /** Whether this process still holds the takeover: checked just before the lock is moved. */
  owned(): boolean;
  release(): void;
}

/**
 * Takes the takeover of a lock through the file `token`: only the process that creates it holds the takeover, and a
 * token left by a crashed process is removed, so a later attempt can take over. Undefined while another process holds
 * it. For the broker, which cannot load the operating-system advisory lock of `@bastani/atomic` (#2208); a spawner
 * takes that one instead (#5220).
 */
export function takeTokenTakeover(token: string): LockTakeover | undefined {
  const content = holderRecord();
  if (!createLockFile(token, content)) {
    const holder = readFileOrUndefined(token);
    if (isAbandoned(token, holder)) removeFileIfUnchanged(token, holder);
    return undefined;
  }
  return {
    owned: () => readFileOrUndefined(token) === content,
    release: () => {
      removeFileIfUnchanged(token, content);
    },
  };
}

/**
 * Removes the stale lock at `lockPath`, read as `inspected`, unless another process is already replacing it (#5220).
 * The whole replacement runs while this process holds the takeover from `takeTakeover`: inside it, the lock is judged
 * again by `isStale` and must still be the one inspected, so two processes that saw one stale lock cannot both
 * replace it, and a lock written since is never removed. The lock is then moved aside and removed only when it is
 * still the inspected one; anything else is put back only while nothing is in its place, never replacing a lock. The
 * holder also removes the files crashed processes left parked.
 */
export function takeOverStaleLock(
  lockPath: string,
  inspected: string | undefined,
  isStale: (current: string | undefined) => boolean,
  takeTakeover: () => LockTakeover | undefined,
): void {
  const takeover = takeTakeover();
  if (takeover === undefined) return;
  try {
    removeLeftoverParkedFiles(lockPath);
    const current = readFileOrUndefined(lockPath);
    if (current !== inspected || !isStale(current) || !takeover.owned()) return;
    removeFileIfUnchanged(lockPath, inspected);
  } finally {
    takeover.release();
  }
}
