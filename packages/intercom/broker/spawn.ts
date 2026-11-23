import { spawn } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "fs";
import { access, appendFile, chmod, type FileHandle, lstat, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { isSocketAnswering } from "./socket-liveness.js";
import { renameWithRetry, renameWithRetryAsync } from "./rename-retry.js";
import {
  completeLines,
  createLockFile,
  createLockFileAsync,
  readFileOrUndefined,
  readFileOrUndefinedAsync,
  takeOverStaleLock,
  takeOverStaleLockAsync,
  unknownHolderAdvice,
  unknownHolderAdviceAsync,
  unknownHolderWaitedOut,
  unknownHolderWaitedOutAsync,
  writerState,
  writerStateAsync,
} from "./stale-lock-file.js";
import { BROKER_READY_TIMEOUT_MS } from "./startup-timeout.js";
import {
  BROKER_ANNOUNCE_PATH_ENV,
  BROKER_ANNOUNCE_START_ENV,
  BROKER_ANNOUNCE_TOKEN_ENV,
  processCreationTimeOf,
  recognisedProcessStart,
  type AnnouncedBroker,
  type BrokerStartAnnouncement,
} from "./start-announcement.js";
import {
  createChildProcessEnvironment,
  IntercomBrokerUpgradeError,
  isBunBinary,
  isIntercomBrokerStopTimeoutError,
  processSharedStorageSelection,
  processSharedStorageSelectionAsync,
  takeTakeoverMutex,
  takeTakeoverMutexAsync,
} from "@bastani/atomic";
import {
  type BrokerProcess,
  identifyBrokerProcessAsync,
  laterProcessProbe,
  nativeProcessCreationTime,
  processStartToken,
  readProcessCreationTime,
  readProcessStartToken,
  readProcessStartWithoutProcess,
  stopWindowsProcess,
} from "./broker-process.js";
import { isBrokerStatusReport } from "./broker-status.js";
import { BROKER_UPGRADE_STOP_TIMEOUT_MS, requestBrokerShutdown, waitForBrokerExit } from "./broker-stop.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";
import { BROKER_PROTOCOL, type BrokerProtocolRange, decideBrokerProtocol, protocolRangeOf } from "./protocol-version.js";
import { readSharedStorageSettingAsync, sharedStorageDigest } from "./shared-storage-setting.js";
import {
  BROKER_STORAGE_ENV,
  getAgentDir,
  getBrokerLogPath,
  getBrokerPidPath,
  getBrokerSocketPathAsync,
  getBrokerSpawnLockPath,
  getIntercomDirPath,
} from "./paths.js";
import {
  isAbsoluteWindowsPath,
  resolveSafeWindowsWorkingDirectoryAsync,
  resolveSafeWindowsWorkingDirectorySync,
  windowsDriveRoot,
} from "./windows-cwd.js";
import { pathExists } from "../path-exists.js";


/** Package root whether this module is `broker/spawn.ts` or the installed `index.bundle.mjs`. */
export function resolveIntercomPackageRoot(moduleHref: string): string {
  const here = dirname(fileURLToPath(moduleHref));
  return basename(here) === "broker" ? join(here, "..") : here;
}

export function resolveBrokerEntrypoint(packageRoot: string): string {
  const root = resolveAgainstCallerCwd(packageRoot);
  const bundled = process.platform === "win32" ? win32.join(root, "broker", "broker.bundle.mjs") : join(root, "broker", "broker.bundle.mjs");
  return existsSync(bundled) ? bundled : process.platform === "win32" ? win32.join(root, "broker", "broker.ts") : join(root, "broker", "broker.ts");
}

export async function resolveBrokerEntrypointAsync(packageRoot: string): Promise<string> {
  const root = resolveAgainstCallerCwd(packageRoot);
  const bundled = process.platform === "win32" ? win32.join(root, "broker", "broker.bundle.mjs") : join(root, "broker", "broker.bundle.mjs");
  return (await pathExists(bundled))
    ? bundled
    : process.platform === "win32"
      ? win32.join(root, "broker", "broker.ts")
      : join(root, "broker", "broker.ts");
}


const EXTENSION_DIR = resolveIntercomPackageRoot(import.meta.url);

async function ensurePrivateDirectoryAsync(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

/**
 * How much of the broker startup log is read back into an error message.
 *
 * This is a read bound only. The file's physical size is capped separately, inside the broker
 * process, by {@link BROKER_LOG_MAX_BYTES} in `bounded-stderr.ts` — nothing the parent does can
 * bound a detached child that keeps appending after the parent exits.
 */
export const BROKER_LOG_TAIL_BYTES = 8 * 1024;

/** First readiness poll interval; doubles up to {@link BROKER_POLL_MAX_INTERVAL_MS}. */
export const BROKER_POLL_INITIAL_INTERVAL_MS = 10;

/** Upper bound for the readiness poll interval, matching the historic flat poll. */
export const BROKER_POLL_MAX_INTERVAL_MS = 100;

export { BROKER_READY_TIMEOUT_MS };

/** Backstop only: a spawn lock normally ends when its broker is ready or the processes it names are gone. */
export const BROKER_SPAWN_LOCK_MAX_AGE_MS = 60_000;

type BrokerRuntime = "node" | "bun-source" | "bun-binary";

export const INTERNAL_INTERCOM_BROKER_ARG = "--atomic-internal-intercom-broker";
const INTERNAL_INTERCOM_BROKER_RELAY_ARG = "--atomic-internal-intercom-broker-relay";
const INTERNAL_INTERCOM_BROKER_RELAY_CAPABILITY = Symbol.for("@bastani/atomic/intercom-broker-relay@1");

export interface BrokerLaunchSpec {
  readonly kind: "direct";
  readonly command: string;
  readonly args: string[];
  /** Windows: pass `args` verbatim without re-quoting (used only when a custom `brokerCommand` is a `.cmd`/`.bat` script). */
  readonly verbatimArguments?: true;
  /**
   * Windows: start with `CREATE_NO_WINDOW` instead of `DETACHED_PROCESS` so a custom `brokerCommand` override
   * (`.cmd`/`.bat` or wrapper `.exe`) receives a hidden windowless console inherited by any console child it spawns.
   */
  readonly noWindow?: true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function getCurrentBrokerRuntime(): BrokerRuntime {
  if (!process.versions.bun) return "node";
  return isBunBinary ? "bun-binary" : "bun-source";
}

function requireFromExtensionDir(extensionDir: string): NodeJS.Require {
  return createRequire(join(extensionDir, "package.json"));
}

export function getJitiCliPath(extensionDir: string = EXTENSION_DIR): string {
  const root = resolveAgainstCallerCwd(extensionDir);
  try {
    const jitiPackage = requireFromExtensionDir(root).resolve("jiti/package.json");
    return join(dirname(jitiPackage), "lib", "jiti-cli.mjs");
  } catch {
    return process.platform === "win32"
      ? win32.join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs")
      : join(root, "node_modules", "jiti", "lib", "jiti-cli.mjs");
  }
}

/**
 * jiti is a dependency-free pure-JS TypeScript loader, so the Node broker path no longer needs
 * tsx and its platform-specific esbuild binary. The `npx --no-install tsx` config pair remains
 * a recognized compatibility sentinel; nothing resolves the tsx package.
 */
function getDefaultBrokerRunnerPath(extensionDir: string): string {
  return getJitiCliPath(extensionDir);
}

function getDefaultBrokerCommandParts(
  brokerPath: string,
  extensionDir: string,
  runtimePath: string,
  runtime: BrokerRuntime,
): { command: string; args: string[] } {
  if (runtime === "bun-source") {
    return { command: runtimePath, args: [brokerPath] };
  }
  if (runtime === "bun-binary") {
    return { command: runtimePath, args: [INTERNAL_INTERCOM_BROKER_ARG, brokerPath] };
  }
  if (/\.m?js$/u.test(brokerPath)) {
    return { command: runtimePath, args: [brokerPath] };
  }
  return { command: runtimePath, args: [getDefaultBrokerRunnerPath(extensionDir), brokerPath] };
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
}

function isWindowsBatchCommand(command: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(command);
}

function windowsCmdPath(): string {
  return win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "cmd.exe");
}

function quoteWindowsCmdToken(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatWindowsCmdCommandLine(command: string, args: readonly string[]): string {
  // `/s` strips the single outer quote pair and passes the interior verbatim to cmd.exe.
  return `"${[quoteWindowsCmdToken(command), ...args.map(quoteWindowsCmdToken)].join(" ")}"`;
}

function envValueCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env)
    .filter((candidate) => candidate.toUpperCase() === name)
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * On Windows, resolve a bare custom `brokerCommand` name on `PATH` so `.cmd`/`.bat` shims are recognised and wrapped
 * cleanly with `cmd.exe /d /s /c`, while `.exe`/`.com` commands run directly without a shell. Never searches the
 * working directory unless an explicit absolute `PATH` entry names it.
 */
async function resolveWindowsCustomCommandAsync(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (command === "" || /[\\/:]/u.test(command) || isWindowsBatchCommand(command)) {
    return command;
  }
  const rawPath = envValueCaseInsensitive(env, "PATH") ?? envValueCaseInsensitive(process.env, "PATH") ?? "";
  const rawPathext = envValueCaseInsensitive(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const named = rawPathext
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const extensions = [...named, ...[".com", ".exe"].filter((ext) => !named.includes(ext))];
  const hasExt = win32.extname(command) !== "";
  const names = [...(hasExt ? [command] : []), ...extensions.map((ext) => `${command}${ext}`)];

  for (const rawEntry of rawPath.split(";")) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (entry === "" || !win32.isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = win32.join(entry, name);
      try {
        await access(candidate);
        try {
          const entryStat = await lstat(candidate);
          const isDir = entryStat.isDirectory() || (entryStat.isSymbolicLink() && (await stat(candidate)).isDirectory());
          if (isDir) continue;
        } catch {
          // App execution aliases can be visible to access() while lstat/stat fails; treat as startable.
        }
        return candidate;
      } catch {
        // Not present in this directory.
      }
    }
  }
  return command;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  platform: NodeJS.Platform = process.platform,
  _intercomDir: string = getIntercomDirPath(),
  nodePath: string = process.execPath,
  runtime: BrokerRuntime = getCurrentBrokerRuntime(),
  _logPath: string = getBrokerLogPath(),
): BrokerLaunchSpec {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    const launch = getDefaultBrokerCommandParts(brokerPath, extensionDir, nodePath, runtime);
    return {
      kind: "direct",
      command: launch.command,
      args: launch.args,
    };
  }

  if (platform === "win32" && isWindowsBatchCommand(brokerCommand)) {
    return {
      kind: "direct",
      command: windowsCmdPath(),
      args: ["/d", "/s", "/c", formatWindowsCmdCommandLine(brokerCommand, [...brokerArgs, brokerPath])],
      verbatimArguments: true,
      noWindow: true,
    };
  }

  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
    ...(platform === "win32" ? { noWindow: true as const } : {}),
  };
}

