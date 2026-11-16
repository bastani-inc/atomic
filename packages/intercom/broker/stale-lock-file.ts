import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname } from "os";
import { basename, dirname, join } from "path";
import { renameWithRetry } from "./rename-retry.js";

/**
 * A parked file is renamed, read and removed at once, so one parked longer than this was left by a process that
 * crashed in between.
 */
export const PARKED_FILE_MAX_AGE_MS = 60_000;

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

export function createLockFile(path: string, content: string): boolean {
  const made = `${path}.${Date.now()}.${randomUUID()}.new`;
  writeFileSync(made, content, { flag: "wx" });
  let linked: boolean | undefined;
  try {
    linkSync(made, path);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") linked = false;
  } finally {
    removeFile(made);
  }
  return linked ?? createExclusively(path, content);
}

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
    renameWithRetry(marker, bound);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  removeFile(bound);
  return true;
}

function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.ino}-${stats.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

function writingMarkerPrefix(path: string): string {
  return `${path}.writing.`;
}

const WRITING_MARKER = /^(\d+)\.([^.]+)\.([^.]+)\.[0-9a-f]{8}(?:\.(\d+-\d+))?$/;

interface WritingMarker {
  readonly path: string;
  readonly pid: number | undefined;
  readonly state: HolderState;
  readonly file: string | undefined;
}

function writingMarkers(path: string): WritingMarker[] {
  const prefix = basename(writingMarkerPrefix(path));
  const found: WritingMarker[] = [];
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const parsed = WRITING_MARKER.exec(name.slice(prefix.length));
    const state = parsed === null ? "unknown" : processState(Number(parsed[1]), parsed[2] ?? "", parsed[3] ?? "", true);
    found.push({ path: join(dirname(path), name), pid: parsed === null ? undefined : Number(parsed[1]), state, file: parsed?.[4] });
  }
  return found;
}

export function removeDeadWritingMarkers(path: string): void {
  const file = fileIdentity(path);
  for (const marker of writingMarkers(path)) {
    if (marker.state === "abandoned" && (marker.file === undefined || marker.file === file)) removeFile(marker.path);
  }
}

let ownHost: string | undefined;

export function hostIdentity(): string {
  if (ownHost === undefined) {
    let source = `host:${hostname()}`;
    if (process.platform === "linux") {
      try {
        const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
        source = `linux:${boot}:${readlinkSync("/proc/self/ns/pid")}`;
      } catch {
      }
    }
    ownHost = createHash("sha256").update(source).digest("hex").slice(0, 12);
  }
  return ownHost;
}

export function ownIdentity(): string {
  const start = processStart(process.pid);
  const token = start === undefined ? "x" : createHash("sha256").update(start).digest("hex").slice(0, 12);
  return `${process.pid}.${token}.${hostIdentity()}`;
}

export function completeLines(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  return content.slice(0, content.lastIndexOf("\n") + 1);
}

const warnedParked = new Set<string>();

export function removeFileIfUnchanged(path: string, inspected: string | undefined): boolean {
  const parked = `${path}.${Date.now()}.${randomUUID()}.stale`;
  try {
    renameWithRetry(path, parked);
  } catch {
    return false;
  }
  const moved = readFileOrUndefined(parked);
  if (moved === inspected) {
    removeFile(parked);
    unknownSince.delete(path);
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

export function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (started === undefined || !/^\d+$/.test(started) || boot === "") return undefined;
    return `${boot}/${started}`;
  } catch {
    return undefined;
  }
}

export function holderRecord(): string {
  return `${process.pid}\n${processStart(process.pid) ?? ""}\n${hostIdentity()}\n`;
}

export type HolderState = "held" | "abandoned" | "unknown";

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

export function isAbandoned(path: string, written: string | undefined): boolean {
  return holderState(path, written) === "abandoned";
}

