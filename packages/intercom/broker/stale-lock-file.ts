import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname } from "os";
import { basename, dirname, join } from "path";

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
 * empty or partly written for a moment (#5220). First, before the file exists, this writer creates a marker beside it
 * whose name holds its identity and a nonce (see {@link writingMarkerPrefix}); once it has created the file, it binds
 * the marker to that file by adding the file's identity to the marker's name. A reader judges a record that is not
 * complete by the markers bound to it, by their writers' identity, never by time or a scan of open files; and while a
 * marker is not yet bound, its writer may be the creator of any file there, so a live one keeps the record. The marker
 * is removed once the record is complete, or at once when the file exists already.
 */
function createExclusively(path: string, content: string): boolean {
  const marker = `${writingMarkerPrefix(path)}${ownIdentity()}.${randomUUID().slice(0, 8)}`;
  writeFileSync(marker, "");
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    removeFile(marker);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  let bound = marker;
  try {
    const stats = fstatSync(fd, { bigint: true });
    bound = `${marker}.${stats.ino}-${stats.birthtimeNs}`;
    renameSync(marker, bound);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  // Left behind when this process is killed meanwhile, it names a dead writer, and the next takeover removes it.
  removeFile(bound);
  return true;
}

/**
 * The identity of the file at `path`: its inode (file index on Windows) and when it was created, so a file given the
 * inode of a removed one is still another file.
 */
function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.ino}-${stats.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

/**
 * The prefix of the markers of writers of the record at `path`: `<path>.writing.`, then `<pid>.<start>.<host>.<nonce>`,
 * and, once the writer has created the file, `.<file identity>`.
 */
function writingMarkerPrefix(path: string): string {
  return `${path}.writing.`;
}

/** A writing marker's name after {@link writingMarkerPrefix}: its writer's pid, start and host, and its file if bound. */
const WRITING_MARKER = /^(\d+)\.([^.]+)\.([^.]+)\.[0-9a-f]{8}(?:\.(\d+-\d+))?$/;

interface WritingMarker {
  readonly path: string;
  readonly state: HolderState;
  /** The identity of the file its writer created, once bound. */
  readonly file: string | undefined;
}

/** The writing markers of the record at `path`. */
function writingMarkers(path: string): WritingMarker[] {
  const prefix = basename(writingMarkerPrefix(path));
  const found: WritingMarker[] = [];
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const parsed = WRITING_MARKER.exec(name.slice(prefix.length));
    const state = parsed === null ? "unknown" : processState(Number(parsed[1]), parsed[2] ?? "", parsed[3] ?? "", true);
    found.push({ path: join(dirname(path), name), state, file: parsed?.[4] });
  }
  return found;
}

/**
 * Removes the markers of writers of the record at `path` that are gone, which only a process holding the takeover of
 * that record does, before it removes the record: a marker left behind could otherwise be taken for the writer of a
 * record made later at the same path.
 */
export function removeDeadWritingMarkers(path: string): void {
  const file = fileIdentity(path);
  for (const marker of writingMarkers(path)) {
    // Bound to the record being taken over, or never bound: its writer is gone, and it holds nothing.
    if (marker.state === "abandoned" && (marker.file === undefined || marker.file === file)) removeFile(marker.path);
  }
}

let ownHost: string | undefined;

/**
 * What tells this host, and on Linux this pid namespace, apart from another sharing the agent directory, such as a
 * container or another machine: a pid recorded elsewhere cannot be checked here.
 */
export function hostIdentity(): string {
  if (ownHost === undefined) {
    let source = `host:${hostname()}`;
    if (process.platform === "linux") {
      try {
        const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
        source = `linux:${boot}:${readlinkSync("/proc/self/ns/pid")}`;
      } catch {
        // No /proc: the host name stands for the host.
      }
    }
    ownHost = createHash("sha256").update(source).digest("hex").slice(0, 12);
  }
  return ownHost;
}

/** This process as an intent marker names it: `<pid>.<start or x>.<host>`. */
export function ownIdentity(): string {
  const start = processStart(process.pid);
  const token = start === undefined ? "x" : createHash("sha256").update(start).digest("hex").slice(0, 12);
  return `${process.pid}.${token}.${hostIdentity()}`;
}

/** `content` without a last line that is not yet terminated, as a record still being written ends. */
export function completeLines(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return content.slice(0, content.lastIndexOf("\n") + 1);
}

const warnedParked = new Set<string>();

/**
 * Removes `path` only while it is still exactly the file its caller read as `inspected` and judged stale (undefined
 * when that file was unreadable). The file is first renamed to a unique name, which is atomic on POSIX and Windows, so
 * the content checked is the content removed. A file that replaced the inspected one meanwhile is not this caller's to
 * remove (#5220): it is put back only while nothing is in its place (see {@link putBack}), and otherwise left parked
 * beside the lock with a warning, never removed. Its holder finds its
 * lock gone at its next check and stops acting as its holder. Returns whether the inspected file was removed.
 */
export function removeFileIfUnchanged(path: string, inspected: string | undefined): boolean {
  const parked = `${path}.${Date.now()}.${randomUUID()}.stale`;
  try {
    renameSync(path, parked);
  } catch {
    return false;
  }
  const moved = readFileOrUndefined(parked);
  if (moved === inspected) {
    removeFile(parked);
    return true;
  }
  if (putBack(parked, path, moved)) {
    removeFile(parked);
  } else {
    if (!warnedParked.has(path)) {
      warnedParked.add(path);
      process.emitWarning(
        `A lock that replaced the stale ${path} while it was being removed could not be put back and is left as ${parked} (#5220).`,
      );
    }
  }
  return false;
}

/**
 * Puts the lock moved to `parked`, read as `moved`, back at `path` only while nothing is there, never replacing a lock
 * (#5220): linked back, or, where no hard link can be made (FAT, some SMB shares), made again with the same record
 * through the same exclusive create as any lock, which its holder, who knows its lock by its record, still finds its own.
 */
function putBack(parked: string, path: string, moved: string | undefined): boolean {
  try {
    linkSync(parked, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || moved === undefined) return false;
  }
  try {
    return createExclusively(path, moved);
  } catch {
    return false;
  }
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

/** What a lock or token of this process records: its pid, when it started where that can be read, and its host. */
export function holderRecord(): string {
  return `${process.pid}\n${processStart(process.pid) ?? ""}\n${hostIdentity()}\n`;
}

/**
 * How a lock or record read as `written` is held: by a process that still runs, by one that is gone (`abandoned`), or
 * by one this process cannot check (`unknown`): on another host or in another pid namespace, or, for a record that names
 * no holder and has no intent marker (see {@link createExclusively}), written by an earlier version or another user.
 */
export type HolderState = "held" | "abandoned" | "unknown";

/** Whether the process named `pid`, recorded with start `start` and host `host`, still runs, as far as can be told. */
export function processState(pid: number, start: string, host: string, hashedStart: boolean): HolderState {
  if (host !== "" && host !== hostIdentity()) return "unknown";
  if (!isProcessAlive(pid)) return "abandoned";
  if (start === "" || start === "x") return "held";
  const started = processStart(pid);
  if (started === undefined) return "held";
  const now = hashedStart ? createHash("sha256").update(started).digest("hex").slice(0, 12) : started;
  return now === start ? "held" : "abandoned";
}

export function holderState(path: string, written: string | undefined): HolderState {
  const writer = writerState(path, written);
  if (writer === "held" || writer === "unknown") return writer;
  const content = completeLines(written);
  const pid = pidOf(content);
  if (pid !== undefined) {
    const [, start = "", host = ""] = (content ?? "").split("\n");
    return processState(pid, start, host, false);
  }
  return writer ?? "unknown";
}

/** Whether a lock or token read as `written` was left by a process that is gone. */
export function isAbandoned(path: string, written: string | undefined): boolean {
  return holderState(path, written) === "abandoned";
}

export function writerState(path: string, written: string | undefined): HolderState | undefined {
  const file = fileIdentity(path);
  if (written === undefined || file === undefined) return "held";
  let markers: WritingMarker[];
  try {
    markers = writingMarkers(path).filter((marker) => marker.file === undefined || marker.file === file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "held";
    throw error;
  }
  if (markers.length === 0) return undefined;
  if (markers.some((marker) => marker.state === "held")) return "held";
  if (markers.some((marker) => marker.state === "unknown")) return "unknown";
  const bound = markers.filter((marker) => marker.file === file);
  if (bound.length === 0) return undefined;
  // Its writer is gone: abandoned while it is still exactly as read.
  return readFileOrUndefined(path) === written && fileIdentity(path) === file ? "abandoned" : "held";
}

/** Whether the lock at `path`, read as `written` and recording no holder, was left by a writer that is gone. */
export function writerGone(path: string, written: string | undefined): boolean {
  return writerState(path, written) === "abandoned";
}

/** How long a holder that cannot be checked is waited on before it is refused with a warning. */
let unknownHolderWaitMs = 30_000;

/** Shortens the wait on a holder that cannot be checked, for a test. */
export function setUnknownHolderWaitForTesting(ms: number | undefined): void {
  unknownHolderWaitMs = ms ?? 30_000;
  unknownSince.clear();
}

const unknownSince = new Map<string, number>();

/** What to do about a lock whose holder cannot be checked, naming why it cannot be: remove it, or give it to this user. */
export function unknownHolderAdvice(path: string): string {
  const markers = writingMarkers(path);
  const why =
    markers.some((marker) => marker.state === "unknown") || recordsForeignHolder(path)
      ? "it names a process on another host or in another container sharing this agent directory, which cannot be checked from here"
      : markers.some((marker) => marker.file === undefined && marker.state === "abandoned")
        ? "it was left empty by a process killed just after creating it, before it recorded that the file was its own"
        : "it was left empty or part-written by an earlier version of Atomic, which does not record its writer";
  return `The lock ${path} is held by a process this one cannot check: ${why} (#5220). If no such process is using it, remove ${path}, or, if another user (as \`sudo atomic\`) left it, give it to your user (for example \`sudo chown $USER ${path}\`).`;
}

/** Whether the record at `path` names a holder on another host or in another pid namespace. */
function recordsForeignHolder(path: string): boolean {
  const host = (completeLines(readFileOrUndefined(path)) ?? "").split("\n")[2] ?? "";
  return host !== "" && host !== hostIdentity();
}

/**
 * Records that the lock at `path`, read as `written`, has a holder this process cannot check; true once it has been
 * waited on for the bound, when the caller refuses it. A holder that changes starts the wait again.
 */
export function unknownHolderWaitedOut(path: string, written: string | undefined): boolean {
  const key = `${path}\0${written ?? ""}`;
  const since = unknownSince.get(key);
  if (since === undefined) {
    unknownSince.set(key, Date.now());
    return false;
  }
  return Date.now() - since >= unknownHolderWaitMs;
}

/**
 * Removes the files a crashed process parked beside `lockPath` while it removed that lock or its takeover token, or
 * left while making one: those whose content names a dead holder, and those that name none once parked longer than
 * {@link PARKED_FILE_MAX_AGE_MS}. A file that names a live holder is left, however old (#5220).
 */
export function removeLeftoverParkedFiles(lockPath: string): void {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(directory)) {
    // Writing markers are removed only by the takeover of their record (removeDeadWritingMarkers), never here.
    if (name.startsWith(`${prefix}writing.`) || name.includes(".writing.")) continue;
    const parkedAt = name.startsWith(prefix) ? PARKED_SUFFIX.exec(name)?.[1] : undefined;
    if (parkedAt === undefined) continue;
    const path = join(directory, name);
    const pid = pidOf(readFileOrUndefined(path));
    // A parked lock of a process that still runs is kept, however old: it is that process's, never another's to remove.
    const leftover = pid === undefined ? Date.now() - Number(parkedAt) > PARKED_FILE_MAX_AGE_MS : !isProcessAlive(pid);
    if (leftover) removeFile(path);
  }
}

/** The right to remove one stale lock, held by one process at a time. */
export interface LockTakeover {
  /** Whether this process still holds the takeover: checked just before the lock is moved. */
  owned(): boolean;
  release(): void;
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
    // The dead writers' markers go first: killed in between, this leaves a record without a marker, which is refused
    // rather than taken, never a marker that a later record could be taken for.
    removeDeadWritingMarkers(lockPath);
    removeFileIfUnchanged(lockPath, inspected);
  } finally {
    takeover.release();
  }
}
