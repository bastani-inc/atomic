import { createHash } from "crypto";
import { type BigIntStats, lstatSync, mkdirSync, readFileSync, renameSync, type Stats, writeFileSync } from "fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

/**
 * The shared storage selection (`ATOMIC_STORAGE` JSON) the launching Atomic process hands its broker: its
 * `--storage`/`--storage-file` or its own `ATOMIC_STORAGE`. It outranks the agent directory's settings.
 */
export const BROKER_STORAGE_ENV = "ATOMIC_STORAGE";

/**
 * Windows: exact named pipe derived by the launching process from its raw `ATOMIC_CODING_AGENT_DIR` /
 * `PI_CODING_AGENT_DIR` before absolutizing the path for the detached broker (which runs in a safe cwd outside
 * the installation directory). Lets the broker bind the exact byte-identical legacy pipe name that the parent and
 * earlier-release sessions connect to while resolving its own files (`broker.pid`, `broker.log`, stores) against the
 * absolutized agent directory.
 */
export const BROKER_SOCKET_PATH_ENV = "ATOMIC_INTERCOM_BROKER_SOCKET_PATH";

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

function envValue(env: NodeJS.ProcessEnv, canonicalKey: string): string | undefined {
  if (process.platform !== "win32") return env[canonicalKey];
  const upper = canonicalKey.toUpperCase();
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === upper);
  const lastKey = keys.at(-1);
  return lastKey === undefined ? env[canonicalKey] : env[lastKey];
}

/** The agent directory selected by `env`, keeping its exact raw spelling for pipe-name compatibility across versions. */
export function getAgentDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const atomicAgentDir = envValue(env, "ATOMIC_CODING_AGENT_DIR");
  if (atomicAgentDir) return expandTildePath(atomicAgentDir);
  const piAgentDir = envValue(env, "PI_CODING_AGENT_DIR");
  if (piAgentDir) return expandTildePath(piAgentDir);
  return join(getHomeDir(), ".atomic", "agent");
}

/** The agent directory the environment selects now. */
export function getAgentDir(): string {
  return getAgentDirFromEnv(process.env);
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

/** #5999: messages queued for subagents that ended, kept across broker restarts; owner-only. */
export function getBrokerEndedChildQueuePath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "ended-child-queue.sqlite");
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
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\pi-intercom-";

function isValidWindowsPipeSuffix(suffix: string): boolean {
  if (suffix.length === 0) return false;
  for (let i = 0; i < suffix.length; i += 1) {
    const code = suffix.charCodeAt(i);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isHyphen = code === 45;
    if (!isLower && !isDigit && !isHyphen) return false;
  }
  return true;
}

/**
 * Validated Windows named-pipe override passed by the spawner via {@link BROKER_SOCKET_PATH_ENV} when the caller's
 * raw `ATOMIC_CODING_AGENT_DIR`/`PI_CODING_AGENT_DIR` was relative or drive-relative rooted. Returns `undefined` off
 * Windows, when unset, or when malformed.
 */
export function brokerSocketPathOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== "win32") return undefined;
  const raw = envValue(env, BROKER_SOCKET_PATH_ENV);
  if (raw === undefined || raw.length > MAX_PIPE_NAME_LENGTH || !raw.startsWith(WINDOWS_PIPE_PREFIX)) {
    return undefined;
  }
  return isValidWindowsPipeSuffix(raw.slice(WINDOWS_PIPE_PREFIX.length)) ? raw : undefined;
}

/**
 * Reads the validated {@link BROKER_SOCKET_PATH_ENV} override and removes every case-insensitive copy of it from `env`
 * so child processes spawned by the broker (such as host commands) never inherit it.
 */
export function consumeBrokerSocketPathOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = brokerSocketPathOverride(env);
  const target = BROKER_SOCKET_PATH_ENV.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target) delete env[key];
  }
  return override;
}

