import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "fs";
import { appendFile, chmod, type FileHandle, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "path";
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
  type BrokerStartAnnouncement,
  readBrokerStartAnnouncementAsync,
} from "./start-announcement.js";
import {
  createChildProcessEnvironment,
  IntercomBrokerUpgradeError,
  isBunBinary,
  isIntercomBrokerStopTimeoutError,
  processSharedStorageSelection,
  processSharedStorageSelectionAsync,
  readProcessCreationTime,
  takeTakeoverMutex,
  takeTakeoverMutexAsync,
} from "@bastani/atomic";
import { hostCommandEnvironment } from "./host-command-environment.js";
import { isBrokerStatusReport } from "./broker-status.js";
import { BROKER_UPGRADE_STOP_TIMEOUT_MS, requestBrokerShutdown, waitForBrokerExit } from "./broker-stop.js";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "./control-request.js";
import { BROKER_PROTOCOL, type BrokerProtocolRange, decideBrokerProtocol, protocolRangeOf } from "./protocol-version.js";
import { readSharedStorageSettingAsync, sharedStorageDigest } from "./shared-storage-setting.js";
import {
  BROKER_STORAGE_ENV,
  getBrokerStartAnnouncementPath,
  getBrokerLogPath,
  getBrokerPidPath,
  getBrokerSocketPathAsync,
  getBrokerSpawnLockPath,
  getIntercomDirPath,
} from "./paths.js";
import { pathExists } from "../path-exists.js";


/** Package root whether this module is `broker/spawn.ts` or the installed `index.bundle.mjs`. */
export function resolveIntercomPackageRoot(moduleHref: string): string {
  const here = dirname(fileURLToPath(moduleHref));
  return basename(here) === "broker" ? join(here, "..") : here;
}

export function resolveBrokerEntrypoint(packageRoot: string): string {
  const bundled = join(packageRoot, "broker", "broker.bundle.mjs");
  return existsSync(bundled) ? bundled : join(packageRoot, "broker", "broker.ts");
}

export async function resolveBrokerEntrypointAsync(packageRoot: string): Promise<string> {
  const bundled = join(packageRoot, "broker", "broker.bundle.mjs");
  return (await pathExists(bundled)) ? bundled : join(packageRoot, "broker", "broker.ts");
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

type BrokerLaunchSpec =
  | {
    kind: "direct";
    command: string;
    args: string[];
  }
  | {
    kind: "windows-launcher";
    command: string;
    args: string[];
    launcherPath: string;
    launcherCommandLine: string;
  };

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
  try {
    const jitiPackage = requireFromExtensionDir(extensionDir).resolve("jiti/package.json");
    return join(dirname(jitiPackage), "lib", "jiti-cli.mjs");
  } catch {
    return join(extensionDir, "node_modules", "jiti", "lib", "jiti-cli.mjs");
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

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function getWindowsHiddenLauncherPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "broker-launch.vbs");
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
}

export function getWindowsBrokerCommandLine(
  brokerPath: string,
  extensionDir: string = EXTENSION_DIR,
  nodePath: string = process.execPath,
  brokerCommand = "npx",
  brokerArgs: string[] = ["--no-install", "tsx"],
  runtime: BrokerRuntime = getCurrentBrokerRuntime(),
): string {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    const launch = getDefaultBrokerCommandParts(brokerPath, extensionDir, nodePath, runtime);
    return [quoteWindowsArg(launch.command), ...launch.args.map(quoteWindowsArg)].join(" ");
  }

  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}