function resolveAgainstCallerCwd(rawPath: string): string {
  if (process.platform === "win32") {
    if (isAbsoluteWindowsPath(rawPath)) return rawPath;
    try {
      return win32.resolve(process.cwd(), rawPath);
    } catch {
      return rawPath;
    }
  }
  return isAbsolute(rawPath) ? rawPath : resolve(rawPath);
}

function brokerSafeCwdOptions(extensionDir: string, commandPath?: string) {
  const resolvedExt = resolveAgainstCallerCwd(extensionDir);
  const installDirs = isBunBinary
    ? [resolvedExt, win32.dirname(resolveAgainstCallerCwd(process.execPath))]
    : [resolvedExt];
  const agentDir = resolveAgainstCallerCwd(getAgentDir());
  const intercomDir = resolveAgainstCallerCwd(getIntercomDirPath());
  return {
    protectedDirs: [intercomDir, agentDir],
    installDirs,
    commandPath,
  };
}

function resolveBrokerWorkingDirectorySync(extensionDir: string, commandPath?: string): string {
  if (process.platform !== "win32") return "/";
  return (
    resolveSafeWindowsWorkingDirectorySync(brokerSafeCwdOptions(extensionDir, commandPath)) ??
    windowsDriveRoot(resolveAgainstCallerCwd(extensionDir)) ??
    "C:\\"
  );
}

async function resolveBrokerWorkingDirectoryAsync(extensionDir: string, commandPath?: string): Promise<string> {
  if (process.platform !== "win32") return "/";
  return (
    (await resolveSafeWindowsWorkingDirectoryAsync({
      ...brokerSafeCwdOptions(extensionDir, commandPath),
      timeoutMs: 150,
    })) ??
    windowsDriveRoot(resolveAgainstCallerCwd(extensionDir)) ??
    "C:\\"
  );
}

function setEnvValue(env: NodeJS.ProcessEnv, canonicalKey: string, value: string): void {
  if (process.platform !== "win32") {
    env[canonicalKey] = value;
    return;
  }
  const upper = canonicalKey.toUpperCase();
  const matching = Object.keys(env).filter((k) => k.toUpperCase() === upper);
  const targetKey = matching.at(-1) ?? canonicalKey;
  for (const key of matching) {
    if (key !== targetKey) delete env[key];
  }
  env[targetKey] = value;
}

