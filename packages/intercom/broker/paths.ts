import { createHash } from "crypto";
import { lstatSync, mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

/**
 * The shared storage selection (`ATOMIC_STORAGE` JSON) the launching Atomic process hands its broker: its
 * `--storage`/`--storage-file` or its own `ATOMIC_STORAGE`. It outranks the agent directory's settings.
 */
export const BROKER_STORAGE_ENV = "ATOMIC_STORAGE";

function getHomeDir(): string {
  if (process.platform === "win32") {
    if (process.env.USERPROFILE) return process.env.USERPROFILE;
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    if (process.env.HOME) return process.env.HOME;
    return homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function expandTildePath(path: string): string {
  if (path === "~") return getHomeDir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(getHomeDir(), path.slice(2));
  }
  return path;
}

function getAgentDir(): string {
  const atomicAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
  if (atomicAgentDir) return expandTildePath(atomicAgentDir);
  const piAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (piAgentDir) return expandTildePath(piAgentDir);
  return join(getHomeDir(), ".atomic", "agent");
}

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getIntercomDirPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "intercom");
}

export function getBrokerPidPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.pid");
}

export function getBrokerSpawnLockPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.spawn.lock");
}

export function getBrokerSocketReplacementLockPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.sock.replace.lock");
}

/** Durable accepted-operation authority shared by replacement broker processes. */
export function getBrokerDeliveredMessagesPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "delivered-messages.sqlite");
}

/** #4751: asks that wait for away sessions, and the replies held for away askers; owner-only. */
export function getBrokerAwayAsksPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "away-asks.sqlite");
}

/** Owner-only HMAC key paired with durable accepted-operation authority. */
export function getBrokerDeliveredMessagesKeyPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "delivered-messages.key");
}

/**
 * Startup/diagnostic log for the detached broker process. The parent opens this file
 * and hands the descriptor to the child as stderr, so a broker that dies before it can
 * accept connections leaves a readable reason behind for whichever process inspects it.
 */
export function getBrokerLogPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.log");
}

/**
 * Where a broker announces its real pid as its first act, for a parent that cannot watch the process it spawned (the
 * Windows launcher hides it); see `start-announcement.ts`. Written once at start-up and removed once the broker listens,
 * never after the broker ends.
 */
export function getBrokerStartAnnouncementPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.starting");
}

export function getBrokerWatchdogLogPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker-watchdog.log");
}

/**
 * The longest Unix socket path, in bytes, a listener can bind: `sun_path` holds 108 bytes on Linux and 104 on macOS and
 * the BSDs, one of them the terminating NUL. Node 22 silently truncates a longer path and Node 24 refuses it (#5040).
 */
export function maxUnixSocketPathBytes(platform: NodeJS.Platform): number {
  return platform === "linux" ? 107 : 103;
}

/** A Windows pipe name is at most 256 characters. */
const MAX_PIPE_NAME_LENGTH = 256;

function agentDirDigest(agentDir: string): string {
  return createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
}

/**
 * The per-user directory a too-long socket path moves to: under `$XDG_RUNTIME_DIR` when set, else the temp directory.
 * It is created owner-only, and used only while it is a real directory owned by this user that no one else can enter.
 */
function privateSocketDirectory(): string {
  const uid = process.getuid?.();
  const directory = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `atomic-intercom-${uid ?? "user"}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  const problem = !stats.isDirectory()
    ? "it is not a directory (or is a symbolic link)"
    : uid !== undefined && stats.uid !== uid
      ? `it is owned by uid ${stats.uid}, not ${uid}`
      : uid !== undefined && (stats.mode & 0o077) !== 0
        ? `its mode ${(stats.mode & 0o777).toString(8)} lets other users in (expected 700)`
        : undefined;
  if (problem !== undefined) {
    throw new Error(`Intercom refuses the broker socket directory ${directory}: ${problem}`);
  }
  return directory;
}

/**
 * Where the broker listens and every client connects. Each caller derives it here, so they always agree. A socket path
 * longer than the platform allows moves to a per-user directory, named after a digest of the agent directory (#5040).
 */
export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string {
  if (platform === "win32") {
    const pipe = `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
    return pipe.length <= MAX_PIPE_NAME_LENGTH ? pipe : `\\\\.\\pipe\\pi-intercom-${agentDirDigest(agentDir)}`;
  }

  const socketPath = join(getIntercomDirPath(agentDir), "broker.sock");
  if (Buffer.byteLength(socketPath) <= maxUnixSocketPathBytes(platform)) return socketPath;
  const shortPath = join(privateSocketDirectory(), `${agentDirDigest(agentDir)}.sock`);
  if (Buffer.byteLength(shortPath) > maxUnixSocketPathBytes(platform)) {
    throw new Error(
      `Intercom broker socket paths ${socketPath} and ${shortPath} are both longer than the ${maxUnixSocketPathBytes(platform)} bytes a Unix socket path allows`,
    );
  }
  return shortPath;
}