/**
 * `WshShell.Run` does not hand the launched process the parent's standard handles, so a file
 * descriptor passed to `wscript.exe` would only ever capture the launcher. Run the broker under
 * `cmd.exe /s /c` instead and append its stderr to the same log the direct path writes.
 * `/s` makes cmd strip exactly the outer quote pair and use the remainder verbatim.
 *
 * Returns the command line unchanged when it contains a `%`. cmd expands `%NAME%` at parse time
 * and there is no reliable way to escape a literal percent on a `cmd /c` command line — `^` does
 * not cover it, and `%%` is a batch-file escape rather than a command-line one. Wrapping such a
 * command would hand the broker different arguments than the user configured, so the redirect is
 * dropped instead: launching correctly without a captured log beats launching wrongly with one.
 * A `%` reaches here only from a custom `brokerCommand`/`brokerArgs` or an install path that
 * contains one, and the direct (non-launcher) Windows path still captures stderr normally.
 *
 * Nothing may follow the broker in this chain: after the broker's process ends, the resident `cmd.exe` must do no
 * file I/O, because tests, `atomic intercom restart` and users remove the intercom directory the moment the broker
 * is gone, and a file the chain creates there then fails that removal (the marker an earlier version appended made
 * every Windows test that kills a broker and removes its directory fail with ENOTEMPTY). The broker's own start-up
 * announcement (`start-announcement.ts`) is how the parent learns that a broker it cannot watch has exited.
 */
export function getWindowsStderrRedirectCommandLine(commandLine: string, logPath: string): string {
  if (commandLine.includes("%")) return commandLine;
  return `cmd.exe /s /c "${commandLine} 2>>${quoteWindowsArg(logPath)}"`;
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    'Set WshShell = Nothing',
    '',
  ].join("\r\n");
}

async function writeWindowsHiddenLauncherAsync(
  commandLine: string,
  launcherPath: string = getWindowsHiddenLauncherPath(),
): Promise<string> {
  await ensurePrivateDirectoryAsync(dirname(launcherPath));
  await writeFile(launcherPath, getWindowsHiddenLauncherScript(commandLine), "utf-8");
  return launcherPath;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  platform: NodeJS.Platform = process.platform,
  intercomDir: string = getIntercomDirPath(),
  nodePath: string = process.execPath,
  runtime: BrokerRuntime = getCurrentBrokerRuntime(),
  logPath: string = getBrokerLogPath(),
): BrokerLaunchSpec {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsStderrRedirectCommandLine(
        getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs, runtime),
        logPath,
      ),
    };
  }

  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    const launch = getDefaultBrokerCommandParts(brokerPath, extensionDir, nodePath, runtime);
    return {
      kind: "direct",
      command: launch.command,
      args: launch.args,
    };
  }

  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
  };
}

/**
 * The broker is detached and outlives this process, so its stderr goes to an already-open file
 * descriptor rather than a pipe: a long-lived pipe would keep the parent's event loop attached
 * and break once the parent exits.
 *
 * The broker routes through the shared storage this process was launched with (`--storage`,
 * `--storage-file` or `ATOMIC_STORAGE`), passed as `ATOMIC_STORAGE`; without one it reads settings.
 * With `announcement` it also gets the file and token it announces its pid with, and asks it to add when it was created
 * (`start-announcement.ts`).
 */
function buildBrokerSpawnOptions(
  storage: string | undefined,
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
): {
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    cwd: extensionDir,
    env: createChildProcessEnvironment({
      NODE_NO_WARNINGS: "1",
      ...(storage === undefined ? {} : { [BROKER_STORAGE_ENV]: storage }),
      ...(announcement === undefined
        ? {}
        : {
            [BROKER_ANNOUNCE_PATH_ENV]: announcement.path,
            [BROKER_ANNOUNCE_TOKEN_ENV]: announcement.token,
            [BROKER_ANNOUNCE_START_ENV]: "1",
          }),
    }),
    windowsHide: true,
  };
}

export function getBrokerSpawnOptions(
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
): {
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return buildBrokerSpawnOptions(processSharedStorageSelection(), extensionDir, stderr, announcement);
}