function absolutizeAgentDirEnvInPlace(env: NodeJS.ProcessEnv): void {
  for (const canonicalKey of ["ATOMIC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const) {
    const matching =
      process.platform === "win32"
        ? Object.keys(env).filter((k) => k.toUpperCase() === canonicalKey)
        : Object.hasOwn(env, canonicalKey)
          ? [canonicalKey]
          : [];
    if (matching.length === 0) continue;
    const targetKey = matching.at(-1)!;
    const value = env[targetKey];
    for (const key of matching) {
      if (key !== targetKey) delete env[key];
    }
    if (!value || value === "~" || value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
      continue;
    }
    const needsResolve = process.platform === "win32" ? !isAbsoluteWindowsPath(value) : !isAbsolute(value);
    if (needsResolve) {
      env[targetKey] = resolveAgainstCallerCwd(value);
    }
  }
}

/**
 * The broker is detached and outlives this process, so its stderr goes to an already-open file
 * descriptor rather than a pipe: a long-lived pipe would keep the parent's event loop attached
 * and break once the parent exits.
 *
 * Its working directory is always outside the installation directory, the caller's working
 * directory, and the agent directory (`/` on POSIX; a short, verified directory on Windows) so a
 * running broker never holds a directory handle that blocks `npm install -g`, uninstalls, or
 * directory cleanup.
 *
 * The broker routes through the shared storage this process was launched with (`--storage`,
 * `--storage-file` or `ATOMIC_STORAGE`), passed as `ATOMIC_STORAGE`; without one it reads settings.
 * With `announcement` it also gets the file and token it announces its pid with, and asks it to add when it was created
 * (`start-announcement.ts`).
 */
function buildBrokerSpawnOptions(
  storage: string | undefined,
  cwd: string,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
): {
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const env = createChildProcessEnvironment();
  absolutizeAgentDirEnvInPlace(env);
  setEnvValue(env, "NODE_NO_WARNINGS", "1");
  if (storage !== undefined) setEnvValue(env, BROKER_STORAGE_ENV, storage);
  if (announcement !== undefined) {
    setEnvValue(env, BROKER_ANNOUNCE_PATH_ENV, resolveAgainstCallerCwd(announcement.path));
    setEnvValue(env, BROKER_ANNOUNCE_TOKEN_ENV, announcement.token);
    setEnvValue(env, BROKER_ANNOUNCE_START_ENV, "1");
  }
  return {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    cwd,
    env,
    windowsHide: true,
  };
}

export function getBrokerSpawnOptions(
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
  commandPath?: string,
): {
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return buildBrokerSpawnOptions(
    processSharedStorageSelection(),
    resolveBrokerWorkingDirectorySync(extensionDir, commandPath),
    stderr,
    announcement,
  );
}

export async function getBrokerSpawnOptionsAsync(
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
  commandPath?: string,
): Promise<{
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
}> {
  const [storage, cwd] = await Promise.all([
    processSharedStorageSelectionAsync(),
    resolveBrokerWorkingDirectoryAsync(extensionDir, commandPath),
  ]);
  return buildBrokerSpawnOptions(storage, cwd, stderr, announcement);
}

/**
 * How long a spawn waits for the Windows launcher of a broker that just exited to let go of the log. Its `cmd.exe`
 * outlives the broker by a moment, and a broker that is really still starting keeps the log for as long as it runs.
 */
export const BROKER_LOG_RELEASE_WAIT_MS = 1_000;

/**
 * Preserve a bounded previous log across truncation. Returns false when a
 * Windows launcher holds the log through its stderr redirect.
 */
async function resetBrokerLogAsync(logPath: string = getBrokerLogPath()): Promise<boolean> {
  await ensurePrivateDirectoryAsync(dirname(logPath));
  try {
    const previous = await readBrokerLogTailAsync(logPath);
    const handle = await open(logPath, "w");
    await handle.close();
    if (previous.length > 0) {
      try {
        const previousPath = `${logPath}.previous`;
        await writeFile(previousPath, Buffer.from(previous).subarray(-BROKER_LOG_TAIL_BYTES), { mode: 0o600 });
        if (process.platform !== "win32") await chmod(previousPath, 0o600);
      } catch {}
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM")) return false;
    throw error;
  }
}

/**
 * Reset the log, waiting up to {@link BROKER_LOG_RELEASE_WAIT_MS} for the launcher of a broker that just exited, as
 * one does when a running broker dies and its clients reconnect at once. Returns false only when the log stays held,
 * which means a broker is still starting.
 */
async function resetBrokerLogOnceReleased(): Promise<boolean> {
  const deadline = Date.now() + BROKER_LOG_RELEASE_WAIT_MS;
  while (!(await resetBrokerLogAsync())) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

function decodeLogTail(tail: Buffer): string {
  // Skip the rest of a character the cut started inside (UTF-8 continuation bytes), so it shows no U+FFFD (#5097).
  // Past the end a read gives `undefined`, whose bits are 0, so the loop stops there.
  let start = 0;
  while ((tail[start]! & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString("utf-8").trim();
}

/** Read at most {@link BROKER_LOG_TAIL_BYTES} trailing bytes of the broker log. */
export function readBrokerLogTail(logPath: string = getBrokerLogPath(), maxBytes: number = BROKER_LOG_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = statSync(logPath).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return decodeLogTail(buffer.subarray(0, read));
  } catch {
    // A missing or unreadable log simply yields no diagnostic tail.
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

export async function readBrokerLogTailAsync(
  logPath: string = getBrokerLogPath(),
  maxBytes: number = BROKER_LOG_TAIL_BYTES,
): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(logPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return decodeLogTail(buffer.subarray(0, bytesRead));
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
      }
    }
  }
}

function formatBrokerLogDescription(logPath: string, tail: string): string {
  if (tail.length === 0) return `Broker log: ${logPath} (empty)`;
  return `Broker log: ${logPath}\n--- broker stderr (last ${Buffer.byteLength(tail)} bytes) ---\n${tail}`;
}

/** Path plus bounded stderr tail, appended to every broker startup failure. */
export function describeBrokerLog(logPath: string = getBrokerLogPath()): string {
  return formatBrokerLogDescription(logPath, readBrokerLogTail(logPath));
}

export async function describeBrokerLogAsync(logPath: string = getBrokerLogPath()): Promise<string> {
  return formatBrokerLogDescription(logPath, await readBrokerLogTailAsync(logPath));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Start the broker unless one answers. #4727: `signal` cancels the start until the broker process exists: nothing is
 * written into the agent directory once it aborts, and waiting for another spawner's broker stops at once. A broker
 * this call already launched is waited for until it listens; when `signal` aborts first, or the broker does not listen
 * within the startup timeout, it is stopped, so the call never returns while that broker is still writing its start-up
 * files. An aborted call rejects with `signal.reason`.
 */
export async function spawnBrokerIfNeeded(
  brokerCommand: string,
  brokerArgs: string[],
  readyTimeoutMs: number = BROKER_READY_TIMEOUT_MS,
  extensionDir: string = EXTENSION_DIR,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await ensurePrivateDirectoryAsync(getIntercomDirPath());

  if (await isBrokerRunning()) {
    return;
  }

  signal?.throwIfAborted();
  const lockOwner = await acquireSpawnLockAsync();
  if (lockOwner === undefined) {
    await waitForBrokerOrTakeOver(brokerCommand, brokerArgs, readyTimeoutMs, extensionDir, signal);
    return;
  }
  await spawnBrokerHoldingLock(lockOwner, brokerCommand, brokerArgs, readyTimeoutMs, extensionDir, true, signal);
}

/**
 * Wait for the broker another spawner is starting. When that spawner lets go of the spawn lock before a broker answers
 * (it was cancelled and stopped its broker, or it gave up) or its lock goes stale, start the broker here instead of
 * waiting out the startup timeout for a broker nobody is starting any more.
 */
async function waitForBrokerOrTakeOver(
  brokerCommand: string,
  brokerArgs: string[],
  readyTimeoutMs: number,
  extensionDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  let interval = BROKER_POLL_INITIAL_INTERVAL_MS;
  while (Date.now() - start < readyTimeoutMs) {
    signal?.throwIfAborted();
    if (await checkSocketConnectable()) return;
    const lockOwner = await acquireSpawnLockAsync();
    if (lockOwner !== undefined) {
      await spawnBrokerHoldingLock(lockOwner, brokerCommand, brokerArgs, readyTimeoutMs, extensionDir, true, signal);
      return;
    }
    await sleep(interval, signal);
    interval = Math.min(interval * 2, BROKER_POLL_MAX_INTERVAL_MS);
  }
  throw await brokerStartTimeoutError(readyTimeoutMs);
}

interface NativeDetachedProcess {
  readonly pid: number;
  readonly creationTime?: string | null;
  kill(signal: number, group: boolean): boolean;
  unref(): void;
  release(): void;
}

interface NativeHostProcessEvent {
  readonly kind: string;
  readonly code?: number;
}

interface NativeDetachedStartOptions {
  readonly file: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly pipeStdin: false;
  readonly pipeStdout: false;
  readonly pipeStderr: false;
  readonly detached: true;
  readonly stderrLogPath?: string;
  readonly verbatimArguments?: boolean;
  readonly noWindow?: boolean;
  readonly watchPid?: number;
  readonly watchCreationTime?: string;
}

type NativeStartHostProcess = (
  options: NativeDetachedStartOptions,
  onEvent: (event: NativeHostProcessEvent) => void,
) => NativeDetachedProcess;

interface NativeBrokerSpawnBindings {
  readonly startHostProcess: NativeStartHostProcess | null;
  readonly modulePath: string | undefined;
}

let nativeBrokerSpawnBindings: NativeBrokerSpawnBindings | undefined;

function loadNativeBrokerSpawnBindings(): NativeBrokerSpawnBindings {
  if (process.platform !== "win32") {
    return { startHostProcess: null, modulePath: undefined };
  }
  if (nativeBrokerSpawnBindings === undefined) {
    let startHostProcess: NativeStartHostProcess | null = null;
    let modulePath: string | undefined;
    try {
      const req = createRequire(import.meta.url);
      try {
        modulePath = req.resolve("@bastani/atomic-natives");
      } catch {
        modulePath = undefined;
      }
      const binding = req(modulePath ?? "@bastani/atomic-natives") as {
        readonly startHostProcess?: NativeStartHostProcess;
      };
      startHostProcess = typeof binding.startHostProcess === "function" ? binding.startHostProcess : null;
    } catch {
      startHostProcess = null;
    }
    nativeBrokerSpawnBindings = { startHostProcess, modulePath };
  }
  return nativeBrokerSpawnBindings;
}

function stringOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Minimal relay script run in a short-lived detached child on Windows so the Intercom broker is orphaned outside the
 * launching engine's process tree (its `InheritedFromUniqueProcessId` is the exited relay). Without this, escalating a
 * hung engine via `holdProcessDescendants` or `taskkill /T` would terminate the shared Intercom broker serving other
 * sessions. The relay reads one JSON request on stdin, starts the broker (breaking away from the parent job when
 * allowed), writes `{ ok, pid, creationTime }` on stdout while holding the broker's handle so the parent can attach a
 * verified watch handle without PID-reuse races, and exits immediately once stdin closes.
 */
const WINDOWS_BROKER_RELAY_SCRIPT = [
  'const fs = require("node:fs");',
  'const cp = require("node:child_process");',
  'let buf = "", launched = false, held = null;',
  'function done() { try { held?.release?.(); } catch {} process.exit(0); }',
  'function reply(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  '  if (launched) return;',
  '  buf += chunk;',
  '  const nl = buf.indexOf("\\n");',
  '  if (nl === -1) return;',
  '  launched = true;',
  '  try {',
  '    const req = JSON.parse(buf.slice(0, nl));',
  '    let native = null;',
  '    if (req.nativePath) { try { native = require(req.nativePath); } catch {} }',
  '    if (typeof native?.startHostProcess === "function") {',
  '      try {',
  '        const p = native.startHostProcess({ file: req.file, args: req.args, cwd: req.cwd, env: req.env, pipeStdin: false, pipeStdout: false, pipeStderr: false, detached: true, stderrLogPath: req.stderrLogPath, ...(req.verbatimArguments ? { verbatimArguments: true } : {}), ...(req.noWindow ? { noWindow: true } : {}) }, () => {});',
  '        p.unref();',
  '        held = p;',
  '        reply({ ok: true, pid: p.pid, creationTime: p.creationTime ?? null });',
  '        return;',
  '      } catch (e) {',
  '        if (e?.code !== "ENOSYS" && e?.code !== "ENOTSUP") throw e;',
  '      }',
  '    }',
  '    const fd = fs.openSync(req.stderrLogPath, "a");',
  '    try {',
  '      const c = cp.spawn(req.file, req.args, { detached: true, windowsHide: true, cwd: req.cwd, env: req.env, stdio: ["ignore", "ignore", fd], ...(req.verbatimArguments ? { windowsVerbatimArguments: true } : {}) });',
  '      c.once("spawn", () => {',
  '        c.unref();',
  '        let started = null;',
  '        if (c.exitCode === null && c.signalCode === null && c.pid && typeof native?.processCreationTime === "function") { try { started = native.processCreationTime(c.pid) ?? null; } catch {} }',
  '        reply({ ok: true, pid: c.pid ?? null, creationTime: started });',
  '      });',
  '      c.once("error", (e) => reply({ ok: false, code: e?.code ?? "UNKNOWN", message: e?.message ?? String(e) }));',
  '    } finally { fs.closeSync(fd); }',
  '  } catch (e) {',
  '    reply({ ok: false, code: e?.code ?? "UNKNOWN", message: e?.message ?? String(e) });',
  '  }',
  '});',
  'process.stdin.on("end", done);',
  'setTimeout(done, 5000).unref();',
].join("\n");

const WINDOWS_RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const WINDOWS_RELAY_EXIT_TIMEOUT_MS = 2_000;

interface WindowsRelaySpec {
  readonly command: string;
  readonly args: string[];
}

function getWindowsRelaySpec(
  runtime: BrokerRuntime = getCurrentBrokerRuntime(),
  runtimePath: string = process.execPath,
): WindowsRelaySpec | undefined {
  if (runtime === "bun-binary") {
    const supported = (globalThis as Record<symbol, unknown>)[INTERNAL_INTERCOM_BROKER_RELAY_CAPABILITY] === true;
    return supported ? { command: runtimePath, args: [INTERNAL_INTERCOM_BROKER_RELAY_ARG] } : undefined;
  }
  if (runtime === "bun-source") {
    return { command: runtimePath, args: ["-e", WINDOWS_BROKER_RELAY_SCRIPT] };
  }
  return { command: runtimePath, args: ["--no-warnings", "-e", WINDOWS_BROKER_RELAY_SCRIPT] };
}

function cleanRelayEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Do not run user/test preloads or debuggers inside the short-lived relay; the broker itself receives the full env.
    if (key.toUpperCase() === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return env;
}

interface SpawnedBrokerChild {
  readonly pid: number | undefined;
  /** Kernel creation time read while a live process handle was held (Windows), when available. */
  readonly started: string | undefined;
  /** True while this process holds a live OS handle to the broker preventing Windows PID reuse. */
  readonly holdsProcessHandle: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** Non-native Windows fallback only: poll liveness of the orphaned broker via waitForBroker. */
  readonly polledIdentity?: () => AnnouncedBroker | undefined;
  onceError(listener: (error: Error) => void): void;
  offError(listener: (error: Error) => void): void;
  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  offExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  killHandle(): void;
  release(): void;
}

function wrapNativeProcessHandle(
  proc: NativeDetachedProcess,
  started: string | undefined,
  readExitCode: () => number | null,
  setExitListener: (listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined) => void,
  clearExitListener: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void,
): SpawnedBrokerChild {
  return {
    pid: proc.pid,
    started,
    holdsProcessHandle: true,
    get exitCode() {
      return readExitCode();
    },
    get signalCode() {
      return null;
    },
    onceError() {
      // Native start/watch reports launch errors synchronously via throw.
    },
    offError() {},
    onceExit(listener) {
      const code = readExitCode();
      if (code !== null) {
        queueMicrotask(() => listener(code, null));
        return;
      }
      setExitListener(listener);
    },
    offExit(listener) {
      clearExitListener(listener);
    },
    killHandle() {
      try {
        proc.kill(9, false);
      } catch {}
    },
    release() {
      setExitListener(undefined);
      try {
        proc.release();
      } catch {}
    },
  };
}

function wrapNativeDetachedProcess(
  startNative: NativeStartHostProcess,
  launch: BrokerLaunchSpec,
  spawnOptions: ReturnType<typeof buildBrokerSpawnOptions>,
  logPath: string,
): SpawnedBrokerChild | undefined {
  let exitCode: number | null = null;
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let proc: NativeDetachedProcess;
  try {
    proc = startNative(
      {
        file: launch.command,
        args: launch.args,
        cwd: spawnOptions.cwd,
        env: stringOnlyEnv(spawnOptions.env),
        pipeStdin: false,
        pipeStdout: false,
        pipeStderr: false,
        detached: true,
        stderrLogPath: logPath,
        ...(launch.verbatimArguments ? { verbatimArguments: true } : {}),
        ...(launch.noWindow ? { noWindow: true } : {}),
      },
      (event) => {
        if (event.kind !== "exit") return;
        exitCode = event.code ?? -1;
        const listener = exitListener;
        exitListener = undefined;
        listener?.(exitCode, null);
      },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Older native addon before Windows detached support: fall back to direct child_process.spawn.
    if (code === "ENOSYS" || code === "ENOTSUP") return undefined;
    throw error;
  }
  proc.unref();
  const started = proc.creationTime ?? nativeProcessCreationTime(proc.pid);
  return wrapNativeProcessHandle(
    proc,
    started,
    () => exitCode,
    (listener) => {
      exitListener = listener;
    },
    (listener) => {
      if (exitListener === listener) exitListener = undefined;
    },
  );
}

function watchOrphanedWindowsProcess(
  startNative: NativeStartHostProcess,
  pid: number,
  creationTime: string,
): SpawnedBrokerChild | undefined {
  let exitCode: number | null = null;
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let proc: NativeDetachedProcess;
  try {
    proc = startNative(
      {
        file: "",
        args: [],
        env: {},
        pipeStdin: false,
        pipeStdout: false,
        pipeStderr: false,
        detached: true,
        watchPid: pid,
        watchCreationTime: creationTime,
      },
      (event) => {
        if (event.kind !== "exit") return;
        exitCode = event.code ?? -1;
        const listener = exitListener;
        exitListener = undefined;
        listener?.(exitCode, null);
      },
    );
  } catch {
    return undefined;
  }
  proc.unref();
  return wrapNativeProcessHandle(
    proc,
    creationTime,
    () => exitCode,
    (listener) => {
      exitListener = listener;
    },
    (listener) => {
      if (exitListener === listener) exitListener = undefined;
    },
  );
}

interface RelayResponse {
  readonly ok: boolean;
  readonly pid?: number | null;
  readonly creationTime?: string | null;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Start the Windows broker through a short-lived detached relay that exits immediately after handing the broker's
 * `(pid, creationTime)` back while holding its handle. Once the relay exits, the broker's `InheritedFromUniqueProcessId`
 * names the dead relay, so a hung-engine tree kill (`holdProcessDescendants` or `taskkill /T`) never ends the shared
 * broker while still ending every other descendant of the engine.
 */
async function spawnOrphanedWindowsBrokerAsync(
  launch: BrokerLaunchSpec,
  spawnOptions: ReturnType<typeof buildBrokerSpawnOptions>,
  logPath: string,
  bindings: NativeBrokerSpawnBindings,
): Promise<SpawnedBrokerChild | undefined> {
  const relaySpec = getWindowsRelaySpec();
  if (relaySpec === undefined) return undefined;

  let relay: ReturnType<typeof spawn>;
  try {
    relay = spawn(relaySpec.command, relaySpec.args, {
      detached: true,
      windowsHide: true,
      cwd: spawnOptions.cwd,
      env: cleanRelayEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  relay.stdin?.on("error", () => {});
  relay.stdout?.on("error", () => {});

  const relayExited = new Promise<void>((resolve) => {
    if (relay.exitCode !== null || relay.signalCode !== null) {
      resolve();
      return;
    }
    relay.once("exit", () => resolve());
    relay.once("error", () => resolve());
  });

  const endRelayAndWait = async (): Promise<void> => {
    try {
      relay.stdin?.end();
    } catch {}
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exitedInTime = await Promise.race([
      relayExited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), WINDOWS_RELAY_EXIT_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!exitedInTime) {
      try {
        relay.kill("SIGKILL");
      } catch {}
      await Promise.race([relayExited, sleep(500)]);
    }
  };

  const response = await new Promise<RelayResponse | undefined>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: RelayResponse | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      relay.stdout?.off("data", onData);
      relay.off("error", onError);
      relay.off("exit", onExit);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = stdout.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(stdout.slice(0, nl)) as RelayResponse);
      } catch {
        finish(undefined);
      }
    };
    const onError = () => finish(undefined);
    const onExit = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), WINDOWS_RELAY_HANDSHAKE_TIMEOUT_MS);
    timer.unref();

    relay.stdout?.on("data", onData);
    relay.once("error", onError);
    relay.once("exit", onExit);

    try {
      const payload = JSON.stringify({
        file: launch.command,
        args: launch.args,
        cwd: spawnOptions.cwd,
        env: stringOnlyEnv(spawnOptions.env),
        stderrLogPath: logPath,
        ...(launch.verbatimArguments ? { verbatimArguments: true } : {}),
        ...(launch.noWindow ? { noWindow: true } : {}),
        ...(bindings.modulePath ? { nativePath: bindings.modulePath } : {}),
      });
      relay.stdin?.write(`${payload}\n`);
    } catch {
      finish(undefined);
    }
  });

  if (response === undefined) {
    await endRelayAndWait();
    return undefined;
  }

  if (!response.ok) {
    await endRelayAndWait();
    const error = new Error(response.message ?? "Failed to spawn intercom broker") as NodeJS.ErrnoException;
    if (response.code) error.code = response.code;
    throw error;
  }

  const pid = typeof response.pid === "number" && Number.isInteger(response.pid) && response.pid > 0 ? response.pid : undefined;
  const creationTime = typeof response.creationTime === "string" && response.creationTime.length > 0 ? response.creationTime : undefined;

  // Open a verified watch handle while the relay still holds the broker's handle, so PID reuse is impossible and even
  // an instant startup crash delivers its exact exit code.
  let watched: SpawnedBrokerChild | undefined;
  if (pid !== undefined && creationTime !== undefined && bindings.startHostProcess !== null) {
    watched = watchOrphanedWindowsProcess(bindings.startHostProcess, pid, creationTime);
  }

  // Signal the relay to drop its handle and wait until it has exited, guaranteeing the broker is orphaned from this
  // process's descendant tree before spawn returns.
  await endRelayAndWait();

  if (watched !== undefined) return watched;

  // Fallback when watchPid is unavailable (older native addon or no addon): poll liveness via waitForBroker.
  // #6133: the relay has already exited so no OS handle prevents PID reuse here; keep ONLY a creationTime captured
  // while the relay held the handle, and never read a creation time lazily for an unheld bare PID.
  const started = creationTime;
  const polledIdentity: (() => AnnouncedBroker | undefined) | undefined =
    pid === undefined ? undefined : () => (started === undefined ? { pid } : { pid, started });
  return {
    pid,
    started,
    holdsProcessHandle: false,
    get exitCode() {
      return pid !== undefined && !isProcessAlive(pid) ? -1 : null;
    },
    get signalCode() {
      return null;
    },
    polledIdentity,
    onceError() {},
    offError() {},
    onceExit() {},
    offExit() {},
    killHandle() {},
    release() {},
  };
}

function wrapNodeChildProcess(
  child: ReturnType<typeof spawn>,
  started: string | undefined,
): SpawnedBrokerChild {
  let bufferedError: Error | undefined;
  let bufferedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  const onError = (error: Error) => {
    if (errorListener !== undefined) {
      const listener = errorListener;
      errorListener = undefined;
      listener(error);
    } else {
      bufferedError = error;
    }
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exitListener !== undefined) {
      const listener = exitListener;
      exitListener = undefined;
      listener(code, signal);
    } else {
      bufferedExit = { code, signal };
    }
  };
  child.once("error", onError);
  child.once("exit", onExit);

  return {
    pid: child.pid,
    started,
    holdsProcessHandle: true,
    get exitCode() {
      return child.exitCode ?? bufferedExit?.code ?? null;
    },
    get signalCode() {
      return child.signalCode ?? bufferedExit?.signal ?? null;
    },
    onceError(listener) {
      if (bufferedError !== undefined) {
        const error = bufferedError;
        bufferedError = undefined;
        queueMicrotask(() => listener(error));
        return;
      }
      errorListener = listener;
    },
    offError(listener) {
      if (errorListener === listener) errorListener = undefined;
    },
    onceExit(listener) {
      if (bufferedExit !== undefined) {
        const exit = bufferedExit;
        bufferedExit = undefined;
        queueMicrotask(() => listener(exit.code, exit.signal));
        return;
      }
      exitListener = listener;
    },
    offExit(listener) {
      if (exitListener === listener) exitListener = undefined;
    },
    killHandle() {
      try {
        child.kill("SIGKILL");
      } catch {}
    },
    release() {
      errorListener = undefined;
      exitListener = undefined;
      child.off("error", onError);
      child.off("exit", onExit);
    },
  };
}

/**
 * Start a broker while holding the spawn lock `lockOwner` wrote, and release it, unless a broker still starting takes
 * it over. `recheck` returns at once when a broker answers by now. An aborted `signal` cancels the start before the
 * broker is launched, unless `launchAnyway`, and stops a launched broker that misses its startup timeout (#4727).
 */
async function spawnBrokerHoldingLock(
  lockOwner: string,
  brokerCommand: string,
  brokerArgs: string[],
  readyTimeoutMs: number,
  extensionDir: string,
  recheck: boolean,
  signal?: AbortSignal,
  launchAnyway = false,
): Promise<void> {
  const cancelSignal = launchAnyway ? undefined : signal;
  let keepLock = false;
  try {
    if (recheck && (await isBrokerRunning())) {
      return;
    }
    cancelSignal?.throwIfAborted();

    const resolvedExtensionDir = resolveAgainstCallerCwd(extensionDir);
    const brokerPath = await resolveBrokerEntrypointAsync(resolvedExtensionDir);
    const isCustomPath =
      !usesDefaultBrokerCommand(brokerCommand, brokerArgs) &&
      (/[\\/]/u.test(brokerCommand) || (process.platform === "win32" && /^[A-Za-z]:/u.test(brokerCommand)));
    const normalizedCustomCommand =
      isCustomPath && (process.platform === "win32" ? !isAbsoluteWindowsPath(brokerCommand) : !isAbsolute(brokerCommand))
        ? resolveAgainstCallerCwd(brokerCommand)
        : brokerCommand;
    const initialCommandPath = usesDefaultBrokerCommand(brokerCommand, brokerArgs)
      ? process.execPath
      : normalizedCustomCommand;
    const baseSpawnOptions = await getBrokerSpawnOptionsAsync(
      resolvedExtensionDir,
      "ignore",
      undefined,
      initialCommandPath,
    );
    const effectiveCommand =
      process.platform === "win32" && !usesDefaultBrokerCommand(brokerCommand, brokerArgs)
        ? await resolveWindowsCustomCommandAsync(normalizedCustomCommand, baseSpawnOptions.env)
        : normalizedCustomCommand;
    const launch = getBrokerLaunchSpec(brokerPath, effectiveCommand, brokerArgs, resolvedExtensionDir);
    // Reset before spawning: on Windows an older broker launcher's `cmd.exe` redirect may still hold broker.log
    // briefly after exiting, so wait up to BROKER_LOG_RELEASE_WAIT_MS before concluding a broker is still starting.
    if (!(await resetBrokerLogOnceReleased())) {
      await waitForBroker(readyTimeoutMs, undefined, cancelSignal);
      return;
    }
    // The last point before the broker exists; from here it is waited for, never abandoned while it starts.
    cancelSignal?.throwIfAborted();

    const logPath = resolveAgainstCallerCwd(getBrokerLogPath());
    let logHandle: FileHandle | undefined;
    let child: SpawnedBrokerChild | undefined;
    if (process.platform === "win32") {
      const bindings = loadNativeBrokerSpawnBindings();
      try {
        child = await spawnOrphanedWindowsBrokerAsync(launch, baseSpawnOptions, logPath, bindings);
        if (child === undefined && bindings.startHostProcess !== null) {
          child = wrapNativeDetachedProcess(bindings.startHostProcess, launch, baseSpawnOptions, logPath);
        }
      } catch (error) {
        const cause = toError(error);
        const log = await describeBrokerLogAsync();
        throw new Error(`Failed to spawn intercom broker: ${cause.message}\n${log}`, { cause });
      }
    }
    if (child === undefined) {
      // Direct child_process.spawn path (all POSIX platforms, and Windows fallback if both relay and native spawn are unavailable).
      // Node duplicates the append descriptor during spawn, so the parent copy is closed immediately afterwards rather
      // than being held open for the broker's lifetime.
      logHandle = await open(logPath, "a");
      try {
        const spawnOptions = {
          ...baseSpawnOptions,
          stdio: ["ignore", "ignore", logHandle.fd] as ["ignore", "ignore", number],
          ...(launch.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
        };
        const rawChild = spawn(launch.command, launch.args, spawnOptions);
        rawChild.unref();
        const childStarted =
          process.platform === "win32" && rawChild.pid !== undefined
            ? nativeProcessCreationTime(rawChild.pid)
            : undefined;
        child = wrapNodeChildProcess(rawChild, childStarted);
      } catch (error) {
        await logHandle.close();
        throw error;
      }
    }

    const spawned = child;
    const started = new Promise<void>((resolve, reject) => {
      const cleanup = (releaseHandle = true) => {
        spawned.offError(onError);
        spawned.offExit(onExit);
        if (releaseHandle) spawned.release();
      };

      const onError = (error: Error) => {
        cleanup();
        void describeBrokerLogAsync().then((log) =>
          reject(new Error(`Failed to spawn intercom broker: ${error.message}\n${log}`, { cause: error })),
        );
      };

      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        cleanup();
        if (exitSignal) {
          void describeBrokerLogAsync().then((log) =>
            reject(new Error(`Intercom broker exited before startup with signal ${exitSignal}\n${log}`)),
          );
          return;
        }
        const rejectExitedBeforeStartup = () => {
          void describeBrokerLogAsync().then((log) =>
            reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}\n${log}`)),
          );
        };
        if (code === 0) {
          // A broker that finds a live broker on the socket yields with a clean exit.
          void checkSocketConnectable().then((answering) => (answering ? resolve() : rejectExitedBeforeStartup()));
          return;
        }
        rejectExitedBeforeStartup();
      };

      spawned.onceError(onError);
      spawned.onceExit(onExit);
      // A disposed session stops waiting at once; the broker it launched is then stopped below, so the call still never
      // returns while that broker is writing its start-up files.
      waitForBroker(readyTimeoutMs, spawned.polledIdentity, cancelSignal).then(() => {
        cleanup();
        resolve();
      }, async (error) => {
        // Keep the OS process handle open while stopping or handing off the spawn lock so its PID cannot be recycled.
        cleanup(false);
        try {
          const starting = spawned.exitCode === null && spawned.signalCode === null;
          // #4727 / #6133: the session that launched this broker is gone and the broker did not start in time; stop it
          // (and every descendant it started) before this call returns, never by an unverified bare PID on Windows.
          if (signal?.aborted && starting && spawned.pid !== undefined) {
            let abandoned: StartingBroker | undefined;
            if (process.platform === "win32") {
              // Only query creation time lazily while THIS process still holds the child's OS handle (preventing PID
              // reuse); without a held handle, rely solely on a creation time captured while the relay held the handle.
              // When neither is available, do not kill — leave the broker to its own idle exit, matching main.
              const childStart =
                spawned.started ?? (spawned.holdsProcessHandle ? await readProcessCreationTime(spawned.pid) : undefined);
              if (childStart !== undefined) {
                abandoned = { kind: "announced", pid: spawned.pid, started: childStart };
              } else if (spawned.holdsProcessHandle) {
                abandoned = { kind: "handle", kill: () => spawned.killHandle() };
              }
            } else {
              abandoned = { kind: "group", pid: spawned.pid };
            }
            if (abandoned !== undefined) {
              await stopStartingBroker(abandoned);
            }
            reject(toError(error));
            return;
          }
          // A broker still starting keeps the lock, so later spawners wait for it instead of starting another.
          // Only now does the lock name the broker: until this hand-off it follows this live spawner, so no other
          // spawner can judge it stale and replace it while this one may still release it.
          // On Windows, hand off only when the broker's identity is verified or its OS handle is still held (#6133).
          const canHandOffLock =
            starting && (process.platform !== "win32" || spawned.started !== undefined || spawned.holdsProcessHandle);
          keepLock =
            canHandOffLock &&
            (await handSpawnLockToBrokerAsync(
              spawned.pid,
              lockOwner,
              spawned.started ??
                (spawned.holdsProcessHandle && spawned.pid !== undefined
                  ? await lockProcessStartAsync(spawned.pid)
                  : undefined),
            ));
          reject(toError(error));
        } finally {
          spawned.release();
        }
      });
    });
    try {
      await logHandle?.close();
    } finally {
      await started;
    }
  } finally {
    if (!keepLock) await releaseSpawnLockAsync(lockOwner);
  }
}

/** Bound on waiting for a killed, still-starting broker to be gone; a kill that has not taken by then never will. */
const STARTING_BROKER_KILL_WAIT_MS = 5_000;
/** A killed process is gone within milliseconds, and a session that is closing waits for it. */
const STARTING_BROKER_KILL_POLL_MS = 10;

/** A broker that has not started listening, as the spawner that launched it finds it. */
type StartingBroker =
  /**
   * Spawned directly and detached on POSIX, so it leads a process group of its own. A custom broker command can run the
   * broker as its own child rather than replacing itself with it; the group holds both.
   */
  | { readonly kind: "group"; readonly pid: number }
  /** Windows: verified by the process's pid and kernel creation time, so descendants are ended without PID-reuse risk. */
  | { readonly kind: "announced"; readonly pid: number; readonly started: string }
  /** Windows last-resort fallback when neither native nor PowerShell could read creation time: kill through the live child handle. */
  | { readonly kind: "handle"; readonly kill: () => void };

/**
 * Kill a broker that has not started listening, with every process it started, and wait until they are gone.
 *
 * #6133: on Windows the broker is ended only through a handle verified against its creation time
 * ({@link stopWindowsProcess}) or directly through the live child handle, never by its pid alone.
 */
async function stopStartingBroker(broker: StartingBroker): Promise<void> {
  if (broker.kind === "announced") {
    return stopWindowsProcess(broker.pid, broker.started, { waitMs: STARTING_BROKER_KILL_WAIT_MS, descendants: true });
  }
  if (broker.kind === "handle") {
    broker.kill();
    return;
  }
  const deadline = Date.now() + STARTING_BROKER_KILL_WAIT_MS;
  try {
    process.kill(-broker.pid, "SIGKILL");
  } catch {
    return;
  }
  while (isProcessAlive(-broker.pid) && Date.now() < deadline) await sleep(STARTING_BROKER_KILL_POLL_MS);
}

/** How often a session waiting to upgrade the broker checks whether the spawn lock is free. */
const UPGRADE_LOCK_POLL_MS = 50;

/** What {@link upgradeBroker} did. */
export type BrokerUpgradeOutcome =
  /** An older broker was stopped and this version's broker started in its place. */
  | "upgraded"
  /** No broker was running, so this version's broker was started. */
  | "started"
  /** The running broker needs no upgrade (another session replaced it first, or it is not older), or reports no readable status. */
  | "current"
  /**
   * The running broker reads another shared storage selection than a successor started from this process would, so
   * replacing it would change how its sessions route; it is left running.
   */
  | "storage-differs"
  /** Another process held the spawn lock for the whole wait; nothing was done. */
  | "busy";

/**
 * #4538: replace an older broker with this version's, using the hand-over every session already performs when its
 * broker retires: the older broker shuts down, its sessions reconnect, and they register with the successor. The spawn
 * lock is held from before the shutdown until the successor answers, so a reconnecting session of the older version
 * waits for the successor instead of starting its own older broker again, and sessions of this version that start
 * together replace the broker once. Under the lock the broker is checked again, so a session that waited finds it
 * already replaced. The lock is written again while the older broker exits, so it never looks stale to a spawner of
 * either version, for up to `stopTimeoutMs`; if the older broker is still running then, the lock names its process
 * instead, so no spawner starts a broker while that process lives, until the lock ages out
 * ({@link BROKER_SPAWN_LOCK_MAX_AGE_MS} after its last renewal, about a minute). Once the process exits or the lock ages
 * out, the next spawner of either version takes it, so an older session can start an older broker, which the next
 * session of this version replaces again. A failure to stop the older broker, or to start the successor once it
 * stopped, is an {@link IntercomBrokerUpgradeError} whose cause is that step's failure. `signal` cancels the upgrade
 * until it asks the running broker to shut down, including its wait for the spawn lock, and a start where none is
 * running as {@link spawnBrokerIfNeeded} does; once the running broker is asked to stop, the successor is launched
 * regardless and stopped only if it then misses its startup timeout (#4727).
 */
export async function upgradeBroker(
  brokerCommand: string,
  brokerArgs: string[],
  readyTimeoutMs: number = BROKER_READY_TIMEOUT_MS,
  extensionDir: string = EXTENSION_DIR,
  own: BrokerProtocolRange = BROKER_PROTOCOL,
  stopTimeoutMs: number = BROKER_UPGRADE_STOP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<BrokerUpgradeOutcome> {
  signal?.throwIfAborted();
  await ensurePrivateDirectoryAsync(getIntercomDirPath());
  const acquired = await acquireSpawnLockWithin(readyTimeoutMs + stopTimeoutMs, signal);
  if (acquired === undefined) return "busy";
  let lockOwner = acquired;
  let lockPassedOn = false;
  const spawnHoldingLock = (launchAnyway: boolean): Promise<void> => {
    lockPassedOn = true;
    return spawnBrokerHoldingLock(lockOwner, brokerCommand, brokerArgs, readyTimeoutMs, extensionDir, false, signal, launchAnyway);
  };
  try {
    const socketPath = await getBrokerSocketPathAsync();
    const answer = await controlRequest(socketPath, "broker_status", "broker_status", BROKER_CONTROL_TIMEOUT_MS);
    if (!answer.connected) {
      await spawnHoldingLock(false);
      return "started";
    }
    const reply = answer.reply;
    const report =
      typeof reply === "object" && reply !== null && !Array.isArray(reply) && isBrokerStatusReport(reply.report)
        ? reply.report
        : undefined;
    if (report === undefined) return "current";
    const running = protocolRangeOf(report.protocol);
    if (decideBrokerProtocol(own, running) !== "upgrade") return "current";
    if (report.storage?.digest !== (await successorStorageDigestAsync())) return "storage-differs";
    const failed = (phase: "stop" | "start", cause?: Error): IntercomBrokerUpgradeError =>
      new IntercomBrokerUpgradeError({ phase, previousPid: report.pid, previousProtocolMax: running.max }, { cause });
    // #4727: a cancelled upgrade leaves the running broker alone; one that has asked it to shut down launches its
    // successor whatever happens, so the broker's other sessions have one to reconnect to. Only a successor that then
    // misses its startup timeout is stopped once the upgrade is cancelled.
    signal?.throwIfAborted();
    // Started before the shutdown request, which does not wait for it: the broker removes broker.pid when it exits. The
    // wait ends once the pid names a later process, and a broker still running at the bound keeps the lock only while
    // its pid names it.
    const found = identifyBrokerProcessAsync(report.pid, getBrokerPidPath());
    let foundStart: string | undefined;
    void found.then((broker) => {
      foundStart = foundBrokerStart(broker);
    });
    if ((await requestBrokerShutdown(socketPath)) === "unanswered") throw failed("stop");
    let lockLost = false;
    try {
      await waitForBrokerExit(
        report.pid,
        stopTimeoutMs,
        async () => {
          if (lockLost) return;
          const renewed = await renewSpawnLockAsync(lockOwner);
          if (renewed === undefined) lockLost = true;
          else lockOwner = renewed;
        },
        found,
        // Polls read the pid's start only where that starts no process; elsewhere broker.pid's verdict and liveness decide.
        readProcessStartWithoutProcess,
      );
    } catch (error) {
      if (isIntercomBrokerStopTimeoutError(error)) {
        // Only a start read while this broker held its pid names it; without one the lock follows the pid, as before.
        lockPassedOn = await handSpawnLockToBrokerAsync(report.pid, lockOwner, foundStart);
        throw failed("stop", error);
      }
      throw error;
    }
    if (lockLost) {
      lockPassedOn = true;
      throw failed("start", new Error("The broker spawn lock was taken over by another process while the older broker exited."));
    }
    try {
      await spawnHoldingLock(true);
    } catch (error) {
      throw failed("start", toError(error));
    }
    return "upgraded";
  } finally {
    if (!lockPassedOn) await releaseSpawnLockAsync(lockOwner);
  }
}

/** The digest of the shared storage selection a broker started from this process reads, as its `broker_status` reports it. */
async function successorStorageDigestAsync(): Promise<string | undefined> {
  const setting = await readSharedStorageSettingAsync(dirname(getIntercomDirPath()), {
    [BROKER_STORAGE_ENV]: (await processSharedStorageSelectionAsync()) ?? "",
  });
  return setting === undefined ? undefined : sharedStorageDigest(setting);
}

/** Take the spawn lock, waiting up to `boundMs` while another process holds it; an aborted `signal` ends the wait. */
async function acquireSpawnLockWithin(boundMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    signal?.throwIfAborted();
    const owner = await acquireSpawnLockAsync();
    if (owner !== undefined || Date.now() >= deadline) return owner;
    await sleep(UPGRADE_LOCK_POLL_MS);
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  try {
    const pid = parseInt((await readFile(getBrokerPidPath(), "utf-8")).trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

async function checkSocketConnectable(): Promise<boolean> {
  return isSocketAnswering(await getBrokerSocketPathAsync());
}

/**
 * Records the still-starting broker on the lock so staleness follows that process instead of the spawner: its pid, and
 * when it started where that was read while it held the pid, so the lock does not follow a later process the OS gives
 * the pid. Without `started` the lock follows the pid alone.
 */
async function handSpawnLockToBrokerAsync(pid: number | undefined, owner: string, started: string | undefined): Promise<boolean> {
  if (pid === undefined) return false;
  const lockPath = getBrokerSpawnLockPath();
  return underSpawnLockMutexAsync(lockPath, false, async () => {
    if (!(await ownsSpawnLockAsync(owner, lockPath))) return false;
    try {
      await appendFile(lockPath, `${lockProcessLine(pid, started)}\n`);
      return true;
    } catch {
      return false;
    }
  });
}

const SPAWN_LOCK_MUTEX_WAIT_MS = 2_000;

function underSpawnLockMutex<T>(lockPath: string, busy: T, act: () => T): T {
  const mutex = takeTakeoverMutex(lockPath, SPAWN_LOCK_MUTEX_WAIT_MS);
  if (mutex === undefined) return busy;
  try {
    return mutex.owned() ? act() : busy;
  } finally {
    mutex.release();
  }
}

async function underSpawnLockMutexAsync<T>(lockPath: string, busy: T, act: () => Promise<T>): Promise<T> {
  const mutex = await takeTakeoverMutexAsync(lockPath, SPAWN_LOCK_MUTEX_WAIT_MS);
  if (mutex === undefined) return busy;
  try {
    return (await mutex.owned()) ? await act() : busy;
  } finally {
    await mutex.release();
  }
}

/** How old a spawn lock held across a long wait may grow before it is written again; it is stale past {@link BROKER_SPAWN_LOCK_MAX_AGE_MS}. */
const SPAWN_LOCK_RENEW_AFTER_MS = 10_000;

export function renewSpawnLock(
  owner: string,
  nowMs: number = Date.now(),
  lockPath: string = getBrokerSpawnLockPath(),
): string | undefined {
  const writtenAt = Number.parseInt(owner.split("\n")[1] ?? "", 10);
  if (nowMs - writtenAt < SPAWN_LOCK_RENEW_AFTER_MS) return owner;
  return underSpawnLockMutex<string | undefined>(lockPath, owner, () => {
    const current = readFileOrUndefined(lockPath);
    if (current === undefined) return existsSync(lockPath) ? owner : undefined;
    if (!current.startsWith(owner)) return undefined;
    const renewed = `${ownLockProcessLine()}\n${nowMs}\n`;
    const staged = `${lockPath}.${process.pid}.renew`;
    try {
      writeFileSync(staged, renewed);
      renameWithRetry(staged, lockPath);
      return renewed;
    } catch {
      try {
        unlinkSync(staged);
      } catch {}
      return owner;
    }
  });
}

export async function renewSpawnLockAsync(
  owner: string,
  nowMs: number = Date.now(),
  lockPath: string = getBrokerSpawnLockPath(),
): Promise<string | undefined> {
  const writtenAt = Number.parseInt(owner.split("\n")[1] ?? "", 10);
  if (nowMs - writtenAt < SPAWN_LOCK_RENEW_AFTER_MS) return owner;
  return underSpawnLockMutexAsync<string | undefined>(lockPath, owner, async () => {
    const current = await readFileOrUndefinedAsync(lockPath);
    if (current === undefined) return (await pathExists(lockPath)) ? owner : undefined;
    if (!current.startsWith(owner)) return undefined;
    const renewed = `${await ownLockProcessLineAsync()}\n${nowMs}\n`;
    const staged = `${lockPath}.${process.pid}.renew`;
    try {
      await writeFile(staged, renewed);
      await renameWithRetryAsync(staged, lockPath);
      return renewed;
    } catch {
      try {
        await unlink(staged);
      } catch {}
      return owner;
    }
  });
}

const OWNERSHIP_READ_RETRY_BUDGET_MS = 2_000;
const OWNERSHIP_READ_BACKOFF_START_MS = 10;
const OWNERSHIP_READ_BACKOFF_MAX_MS = 100;
const TRANSIENT_OWNERSHIP_READ_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EBUSY"]);
const ownershipReadSleeper = new Int32Array(new SharedArrayBuffer(4));

type OwnershipRead = "owned" | "other" | "unreadable";

function readOwnership(owner: string, lockPath: string): OwnershipRead {
  const started = performance.now();
  let backoff = OWNERSHIP_READ_BACKOFF_START_MS;
  for (;;) {
    try {
      return readFileSync(lockPath, "utf-8").startsWith(owner) ? "owned" : "other";
    } catch (error) {
      if (!TRANSIENT_OWNERSHIP_READ_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return "other";
      if (performance.now() - started + backoff > OWNERSHIP_READ_RETRY_BUDGET_MS) return "unreadable";
      Atomics.wait(ownershipReadSleeper, 0, 0, backoff);
      backoff = Math.min(backoff + OWNERSHIP_READ_BACKOFF_START_MS, OWNERSHIP_READ_BACKOFF_MAX_MS);
    }
  }
}

async function readOwnershipAsync(owner: string, lockPath: string): Promise<OwnershipRead> {
  const started = performance.now();
  let backoff = OWNERSHIP_READ_BACKOFF_START_MS;
  for (;;) {
    try {
      return (await readFile(lockPath, "utf-8")).startsWith(owner) ? "owned" : "other";
    } catch (error) {
      if (!TRANSIENT_OWNERSHIP_READ_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return "other";
      if (performance.now() - started + backoff > OWNERSHIP_READ_RETRY_BUDGET_MS) return "unreadable";
      await sleep(backoff);
      backoff = Math.min(backoff + OWNERSHIP_READ_BACKOFF_START_MS, OWNERSHIP_READ_BACKOFF_MAX_MS);
    }
  }
}

function ownsSpawnLock(owner: string, lockPath: string = getBrokerSpawnLockPath()): boolean {
  return readOwnership(owner, lockPath) === "owned";
}

async function ownsSpawnLockAsync(owner: string, lockPath: string = getBrokerSpawnLockPath()): Promise<boolean> {
  return (await readOwnershipAsync(owner, lockPath)) === "owned";
}

/** Returns the header this spawner wrote, which proves ownership on release, or undefined when another spawner holds the lock. */
export function acquireSpawnLock(lockPath: string = getBrokerSpawnLockPath()): string | undefined {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const writtenAt = Date.now();
    const owner = `${ownLockProcessLine()}\n${writtenAt}\n`;
    if (createLockFile(lockPath, owner)) {
      const ownership = readOwnership(owner, lockPath);
      if (ownership === "owned") {
        const nowMs = Date.now();
        if (nowMs - writtenAt < SPAWN_LOCK_RENEW_AFTER_MS) return owner;
        const renewed = renewSpawnLock(owner, nowMs, lockPath);
        if (renewed !== undefined && renewed !== owner) return renewed;
      }
      releaseSpawnLock(owner, lockPath);
      if (ownership === "unreadable") return undefined;
      continue;
    }
    const inspected = readFileOrUndefined(lockPath);
    if (!isSpawnLockReplaceable(inspected, lockPath)) return undefined;
    replaceStaleSpawnLock(inspected, lockPath);
  }
  return undefined;
}

export async function acquireSpawnLockAsync(
  lockPath: string = getBrokerSpawnLockPath(),
): Promise<string | undefined> {
  const maxRetries = 5;
  const ownLine = await ownLockProcessLineAsync();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const writtenAt = Date.now();
    const owner = `${ownLine}\n${writtenAt}\n`;
    if (await createLockFileAsync(lockPath, owner)) {
      const ownership = await readOwnershipAsync(owner, lockPath);
      if (ownership === "owned") {
        const nowMs = Date.now();
        if (nowMs - writtenAt < SPAWN_LOCK_RENEW_AFTER_MS) return owner;
        const renewed = await renewSpawnLockAsync(owner, nowMs, lockPath);
        if (renewed !== undefined && renewed !== owner) return renewed;
      }
      await releaseSpawnLockAsync(owner, lockPath);
      if (ownership === "unreadable") return undefined;
      continue;
    }
    const inspected = await readFileOrUndefinedAsync(lockPath);
    if (!(await isSpawnLockReplaceableAsync(inspected, lockPath))) return undefined;
    await replaceStaleSpawnLockAsync(inspected, lockPath);
  }
  return undefined;
}

function isSpawnLockReplaceable(written: string | undefined, lockPath: string): boolean {
  const content = completeLines(written) ?? "";
  if (!isSpawnLockContentStale(content)) return false;
  const writer = writerState(lockPath, written) ?? (recordsSpawner(content) ? "abandoned" : "unknown");
  if (writer === "unknown" && unknownHolderWaitedOut(lockPath, written)) warnUnknownSpawnLockHolder(lockPath);
  return writer === "abandoned";
}

async function isSpawnLockReplaceableAsync(written: string | undefined, lockPath: string): Promise<boolean> {
  const content = completeLines(written) ?? "";
  if (!(await isSpawnLockContentStaleAsync(content))) return false;
  const writer = (await writerStateAsync(lockPath, written)) ?? (recordsSpawner(content) ? "abandoned" : "unknown");
  if (writer === "unknown" && (await unknownHolderWaitedOutAsync(lockPath, written))) {
    await warnUnknownSpawnLockHolderAsync(lockPath);
  }
  return writer === "abandoned";
}

const warnedUnknownHolder = new Set<string>();

function warnUnknownSpawnLockHolder(lockPath: string): void {
  if (warnedUnknownHolder.has(lockPath)) return;
  warnedUnknownHolder.add(lockPath);
  process.emitWarning(unknownHolderAdvice(lockPath));
}

async function warnUnknownSpawnLockHolderAsync(lockPath: string): Promise<void> {
  if (warnedUnknownHolder.has(lockPath)) return;
  warnedUnknownHolder.add(lockPath);
  process.emitWarning(await unknownHolderAdviceAsync(lockPath));
}

export function replaceStaleSpawnLock(inspected: string | undefined, lockPath: string = getBrokerSpawnLockPath()): void {
  takeOverStaleLock(
    lockPath,
    inspected,
    (current) => isSpawnLockReplaceable(current, lockPath),
    () => takeTakeoverMutex(lockPath),
  );
}

export async function replaceStaleSpawnLockAsync(
  inspected: string | undefined,
  lockPath: string = getBrokerSpawnLockPath(),
): Promise<void> {
  await takeOverStaleLockAsync(
    lockPath,
    inspected,
    (current) => isSpawnLockReplaceableAsync(current, lockPath),
    () => takeTakeoverMutexAsync(lockPath),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock is stale once the broker it recorded is gone, or, while no broker is recorded, once its
 * spawner is gone. A live broker keeps the lock even if its spawner died, until the age backstop.
 * A process is gone also when its pid names a process with another start than the lock recorded for it.
 */
export function isSpawnLockStale(lockPath: string = getBrokerSpawnLockPath(), nowMs: number = Date.now()): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }
  return isSpawnLockContentStale(readFileOrUndefined(lockPath) ?? "", nowMs);
}

function recordsSpawner(content: string): boolean {
  const [spawnerLine = "", createdAtLine = ""] = content.split("\n");
  return Number.isFinite(Number.parseInt(spawnerLine, 10)) && Number.isFinite(Number.parseInt(createdAtLine, 10));
}

function isSpawnLockContentStale(content: string, nowMs: number = Date.now()): boolean {
  const named = lockedProcessLine(content, nowMs);
  return named === undefined || lockProcessGone(named, lockProcessStart);
}

async function isSpawnLockContentStaleAsync(content: string, nowMs: number = Date.now()): Promise<boolean> {
  const named = lockedProcessLine(content, nowMs);
  return named === undefined || lockProcessGone(named, await startReaderAsync(named));
}

/** The line of the process a lock follows (its broker, else its spawner), or undefined for a malformed or aged lock. */
function lockedProcessLine(content: string, nowMs: number): string | undefined {
  const [spawnerLine = "", createdAtLine = "", brokerLine = ""] = content.split("\n");
  const spawnerPid = Number.parseInt(spawnerLine, 10);
  const createdAt = Number.parseInt(createdAtLine, 10);
  const brokerPid = Number.parseInt(brokerLine, 10);

  if (!Number.isFinite(spawnerPid) || !Number.isFinite(createdAt)) return undefined;
  if (nowMs - createdAt > BROKER_SPAWN_LOCK_MAX_AGE_MS) return undefined;
  return Number.isFinite(brokerPid) ? brokerLine : spawnerLine;
}

/**
 * The start the spawn lock records beside a pid: read without starting a process (Linux `/proc`, the Windows native
 * module, and on macOS the broker's own native reader), so taking the lock never waits on one; undefined elsewhere, or
 * with a host that has no such reader, where the lock follows the pid alone.
 */
function lockProcessStart(pid: number): string | undefined {
  if (process.platform === "linux") return processStartToken(pid);
  if (process.platform === "win32") return nativeProcessCreationTime(pid);
  if (process.platform === "darwin") return processCreationTimeOf(pid);
  return undefined;
}

/** {@link lockProcessStart} without blocking the event loop. */
async function lockProcessStartAsync(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return readProcessStartToken(pid);
  if (process.platform === "win32") return nativeProcessCreationTime(pid);
  if (process.platform === "darwin") return processCreationTimeOf(pid);
  return undefined;
}

/** A reader answering with the start of the process `line` names, read ahead without blocking the event loop. */
async function startReaderAsync(line: string): Promise<(pid: number) => string | undefined> {
  const pid = Number.parseInt(line, 10);
  const started = line.includes(" ") ? await lockProcessStartAsync(pid) : undefined;
  return () => started;
}

/**
 * A process as the spawn lock names it: `<pid>` or `<pid> <start>`. Spawners of earlier versions read the leading pid
 * and ignore the start.
 */
function lockProcessLine(pid: number, started: string | undefined): string {
  return started === undefined ? String(pid) : `${pid} ${started}`;
}

let ownLine: string | undefined;

function ownLockProcessLine(): string {
  ownLine ??= lockProcessLine(process.pid, lockProcessStart(process.pid));
  return ownLine;
}

async function ownLockProcessLineAsync(): Promise<string> {
  ownLine ??= lockProcessLine(process.pid, await lockProcessStartAsync(process.pid));
  return ownLine;
}

/** The start a found broker is recorded with: only one read while that broker held its pid. */
function foundBrokerStart(found: BrokerProcess): string | undefined {
  // Read as the spawn lock reads a start (`lockProcessStart`), so a lock line and a found broker never differ in form.
  if (process.platform === "linux" || process.platform === "darwin") return found.started;
  if (process.platform === "win32" && found.wroteBrokerPid === "yes") return found.started;
  return undefined;
}

/**
 * Whether the process a lock line names is gone: its pid is not alive, or names a process whose start, where it can be
 * read, is not the one recorded. A start that cannot be read, or none recorded, leaves the pid's liveness to decide.
 */
function lockProcessGone(line: string, readStart: (pid: number) => string | undefined): boolean {
  const pid = Number.parseInt(line, 10);
  if (!isProcessAlive(pid)) return true;
  if (!line.includes(" ")) return false;
  // A start in a form this reader does not recognise is read as none recorded: the pid alone decides.
  const recorded = recognisedProcessStart(line.slice(line.indexOf(" ") + 1));
  if (recorded === undefined || recorded === "") return false;
  const current = readStart(pid);
  return current !== undefined && current !== recorded;
}

/** Removes the lock only while it is still the one `owner` wrote; a spawner that replaced a stale lock keeps its own. */
export function releaseSpawnLock(owner: string, lockPath: string = getBrokerSpawnLockPath()): void {
  if (!ownsSpawnLock(owner, lockPath)) return;
  underSpawnLockMutex(lockPath, undefined, () => {
    if (!ownsSpawnLock(owner, lockPath)) return;
    try {
      unlinkSync(lockPath);
    } catch {}
  });
}

export async function releaseSpawnLockAsync(
  owner: string,
  lockPath: string = getBrokerSpawnLockPath(),
): Promise<void> {
  if (!(await ownsSpawnLockAsync(owner, lockPath))) return;
  await underSpawnLockMutexAsync(lockPath, undefined, async () => {
    if (!(await ownsSpawnLockAsync(owner, lockPath))) return;
    try {
      await unlink(lockPath);
    } catch {}
  });
}

/**
 * Poll the broker socket with a short initial interval and bounded exponential backoff.
 * Startup is tens of milliseconds, so the previous flat 100 ms sleep dominated it; the
 * overall timeout semantics are unchanged.
 *
 * `announced` reports the pid of a broker this spawner cannot watch directly (behind the Windows launcher), and when
 * that process was created, once the broker has announced them. A broker whose pid is gone, or now names a process
 * created at another time (Windows gives the pid of an exited process to another within seconds), and that does not
 * answer has crashed, and the wait ends at once: only a broker that is alive and not yet listening is waited for the
 * whole budget. The creation time is read beside the polls, never holding one up; one that cannot be read proves
 * nothing either way.
 */
export async function waitForBroker(
  timeoutMs = BROKER_READY_TIMEOUT_MS,
  announced?: () => AnnouncedBroker | undefined | Promise<AnnouncedBroker | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  let interval = BROKER_POLL_INITIAL_INTERVAL_MS;
  let watched: { readonly broker: BrokerProcess; readonly isLater: () => boolean } | undefined;
  while (Date.now() - start < timeoutMs) {
    signal?.throwIfAborted();
    if (await checkSocketConnectable()) {
      return;
    }
    const broker = await announced?.();
    if (broker !== undefined) {
      if (watched?.broker.pid !== broker.pid || watched.broker.started !== broker.started) {
        const found: BrokerProcess = { pid: broker.pid, started: broker.started, wroteBrokerPid: "unknown" };
        watched = { broker: found, isLater: laterProcessProbe(found) };
      }
      if (!isProcessAlive(broker.pid) || watched.isLater()) {
        // A broker that finds a live broker on the socket yields and exits; that one answering is a success.
        if (await checkSocketConnectable()) return;
        throw new Error(`Intercom broker exited before startup (pid ${broker.pid})\n${await describeBrokerLogAsync()}`);
      }
    }
    await sleep(interval, signal);
    interval = Math.min(interval * 2, BROKER_POLL_MAX_INTERVAL_MS);
  }
  throw await brokerStartTimeoutError(timeoutMs);
}

async function brokerStartTimeoutError(timeoutMs: number): Promise<Error> {
  return new Error(
    `Broker failed to start within timeout (${timeoutMs} ms)\n`
      + "The broker did not answer on its socket in time; it may still be starting, which a busy machine or an empty jiti "
      + "cache slows. Try again, or raise `brokerStartupTimeoutMs` in the Intercom config.json (default "
      + `${BROKER_READY_TIMEOUT_MS} ms).\n${await describeBrokerLogAsync()}`,
  );
}