/** Every spelling of one agent directory, such as a trailing separator or a `..` segment, gets the same digest. */
function agentDirDigest(agentDir: string): string {
  return createHash("sha256").update(resolve(agentDir)).digest("hex").slice(0, 16);
}

/**
 * Where the broker records the socket path it chose when the one in the agent directory is too long (#5040). The
 * agent directory is what every process using it shares; their runtime and temp directories can differ.
 */
export function getBrokerSocketPathRecordPath(agentDir: string = getAgentDir()): string {
  return join(getIntercomDirPath(agentDir), "broker.sock.path");
}

function inspectPrivateDirectoryStats(
  stats: Stats | BigIntStats,
  uid: number | undefined,
): string | undefined {
  if (!stats.isDirectory()) return "it is not a directory (or is a symbolic link)";
  if (stats.uid !== uid) return `it is owned by uid ${stats.uid}, not ${uid}`;
  if ((Number(stats.mode) & 0o077) !== 0) {
    return `its mode ${(Number(stats.mode) & 0o777).toString(8)} lets other users in (expected 700)`;
  }
  return undefined;
}

function privateDirectoryProblem(directory: string, uid: number | undefined): string | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(directory);
  } catch {
    return "it does not exist";
  }
  return inspectPrivateDirectoryStats(stats, uid);
}

async function privateDirectoryProblemAsync(directory: string, uid: number | undefined): Promise<string | undefined> {
  let stats: Stats;
  try {
    stats = await lstat(directory);
  } catch {
    return "it does not exist";
  }
  return inspectPrivateDirectoryStats(stats, uid);
}

/**
 * The per-user directory a too-long socket path moves to: under `$XDG_RUNTIME_DIR` when set, else the temp directory.
 * It is created owner-only, and used only while it is a real directory owned by this user that no one else can enter.
 */