export async function getBrokerSpawnOptionsAsync(
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
  announcement?: BrokerStartAnnouncement,
): Promise<{
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
}> {
  return buildBrokerSpawnOptions(await processSharedStorageSelectionAsync(), extensionDir, stderr, announcement);
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

    const brokerPath = await resolveBrokerEntrypointAsync(extensionDir);
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, extensionDir);
    // The Windows launcher hides the broker's pid and exit, so there the broker announces its pid, which this watches.
    // Elsewhere the child is the broker and its exit event says how it ended.
    const announcement: BrokerStartAnnouncement | undefined =
      launch.kind === "windows-launcher" ? { path: getBrokerStartAnnouncementPath(), token: randomUUID() } : undefined;
    if (announcement !== undefined) {
      try {
        await unlink(announcement.path);
      } catch {
        // None left by an earlier broker, or not removable: its token is not this spawn's, so it is ignored.
      }
    }
    if (launch.kind === "windows-launcher") {
      await writeWindowsHiddenLauncherAsync(launch.launcherCommandLine, launch.launcherPath);
    }
    // Reset before spawning either way: the Windows launcher appends to this same path.
    if (!(await resetBrokerLogOnceReleased())) {
      await waitForBroker(readyTimeoutMs, undefined, cancelSignal);
      return;
    }
    // The last point before the broker exists; from here it is waited for, never abandoned while it starts.
    cancelSignal?.throwIfAborted();
    // The Windows launcher redirects the broker's own stderr, so only the direct spawn
    // needs the descriptor. Node duplicates it during spawn, so the parent copy is closed
    // immediately afterwards rather than being held open for the broker's lifetime.
    const logHandle = launch.kind === "direct" ? await open(getBrokerLogPath(), "a") : undefined;
    let child: ReturnType<typeof spawn>;
    try {
      const spawnOptions = await getBrokerSpawnOptionsAsync(extensionDir, logHandle?.fd ?? "ignore", announcement);
      child = spawn(
        launch.command,
        launch.args,
        spawnOptions,
      );
    } catch (error) {
      await logHandle?.close();
      throw error;
    }
    child.unref();

    const started = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        void describeBrokerLogAsync().then((log) =>
          reject(new Error(`Failed to spawn intercom broker: ${error.message}\n${log}`, { cause: error })),
        );
      };

      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (launch.kind === "windows-launcher" && code === 0 && exitSignal === null) {
          return;
        }
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

      child.once("error", onError);
      child.once("exit", onExit);
      // A disposed session stops waiting at once; the broker it launched is then stopped below, so the call still never
      // returns while that broker is writing its start-up files.
      waitForBroker(
        readyTimeoutMs,
        announcement === undefined
          ? undefined
          : async () => (await readBrokerStartAnnouncementAsync(announcement))?.pid,
        cancelSignal,
      ).then(() => {
        cleanup();
        resolve();
      }, async (error) => {
        cleanup();
        const starting = launch.kind === "direct" && child.exitCode === null && child.signalCode === null;
        // #4727: the session that launched this broker is gone and the broker did not start in time; it is stopped
        // before this call returns, so it never writes into an agent directory its host may already be removing. Behind
        // the Windows launcher the broker is found by the pid it announced; one that never announced cannot be found,
        // and one that did not announce when it was created cannot be told apart from a later process given its pid
        // (#6133), so neither is stopped.
        let abandoned: StartingBroker | undefined;
        if (signal?.aborted) {
          if (launch.kind === "direct") {
            if (starting && child.pid !== undefined) abandoned = { kind: "group", pid: child.pid };
          } else if (announcement !== undefined) {
            const announced = await readBrokerStartAnnouncementAsync(announcement);
            if (announced?.started !== undefined) {
              abandoned = { kind: "announced", pid: announced.pid, started: announced.started };
            }
          }
        }
        if (abandoned !== undefined) {
          void stopStartingBroker(abandoned).finally(() => reject(toError(error)));
          return;
        }
        // A broker still starting keeps the lock, so later spawners wait for it instead of starting another.
        // Only now does the lock name the broker: until this hand-off it follows this live spawner, so no other
        // spawner can judge it stale and replace it while this one may still release it.
        // The Windows launcher hides the broker's pid, so its lock could only follow this live spawner and would
        // block every later spawn; there the broker's own live-socket check is what prevents a takeover.
        keepLock = starting && (await handSpawnLockToBrokerAsync(child.pid, lockOwner));
        reject(toError(error));
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
   * Spawned directly and detached, so it leads a process group of its own. A custom broker command can run the broker
   * as its own child rather than replacing itself with it; the group holds both. Its pid is read while the spawner's
   * child has not been reaped, so it still names that child.
   */
  | { readonly kind: "group"; readonly pid: number }
  /** Behind the Windows launcher: the pid the broker announced, and when that process was created. */
  | { readonly kind: "announced"; readonly pid: number; readonly started: string };

/** How long the check and Windows PowerShell's start may take before the session stops waiting for the broker. */
const ANNOUNCED_BROKER_STOP_START_MS = 5_000;
/** Beyond the PowerShell's own bounds, how much longer the session waits for it to end. */
const ANNOUNCED_BROKER_STOP_MARGIN_MS = 1_000;

/**
 * The PowerShell that stops the Windows broker `pid` created at `started` (#6133), with every process it started. Each
 * process is ended only through a handle this PowerShell holds to it, opened before it is checked and kept until the
 * PowerShell ends: Windows gives a pid to no other process while a handle to it is open, so a check made through the
 * handle stays true for the process it ends. So a PowerShell that is itself ended part way leaves processes running,
 * and never ends one that is not the broker's.
 *
 * The broker is the process whose creation time is `started`. Its processes are found from one `Win32_Process`
 * snapshot by parent pid: a process counts as a child only if it was created no earlier than its parent (an older
 * process naming that pid as its parent was started by an earlier holder of the pid), and only if the process its
 * handle holds was created when the snapshot says (not a later process given the snapshot's pid). Without a snapshot it
 * ends the broker alone. It waits up to `waitMs` for the broker to exit. A process it may not open, or one created at
 * another time, is left alone.
 */
function stopAnnouncedBrokerScript(pid: number, started: string, waitMs: number): string {
  return `$ErrorActionPreference = 'Stop'
function Hold([int]$id) {
  try { $p = [System.Diagnostics.Process]::GetProcessById($id); $null = $p.Handle; $p } catch { $null }
}
function Created($p) {
  try { $p.StartTime.ToFileTimeUtc() } catch { $null }
}
function Micros([datetime]$time) { $time.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') }
$broker = Hold ${pid}
if ($null -eq $broker) { exit 3 }
$brokerCreated = Created $broker
if ($null -eq $brokerCreated -or $brokerCreated -ne [long]'${started}') { exit 3 }
$held = New-Object System.Collections.ArrayList
[void]$held.Add($broker)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($broker.Id)
$snapshot = @()
try { $snapshot = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate) } catch { }
$level = @(, @($broker, $brokerCreated))
while ($level.Count -gt 0) {
  $next = @()
  foreach ($parent in $level) {
    foreach ($entry in $snapshot) {
      if ($entry.ParentProcessId -ne $parent[0].Id -or $ids.Contains([int]$entry.ProcessId) -or $null -eq $entry.CreationDate) { continue }
      $child = Hold $entry.ProcessId
      if ($null -eq $child) { continue }
      $created = Created $child
      if ($null -eq $created -or $created -lt $parent[1]) { continue }
      if ((Micros $child.StartTime) -ne (Micros $entry.CreationDate)) { continue }
      [void]$held.Add($child)
      [void]$ids.Add($child.Id)
      $next += , @($child, $created)
    }
  }
  $level = $next
}
foreach ($p in $held) { try { $p.Kill() } catch { } }
if ($broker.WaitForExit(${waitMs})) { exit 0 } else { exit 4 }
`;
}

/**
 * Stop the Windows broker found by its announcement, as {@link stopAnnouncedBrokerScript} does. A pid that already names
 * another process is left alone without starting PowerShell. The session waits at most
 * {@link ANNOUNCED_BROKER_STOP_START_MS} for the check and PowerShell's start, {@link STARTING_BROKER_KILL_WAIT_MS} for
 * the broker to exit, and {@link ANNOUNCED_BROKER_STOP_MARGIN_MS}. It never ends the PowerShell: once the session stops
 * waiting, the PowerShell finishes on its own, or ends with this process, which can only leave processes running.
 */
async function stopAnnouncedBroker(pid: number, started: string): Promise<void> {
  const entered = performance.now();
  const bound = ANNOUNCED_BROKER_STOP_START_MS + STARTING_BROKER_KILL_WAIT_MS + ANNOUNCED_BROKER_STOP_MARGIN_MS;
  if ((await readProcessCreationTime(pid)) !== started) return;
  if (performance.now() - entered >= ANNOUNCED_BROKER_STOP_START_MS) return;
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  await new Promise<void>((resolve) => {
    const powershell = spawn(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(stopAnnouncedBrokerScript(pid, started, STARTING_BROKER_KILL_WAIT_MS), "utf16le").toString("base64"),
      ],
      { cwd: systemRoot, env: hostCommandEnvironment(), stdio: "ignore", windowsHide: true },
    );
    powershell.unref();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, bound - (performance.now() - entered));
    powershell.once("error", done);
    powershell.once("exit", done);
  });
}

