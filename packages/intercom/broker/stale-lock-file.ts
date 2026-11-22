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
import {
  type FileHandle,
  link,
  open,
  readdir,
  readFile,
  readlink,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "os";
import { basename, dirname, join } from "path";
import { renameWithRetry, renameWithRetryAsync } from "./rename-retry.js";
import { processCreationTimeOf } from "./start-announcement.js";

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

export async function readFileOrUndefinedAsync(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
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

async function removeFileAsync(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
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

export async function createLockFileAsync(path: string, content: string): Promise<boolean> {
  const made = `${path}.${Date.now()}.${randomUUID()}.new`;
  await writeFile(made, content, { flag: "wx" });
  let linked: boolean | undefined;
  try {
    await link(made, path);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") linked = false;
  } finally {
    await removeFileAsync(made);
  }
  return linked ?? createExclusivelyAsync(path, content);
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

async function createExclusivelyAsync(path: string, content: string): Promise<boolean> {
  const marker = `${writingMarkerPrefix(path)}${await ownIdentityAsync()}.${randomUUID().slice(0, 8)}`;
  await writeFile(marker, "");
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    await removeFileAsync(marker);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  let bound = marker;
  try {
    const stats = await handle.stat({ bigint: true });
    bound = `${marker}.${stats.ino}-${stats.birthtimeNs}`;
    await renameWithRetryAsync(marker, bound);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  await removeFileAsync(bound);
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

async function fileIdentityAsync(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path, { bigint: true });
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

async function writingMarkersAsync(path: string): Promise<WritingMarker[]> {
  const prefix = basename(writingMarkerPrefix(path));
  const found: WritingMarker[] = [];
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const parsed = WRITING_MARKER.exec(name.slice(prefix.length));
    const state =
      parsed === null ? "unknown" : await processStateAsync(Number(parsed[1]), parsed[2] ?? "", parsed[3] ?? "", true);
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

export async function removeDeadWritingMarkersAsync(path: string): Promise<void> {
  const file = await fileIdentityAsync(path);
  for (const marker of await writingMarkersAsync(path)) {
    if (marker.state === "abandoned" && (marker.file === undefined || marker.file === file)) {
      await removeFileAsync(marker.path);
    }
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

export async function hostIdentityAsync(): Promise<string> {
  if (ownHost === undefined) {
    let source = `host:${hostname()}`;
    if (process.platform === "linux") {
      try {
        const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
        source = `linux:${boot}:${await readlink("/proc/self/ns/pid")}`;
      } catch {}
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

export async function ownIdentityAsync(): Promise<string> {
  const start = await processStartAsync(process.pid);
  const token = start === undefined ? "x" : createHash("sha256").update(start).digest("hex").slice(0, 12);
  return `${process.pid}.${token}.${await hostIdentityAsync()}`;
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

export async function removeFileIfUnchangedAsync(path: string, inspected: string | undefined): Promise<boolean> {
  const parked = `${path}.${Date.now()}.${randomUUID()}.stale`;
  try {
    await renameWithRetryAsync(path, parked);
  } catch {
    return false;
  }
  const moved = await readFileOrUndefinedAsync(parked);
  if (moved === inspected) {
    await removeFileAsync(parked);
    unknownSince.delete(path);
    return true;
  }
  if (await putBackAsync(parked, path, moved)) {
    await removeFileAsync(parked);
  } else if (!warnedParked.has(path)) {
    warnedParked.add(path);
    process.emitWarning(
      `A lock that replaced the stale ${path} while it was being removed could not be put back and is left as ${parked} (#5220).`,
    );
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

async function putBackAsync(parked: string, path: string, moved: string | undefined): Promise<boolean> {
  try {
    await link(parked, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || moved === undefined) return false;
  }
  try {
    return await createExclusivelyAsync(path, moved);
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
 * When process `pid` started, as a lock records its holder: its `/proc` start on Linux, its creation time on Windows,
 * which gives the pid of an exited process to another within seconds, so a pid alone names a holder only while it runs,
 * and its start on macOS, both read by the native module (`processCreationTimeOf`). Undefined elsewhere, or where it
 * cannot be read, so the holder's pid decides alone. Holders of earlier versions record none on Windows and macOS, and
 * earlier versions read none there, so either judges the other by its pid, as before.
 */
export function processStart(pid: number): string | undefined {
  if (process.platform === "win32" || process.platform === "darwin") return processCreationTimeOf(pid);
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

export async function processStartAsync(pid: number): Promise<string | undefined> {
  if (process.platform === "win32" || process.platform === "darwin") return processCreationTimeOf(pid);
  if (process.platform !== "linux") return undefined;
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf-8");
    const started = statText.slice(statText.lastIndexOf(")") + 2).split(" ")[19];
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim();
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

export async function processStateAsync(
  pid: number,
  start: string,
  host: string,
  hashedStart: boolean,
): Promise<HolderState> {
  if (host !== "" && host !== (await hostIdentityAsync())) return "unknown";
  if (!isProcessAlive(pid)) return "abandoned";
  if (start === "" || start === "x") return "held";
  const started = await processStartAsync(pid);
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

function filterPendingWritingMarkers(
  markers: WritingMarker[],
  written: string | undefined,
  file: string | undefined,
): WritingMarker[] {
  const lines = (written ?? "").split("\n");
  const complete = written?.endsWith("\n") === true && (lines.length >= 4 || /^\d+$/.test(lines[1] ?? ""));
  const recorded = pidOf(completeLines(written));
  return markers.filter((marker) =>
    marker.file === undefined
      ? written === ""
      : marker.file === file && !(complete && recorded !== undefined && marker.pid === recorded),
  );
}

function pendingWritingMarkers(path: string, written: string | undefined, file: string | undefined): WritingMarker[] {
  return filterPendingWritingMarkers(writingMarkers(path), written, file);
}

async function pendingWritingMarkersAsync(
  path: string,
  written: string | undefined,
  file: string | undefined,
): Promise<WritingMarker[]> {
  return filterPendingWritingMarkers(await writingMarkersAsync(path), written, file);
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

export async function writerStateAsync(path: string, written: string | undefined): Promise<HolderState | undefined> {
  let file: string;
  try {
    const stats = await stat(path, { bigint: true });
    file = `${stats.ino}-${stats.birthtimeNs}`;
  } catch (error) {
    return isAbsent(error) ? "held" : "unknown";
  }
  if (written === undefined) return "unknown";
  let markers: WritingMarker[];
  try {
    markers = await pendingWritingMarkersAsync(path, written, file);
  } catch (error) {
    return isAbsent(error) ? "held" : "unknown";
  }
  if (markers.length === 0) return undefined;
  if (markers.some((marker) => marker.state === "held")) return "held";
  if (markers.some((marker) => marker.state === "unknown")) return "unknown";
  const bound = markers.filter((marker) => marker.file === file);
  if (bound.length === 0) return undefined;
  if ((await readFileOrUndefinedAsync(path)) !== written || (await fileIdentityAsync(path)) !== file) return "held";
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
  readonly identity: string;
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

async function isDirectoryAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function formatUnknownHolderAdvice(
  path: string,
  written: string | undefined,
  markers: WritingMarker[],
  directory: boolean,
  foreignHolder: boolean,
): string {
  const blockingMarkers = markers.filter((marker) => marker.state === "unknown");
  const recoveryFiles = [...blockingMarkers.map((marker) => marker.path), path];
  const recoveryPaths = recoveryFiles.join(" and ");
  const ownershipPaths = recoveryFiles.map((name) => JSON.stringify(name)).join(" ");
  const chownCommand = directory ? "sudo chown -R $USER" : "sudo chown $USER";
  const why =
    written === undefined
      ? "this user cannot read it, as when another user (for example `sudo atomic`) created it"
      : blockingMarkers.length > 0 || foreignHolder
        ? "it names a process on another host or in another container sharing this agent directory, which cannot be checked from here"
        : markers.some((marker) => marker.state === "abandoned")
          ? "it may have been left empty by a process killed before recording its holder"
          : "it was left empty or part-written by an earlier version of Atomic, which does not record its writer";
  return `The lock ${path} is held by a process this one cannot check: ${why} (#5220). If no such process is using it, remove ${recoveryPaths}, or, if another user (as \`sudo atomic\`) left it, give it to your user (for example \`${chownCommand} ${ownershipPaths}\`).`;
}

export function unknownHolderAdvice(path: string): string {
  const file = fileIdentity(path);
  const written = readFileOrUndefined(path);
  let markers: WritingMarker[] = [];
  try {
    markers = pendingWritingMarkers(path, written, file);
  } catch {}
  return formatUnknownHolderAdvice(path, written, markers, isDirectory(path), recordsForeignHolder(path));
}

export async function unknownHolderAdviceAsync(path: string): Promise<string> {
  const file = await fileIdentityAsync(path);
  const written = await readFileOrUndefinedAsync(path);
  let markers: WritingMarker[] = [];
  try {
    markers = await pendingWritingMarkersAsync(path, written, file);
  } catch {}
  return formatUnknownHolderAdvice(
    path,
    written,
    markers,
    await isDirectoryAsync(path),
    await recordsForeignHolderAsync(path),
  );
}

function recordsForeignHolder(path: string): boolean {
  const host = (completeLines(readFileOrUndefined(path)) ?? "").split("\n")[2] ?? "";
  return host !== "" && host !== hostIdentity();
}

async function recordsForeignHolderAsync(path: string): Promise<boolean> {
  const host = (completeLines(await readFileOrUndefinedAsync(path)) ?? "").split("\n")[2] ?? "";
  return host !== "" && host !== (await hostIdentityAsync());
}

function checkUnknownHolderWait(path: string, written: string | undefined, identity: string | undefined): boolean {
  if (identity === undefined) {
    unknownSince.delete(path);
    return false;
  }
  const current = unknownSince.get(path);
  if (current === undefined || current.written !== written || current.identity !== identity) {
    unknownSince.set(path, { written, identity, since: Date.now() });
    return false;
  }
  return Date.now() - current.since >= unknownHolderWaitMs;
}

export function unknownHolderWaitedOut(path: string, written: string | undefined): boolean {
  return checkUnknownHolderWait(path, written, fileIdentity(path));
}

export async function unknownHolderWaitedOutAsync(path: string, written: string | undefined): Promise<boolean> {
  return checkUnknownHolderWait(path, written, await fileIdentityAsync(path));
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

export async function removeLeftoverParkedFilesAsync(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  for (const name of await readdir(directory)) {
    if (name.startsWith(`${prefix}writing.`) || name.includes(".writing.")) continue;
    const parkedAt = name.startsWith(prefix) ? PARKED_SUFFIX.exec(name)?.[1] : undefined;
    if (parkedAt === undefined) continue;
    const path = join(directory, name);
    const pid = pidOf(await readFileOrUndefinedAsync(path));
    const leftover = pid === undefined ? Date.now() - Number(parkedAt) > PARKED_FILE_MAX_AGE_MS : !isProcessAlive(pid);
    if (leftover) await removeFileAsync(path);
  }
}

export interface LockTakeover {
  owned(): boolean;
  release(): void;
}

export interface AsyncLockTakeover {
  owned(): boolean | Promise<boolean>;
  release(): void | Promise<void>;
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

export async function takeOverStaleLockAsync(
  lockPath: string,
  inspected: string | undefined,
  isStale: (current: string | undefined) => boolean | Promise<boolean>,
  takeTakeover: () => AsyncLockTakeover | undefined | Promise<AsyncLockTakeover | undefined>,
): Promise<void> {
  const takeover = await takeTakeover();
  if (takeover === undefined) return;
  try {
    await removeLeftoverParkedFilesAsync(lockPath);
    const current = await readFileOrUndefinedAsync(lockPath);
    if (current !== inspected || !(await isStale(current)) || !(await takeover.owned())) return;
    await removeDeadWritingMarkersAsync(lockPath);
    await removeFileIfUnchangedAsync(lockPath, inspected);
  } finally {
    await takeover.release();
  }
}