function privateSocketDirectory(): string {
  // Only Unix sockets move here, and only Unix has uids.
  const uid = process.getuid?.();
  const directory = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `atomic-intercom-${uid}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const problem = privateDirectoryProblem(directory, uid);
  if (problem !== undefined) {
    throw new Error(`Intercom refuses the broker socket directory ${directory}: ${problem}`);
  }
  return directory;
}

async function privateSocketDirectoryAsync(): Promise<string> {
  const uid = process.getuid?.();
  const directory = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `atomic-intercom-${uid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const problem = await privateDirectoryProblemAsync(directory, uid);
  if (problem !== undefined) {
    throw new Error(`Intercom refuses the broker socket directory ${directory}: ${problem}`);
  }
  return directory;
}

function inDirectorySocketPath(agentDir: string): string {
  return join(getIntercomDirPath(agentDir), "broker.sock");
}

function fitsUnixSocketPath(socketPath: string, platform: NodeJS.Platform): boolean {
  return Buffer.byteLength(socketPath) <= maxUnixSocketPathBytes(platform);
}

export function directBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string | undefined {
  if (platform === "win32") {
    const pipe = `${WINDOWS_PIPE_PREFIX}${sanitizePipeSegment(agentDir)}`;
    return pipe.length <= MAX_PIPE_NAME_LENGTH ? pipe : `${WINDOWS_PIPE_PREFIX}${agentDirDigest(agentDir)}`;
  }
  const socketPath = inDirectorySocketPath(agentDir);
  return fitsUnixSocketPath(resolve(socketPath), platform) ? socketPath : undefined;
}

/**
 * The socket path a broker records, while it is one this user's broker for this agent directory could have chosen: an
 * absolute, normalized path `<runtime or temp directory>/atomic-intercom-<uid>/<digest>.sock` whose directory is this
 * user's alone and which is a socket this user owns. Anything else is ignored.
 */
function recordedSocketPath(agentDir: string): string | undefined {
  let recorded: string;
  try {
    recorded = readFileSync(getBrokerSocketPathRecordPath(agentDir), "utf-8").trim();
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  const directory = dirname(recorded);
  const wellFormed =
    resolve(recorded) === recorded &&
    basename(recorded) === `${agentDirDigest(agentDir)}.sock` &&
    basename(directory) === `atomic-intercom-${uid}`;
  if (!wellFormed || privateDirectoryProblem(directory, uid) !== undefined) return undefined;
  try {
    const stats = lstatSync(recorded);
    return stats.isSocket() && stats.uid === uid ? recorded : undefined;
  } catch {
    return undefined;
  }
}

async function recordedSocketPathAsync(agentDir: string): Promise<string | undefined> {
  let recorded: string;
  try {
    recorded = (await readFile(getBrokerSocketPathRecordPath(agentDir), "utf-8")).trim();
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  const directory = dirname(recorded);
  const wellFormed =
    resolve(recorded) === recorded &&
    basename(recorded) === `${agentDirDigest(agentDir)}.sock` &&
    basename(directory) === `atomic-intercom-${uid}`;
  if (!wellFormed || (await privateDirectoryProblemAsync(directory, uid)) !== undefined) return undefined;
  try {
    const stats = await lstat(recorded);
    return stats.isSocket() && stats.uid === uid ? recorded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The socket path a broker started by this process chooses. A path in the agent directory longer than the platform
 * allows moves to this process's per-user runtime or temp directory, named after a digest of the agent directory.
 */
export function chooseBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string {
  const direct = directBrokerSocketPath(platform, agentDir);
  if (direct !== undefined) return direct;

  const socketPath = resolve(inDirectorySocketPath(agentDir));
  const shortPath = join(privateSocketDirectory(), `${agentDirDigest(agentDir)}.sock`);
  if (!fitsUnixSocketPath(shortPath, platform)) {
    throw new Error(
      `Intercom broker socket paths ${socketPath} and ${shortPath} are both longer than the ${maxUnixSocketPathBytes(platform)} bytes a Unix socket path allows`,
    );
  }
  return shortPath;
}

export async function chooseBrokerSocketPathAsync(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): Promise<string> {
  const direct = directBrokerSocketPath(platform, agentDir);
  if (direct !== undefined) return direct;

  const socketPath = resolve(inDirectorySocketPath(agentDir));
  const shortPath = join(await privateSocketDirectoryAsync(), `${agentDirDigest(agentDir)}.sock`);
  if (!fitsUnixSocketPath(shortPath, platform)) {
    throw new Error(
      `Intercom broker socket paths ${socketPath} and ${shortPath} are both longer than the ${maxUnixSocketPathBytes(platform)} bytes a Unix socket path allows`,
    );
  }
  return shortPath;
}

/**
 * Where clients connect to the broker for an agent directory. Each caller derives it here, so they always agree. When
 * the path in the agent directory is too long, it is the path the running broker recorded (#5040), so sessions with
 * different runtime or temp directories reach the same broker; without a usable record, it is the path a broker this
 * process starts would choose.
 */
export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string {
  const direct = directBrokerSocketPath(platform, agentDir);
  if (direct !== undefined) return direct;
  const recorded = recordedSocketPath(agentDir);
  if (recorded !== undefined) return recorded;
  return chooseBrokerSocketPath(platform, agentDir);
}

export async function getBrokerSocketPathAsync(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): Promise<string> {
  const direct = directBrokerSocketPath(platform, agentDir);
  if (direct !== undefined) return direct;
  const recorded = await recordedSocketPathAsync(agentDir);
  if (recorded !== undefined) return recorded;
  return chooseBrokerSocketPathAsync(platform, agentDir);
}

/** Records the socket path a starting broker chose, when it is not the one in the agent directory; atomically. */
export function recordBrokerSocketPath(socketPath: string, agentDir: string = getAgentDir()): void {
  if (socketPath === inDirectorySocketPath(agentDir) || process.platform === "win32") return;
  const recordPath = getBrokerSocketPathRecordPath(agentDir);
  const temporary = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${socketPath}\n`, { mode: 0o600 });
  renameSync(temporary, recordPath);
}