/**
 * Kill a broker that has not started listening, with every process it started, and wait until they are gone.
 *
 * #6133: on Windows the broker is found by the pid it announced, which Windows gives to another process within seconds
 * once the broker has exited. It is stopped only through a handle to the process whose creation time is the one it
 * announced ({@link stopAnnouncedBroker}), never by its pid alone; a pid that names another process, or a process this
 * one may not open, counts as a broker that has already exited.
 */
async function stopStartingBroker(broker: StartingBroker): Promise<void> {
  if (broker.kind === "announced") return stopAnnouncedBroker(broker.pid, broker.started);
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
    if ((await requestBrokerShutdown(socketPath)) === "unanswered") throw failed("stop");
    let lockLost = false;
    try {
      await waitForBrokerExit(report.pid, stopTimeoutMs, async () => {
        if (lockLost) return;
        const renewed = await renewSpawnLockAsync(lockOwner);
        if (renewed === undefined) lockLost = true;
        else lockOwner = renewed;
      });
    } catch (error) {
      if (isIntercomBrokerStopTimeoutError(error)) {
        lockPassedOn = await handSpawnLockToBrokerAsync(report.pid, lockOwner);
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

/** Records the still-starting broker on the lock so staleness follows that process instead of the spawner. */
async function handSpawnLockToBrokerAsync(pid: number | undefined, owner: string): Promise<boolean> {
  if (pid === undefined) return false;
  const lockPath = getBrokerSpawnLockPath();
  return underSpawnLockMutexAsync(lockPath, false, async () => {
    if (!(await ownsSpawnLockAsync(owner, lockPath))) return false;
    try {
      await appendFile(lockPath, `${pid}\n`);
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
    const renewed = `${process.pid}\n${nowMs}\n`;
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
    const renewed = `${process.pid}\n${nowMs}\n`;
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
    const owner = `${process.pid}\n${writtenAt}\n`;
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
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const writtenAt = Date.now();
    const owner = `${process.pid}\n${writtenAt}\n`;
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
  if (!isSpawnLockContentStale(content)) return false;
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
  const [spawnerLine = "", createdAtLine = "", brokerLine = ""] = content.split("\n");
  const spawnerPid = Number.parseInt(spawnerLine, 10);
  const createdAt = Number.parseInt(createdAtLine, 10);
  const brokerPid = Number.parseInt(brokerLine, 10);

  if (!Number.isFinite(spawnerPid) || !Number.isFinite(createdAt)) return true;
  if (nowMs - createdAt > BROKER_SPAWN_LOCK_MAX_AGE_MS) return true;
  return !isProcessAlive(Number.isFinite(brokerPid) ? brokerPid : spawnerPid);
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
 * `announcedPid` reports the pid of a broker this spawner cannot watch directly (behind the Windows launcher), once the
 * broker has announced it. A broker whose pid is gone and that does not answer has crashed, and the wait ends at once:
 * only a broker that is alive and not yet listening is waited for the whole budget.
 */
export async function waitForBroker(
  timeoutMs = BROKER_READY_TIMEOUT_MS,
  announcedPid?: () => number | undefined | Promise<number | undefined>,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  let interval = BROKER_POLL_INITIAL_INTERVAL_MS;
  while (Date.now() - start < timeoutMs) {
    signal?.throwIfAborted();
    if (await checkSocketConnectable()) {
      return;
    }
    const pid = await announcedPid?.();
    if (pid !== undefined && !isProcessAlive(pid)) {
      // A broker that finds a live broker on the socket yields and exits; that one answering is a success.
      if (await checkSocketConnectable()) return;
      throw new Error(`Intercom broker exited before startup (pid ${pid})\n${await describeBrokerLogAsync()}`);
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
