import { randomUUID } from "crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { renameWithRetry } from "./rename-retry.js";
import {
  createLockFile,
  type HolderState,
  holderRecord,
  holderState,
  isAbandoned,
  ownIdentity,
  pidOf,
  processState,
  readFileOrUndefined,
  removeDeadWritingMarkers,
  removeFileIfUnchanged,
  removeLeftoverParkedFiles,
  unknownHolderAdvice,
  unknownHolderWaitedOut,
} from "./stale-lock-file.js";

const SOCKET_REPLACEMENT_LOCK_POLL_MS = 20;

const RELEASED = "released\n";

export interface SocketReplacementLockOptions {
  readonly onWait?: () => void;
}

export interface SocketReplacementLock {
  (): void;
  held(): boolean;
}

export class SocketLockHolderUnknownError extends Error {
  override readonly name = "SocketLockHolderUnknownError";
}

function refuse(path: string): never {
  throw new SocketLockHolderUnknownError(unknownHolderAdvice(path));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generationPath(lockPath: string, generation: number): string {
  return `${lockPath}.gen${generation}`;
}

function generationRecord(lockPath: string, generation: number): string | undefined {
  return readFileOrUndefined(join(generationPath(lockPath, generation), "owner"));
}

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

function stagingPrefix(lockPath: string): string {
  return `${basename(lockPath)}.staging-`;
}

function createGeneration(lockPath: string, generation: number, record: string): boolean {
  const staging = join(dirname(lockPath), `${stagingPrefix(lockPath)}${ownIdentity()}-${randomUUID()}`);
  try {
    mkdirSync(staging);
    writeFileSync(join(staging, "owner"), record);
    renameWithRetry(staging, generationPath(lockPath, generation));
    return true;
  } catch {
    removeDirectory(staging);
    return false;
  }
}

function removeDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

function trashPrefix(lockPath: string): string {
  return `${basename(lockPath)}.trash-`;
}

function removeGeneration(lockPath: string, generation: number): void {
  const trash = join(dirname(lockPath), `${trashPrefix(lockPath)}${randomUUID()}`);
  try {
    renameWithRetry(generationPath(lockPath, generation), trash);
  } catch {
    return;
  }
  removeDirectory(trash);
}

function generationState(path: string, record: string | undefined): HolderState {
  return record === RELEASED ? "abandoned" : holderState(path, record);
}

function removeLeftovers(lockPath: string, generation: number): void {
  for (const older of generations(lockPath)) if (older < generation) removeGeneration(lockPath, older);
  const staging = stagingPrefix(lockPath);
  const trash = trashPrefix(lockPath);
  for (const name of readdirSync(dirname(lockPath))) {
    if (name.startsWith(trash)) removeDirectory(join(dirname(lockPath), name));
    if (!name.startsWith(staging)) continue;
    const [pid = "", start = "", host = ""] = name.slice(staging.length).split("-")[0]?.split(".") ?? [];
    const parsed = Number.parseInt(pid, 10);
    if (Number.isFinite(parsed) && processState(parsed, start, host, true) === "abandoned") {
      removeDirectory(join(dirname(lockPath), name));
    }
  }
}

function takeoverTokens(lockPath: string): string[] {
  const token = new RegExp(`^${basename(lockPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.takeover-[^.]+$`);
  return readdirSync(dirname(lockPath))
    .filter((name) => token.test(name))
    .map((name) => join(dirname(lockPath), name));
}

function liveTakeoverToken(lockPath: string, own: string): readonly [string, string | undefined, HolderState] | undefined {
  for (const token of takeoverTokens(lockPath)) {
    const content = readFileOrUndefined(token);
    if (content === own) {
      removeFileIfUnchanged(token, own);
      continue;
    }
    const state = holderState(token, content);
    if (state !== "abandoned") return [token, content, state];
  }
  return undefined;
}

function takeoverTokenPath(lockPath: string, holder: string): string {
  return `${lockPath}.takeover-${pidOf(holder) ?? "unreadable"}`;
}

function replaceAbandonedLegacy(lockPath: string, holder: string, record: string): boolean {
  const token = takeoverTokenPath(lockPath, holder);
  if (!createLockFile(token, record)) {
    const tokenHolder = readFileOrUndefined(token);
    if (tokenHolder !== record) {
      if (tokenHolder !== undefined && isAbandoned(token, tokenHolder)) {
        removeDeadWritingMarkers(token);
        return removeFileIfUnchanged(token, tokenHolder);
      }
      return false;
    }
  }
  try {
    if (readFileOrUndefined(token) !== record || readFileOrUndefined(lockPath) !== holder) return false;
    if (!isAbandoned(lockPath, holder)) return false;
    removeDeadWritingMarkers(lockPath);
    return removeFileIfUnchanged(lockPath, holder);
  } finally {
    removeFileIfUnchanged(token, record);
  }
}

/**
 * The latest generation of the socket lock at `lockPath` (taken, or released by its last holder); undefined before any.
 * Every broker that starts, of this version or an earlier one, takes the next one and leaves the one after it released.
 */
export function latestSocketReplacementGeneration(lockPath: string): number | undefined {
  try {
    return generations(lockPath)[0];
  } catch {
    return undefined;
  }
}

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
      const owner =
        content === undefined ? generationPath(lockPath, latest) : join(generationPath(lockPath, latest), "owner");
      const state = generationState(owner, content);
      if (content === undefined && state === "held") {
        await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
        continue;
      }
      if (state !== "abandoned") {
        if (state === "unknown" && unknownHolderWaitedOut(owner, content)) refuse(owner);
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
      removeGeneration(lockPath, next);
    }
    await sleep(SOCKET_REPLACEMENT_LOCK_POLL_MS);
  }
  removeLeftovers(lockPath, generation);
  const holdsGeneration = () =>
    generations(lockPath)[0] === generation && generationRecord(lockPath, generation) === record;

  try {
    removeLeftoverParkedFiles(lockPath);
  } catch {}
  const held = () =>
    holdsGeneration() && readFileOrUndefined(lockPath) === record && liveTakeoverToken(lockPath, record) === undefined;
  for (;;) {
    if (readFileOrUndefined(lockPath) !== record && !createLockFile(lockPath, record)) {
      const holder = readFileOrUndefined(lockPath);
      const state = holderState(lockPath, holder);
      if (holder !== undefined && state === "abandoned") {
        if (replaceAbandonedLegacy(lockPath, holder, record)) continue;
        const token = takeoverTokenPath(lockPath, holder);
        const tokenHolder = readFileOrUndefined(token);
        const tokenState = holderState(token, tokenHolder);
        if (tokenState === "unknown" && unknownHolderWaitedOut(token, tokenHolder)) refuse(token);
        await waiting();
        continue;
      }
      if (state === "unknown" && unknownHolderWaitedOut(lockPath, holder)) refuse(lockPath);
      await waiting();
      continue;
    }
    if (held()) break;
    const token = liveTakeoverToken(lockPath, record);
    if (token?.[2] === "unknown" && unknownHolderWaitedOut(token[0], token[1])) refuse(token[0]);
    await waiting();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    removeFileIfUnchanged(lockPath, record);
    if (!holdsGeneration()) return;
    if (createGeneration(lockPath, generation + 1, RELEASED)) removeGeneration(lockPath, generation);
  };
  return Object.assign(release, { held });
}