function pendingWritingMarkers(path: string, written: string | undefined, file: string | undefined): WritingMarker[] {
  const lines = (written ?? "").split("\n");
  const complete = written?.endsWith("\n") === true && (lines.length >= 4 || /^\d+$/.test(lines[1] ?? ""));
  const recorded = pidOf(completeLines(written));
  return writingMarkers(path).filter((marker) =>
    marker.file === undefined
      ? written === ""
      : marker.file === file && !(complete && recorded !== undefined && marker.pid === recorded),
  );
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function writerState(path: string, written: string | undefined): HolderState | undefined {
  let file: string;
  try {
    const stats = statSync(path, { bigint: true });
    file = `${stats.ino}-${stats.birthtimeNs}`;
  } catch (error) {
    return isAbsent(error) ? "held" : "unknown";
  }
  if (written === undefined) return "unknown";
  let markers: WritingMarker[];
  try {
    markers = pendingWritingMarkers(path, written, file);
  } catch (error) {
    return isAbsent(error) ? "held" : "unknown";
  }
  if (markers.length === 0) return undefined;
  if (markers.some((marker) => marker.state === "held")) return "held";
  if (markers.some((marker) => marker.state === "unknown")) return "unknown";
  const bound = markers.filter((marker) => marker.file === file);
  if (bound.length === 0) return undefined;
  if (readFileOrUndefined(path) !== written || fileIdentity(path) !== file) return "held";
  const recorded = pidOf(completeLines(written));
  if (recorded === undefined || isProcessAlive(recorded)) return undefined;
  return "abandoned";
}

let unknownHolderWaitMs = 30_000;

export function setUnknownHolderWaitForTesting(ms: number | undefined): void {
  unknownHolderWaitMs = ms ?? 30_000;
  unknownSince.clear();
}

interface UnknownHolderWait {
  readonly written: string | undefined;
  readonly identity: string | undefined;
  readonly since: number;
}

const unknownSince = new Map<string, UnknownHolderWait>();

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function unknownHolderAdvice(path: string): string {
  const file = fileIdentity(path);
  const written = readFileOrUndefined(path);
  let markers: WritingMarker[] = [];
  try {
    markers = pendingWritingMarkers(path, written, file);
  } catch {}
  const blockingMarkers = markers.filter((marker) => marker.state === "unknown");
  const recoveryFiles = [...blockingMarkers.map((marker) => marker.path), path];
  const recoveryPaths = recoveryFiles.join(" and ");
  const ownershipPaths = recoveryFiles.map((name) => JSON.stringify(name)).join(" ");
  const chownCommand = isDirectory(path) ? "sudo chown -R $USER" : "sudo chown $USER";
  const why =
    written === undefined
      ? "this user cannot read it, as when another user (for example `sudo atomic`) created it"
      : blockingMarkers.length > 0 || recordsForeignHolder(path)
        ? "it names a process on another host or in another container sharing this agent directory, which cannot be checked from here"
        : markers.some((marker) => marker.state === "abandoned")
          ? "it may have been left empty by a process killed before recording its holder"
          : "it was left empty or part-written by an earlier version of Atomic, which does not record its writer";
  return `The lock ${path} is held by a process this one cannot check: ${why} (#5220). If no such process is using it, remove ${recoveryPaths}, or, if another user (as \`sudo atomic\`) left it, give it to your user (for example \`${chownCommand} ${ownershipPaths}\`).`;
}

function recordsForeignHolder(path: string): boolean {
  const host = (completeLines(readFileOrUndefined(path)) ?? "").split("\n")[2] ?? "";
  return host !== "" && host !== hostIdentity();
}

export function unknownHolderWaitedOut(path: string, written: string | undefined): boolean {
  const identity = fileIdentity(path);
  const current = unknownSince.get(path);
  if (current === undefined || current.written !== written || current.identity !== identity) {
    unknownSince.set(path, { written, identity, since: Date.now() });
    return false;
  }
  return Date.now() - current.since >= unknownHolderWaitMs;
}

export function removeLeftoverParkedFiles(lockPath: string): void {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(directory)) {
    if (name.startsWith(`${prefix}writing.`) || name.includes(".writing.")) continue;
    const parkedAt = name.startsWith(prefix) ? PARKED_SUFFIX.exec(name)?.[1] : undefined;
    if (parkedAt === undefined) continue;
    const path = join(directory, name);
    const pid = pidOf(readFileOrUndefined(path));
    const leftover = pid === undefined ? Date.now() - Number(parkedAt) > PARKED_FILE_MAX_AGE_MS : !isProcessAlive(pid);
    if (leftover) removeFile(path);
  }
}

export interface LockTakeover {
  owned(): boolean;
  release(): void;
}

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
    removeDeadWritingMarkers(lockPath);
    removeFileIfUnchanged(lockPath, inspected);
  } finally {
    takeover.release();
  }
}
