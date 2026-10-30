import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { isSocketAnswering } from "./socket-liveness.js";
import { BROKER_READY_TIMEOUT_MS } from "./startup-timeout.js";
import { createChildProcessEnvironment, isBunBinary, processSharedStorageSelection } from "@bastani/atomic";
import {
  BROKER_STORAGE_ENV,
  getBrokerLauncherExitPath,
  getBrokerLogPath,
  getBrokerPidPath,
  getBrokerSocketPath,
  getBrokerSpawnLockPath,
  getIntercomDirPath,
} from "./paths.js";

function isIntercomPackageRoot(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "broker"));
}

/** Package root whether this module is `broker/spawn.ts` or the installed `index.bundle.mjs`. */
export function resolveIntercomPackageRoot(moduleHref: string): string {
  const here = dirname(fileURLToPath(moduleHref));
  if (isIntercomPackageRoot(here)) return here;
  return join(here, "..");
}

export function resolveBrokerEntrypoint(packageRoot: string): string {
  const bundled = join(packageRoot, "broker", "broker.bundle.mjs");
  return existsSync(bundled) ? bundled : join(packageRoot, "broker", "broker.ts");
}


const INTERCOM_DIR = getIntercomDirPath();
const EXTENSION_DIR = resolveIntercomPackageRoot(import.meta.url);
const BROKER_SOCKET = getBrokerSocketPath();
const BROKER_PID = getBrokerPidPath();
const BROKER_SPAWN_LOCK = getBrokerSpawnLockPath();
const BROKER_LOG = getBrokerLogPath();
const BROKER_LAUNCHER_EXIT = getBrokerLauncherExitPath();

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
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

/**
 * Where, and under which token, the Windows launcher chain reports that the broker process ended. The token is
 * unique to one spawn, so a broker that is retiring and ends late cannot be taken for the exit of its successor.
 */
export interface BrokerLauncherExit {
  readonly path: string;
  readonly token: string;
}

/** How the broker process a Windows launcher ran ended: with status 0, or not. */
export interface BrokerLauncherStatus {
  readonly clean: boolean;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export function getWindowsHiddenLauncherPath(intercomDir: string = INTERCOM_DIR): string {
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
 * The launcher also hides the broker's pid and exit: `wscript.exe` returns at once, so the parent cannot tell a
 * broker that crashed at start-up from one that is still loading, and would wait out the whole start-up budget for
 * either. With `exit`, the same `cmd.exe` (which stays resident while the broker runs) reports how the broker ended
 * once its command returns: `&&` writes `<token> ok` for status 0 and `||` writes `<token> failed` otherwise, after
 * the redirect has closed the log, so a parent that sees the file reads a complete log. The parent watches the file
 * (`readBrokerLauncherExit`). The marker is left out when `exit` has a `%` in its path or an unsafe token, for the
 * reason below.
 *
 * Returns the command line unchanged when it contains a `%`. cmd expands `%NAME%` at parse time
 * and there is no reliable way to escape a literal percent on a `cmd /c` command line — `^` does
 * not cover it, and `%%` is a batch-file escape rather than a command-line one. Wrapping such a
 * command would hand the broker different arguments than the user configured, so the redirect is
 * dropped instead: launching correctly without a captured log beats launching wrongly with one.
 * A `%` reaches here only from a custom `brokerCommand`/`brokerArgs` or an install path that
 * contains one, and the direct (non-launcher) Windows path still captures stderr normally.
 */
export function getWindowsStderrRedirectCommandLine(
  commandLine: string,
  logPath: string,
  exit?: BrokerLauncherExit,
): string {
  if (commandLine.includes("%")) return commandLine;
  const redirected = `${commandLine} 2>>${quoteWindowsArg(logPath)}`;
  if (exit === undefined || exit.path.includes("%") || !/^[A-Za-z0-9-]+$/u.test(exit.token)) {
    return `cmd.exe /s /c "${redirected}"`;
  }
  const marker = (status: "ok" | "failed") => `echo ${exit.token} ${status} >${quoteWindowsArg(exit.path)}`;
  return `cmd.exe /s /c "${redirected} && ${marker("ok")} || ${marker("failed")}"`;
}

/**
 * How the Windows launcher chain says the broker process ended, or undefined while it has not, or when the file
 * belongs to another spawn (another token) or is not yet fully written.
 */
export function readBrokerLauncherExit(exit: BrokerLauncherExit): BrokerLauncherStatus | undefined {
  let text: string;
  try {
    text = readFileSync(exit.path, "utf-8");
  } catch {
    return undefined;
  }
  const [token, status] = text.trim().split(/\s+/u);
  if (token !== exit.token) return undefined;
  if (status === "ok") return { clean: true };
  if (status === "failed") return { clean: false };
  return undefined;
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    'Set WshShell = Nothing',
    '',
  ].join("\r\n");
}

function writeWindowsHiddenLauncher(
  commandLine: string,
  launcherPath: string = getWindowsHiddenLauncherPath(),
): string {
  ensurePrivateDirectory(dirname(launcherPath));
  writeFileSync(launcherPath, getWindowsHiddenLauncherScript(commandLine), "utf-8");
  return launcherPath;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  platform: NodeJS.Platform = process.platform,
  intercomDir: string = INTERCOM_DIR,
  nodePath: string = process.execPath,
  runtime: BrokerRuntime = getCurrentBrokerRuntime(),
  logPath: string = BROKER_LOG,
  launcherExit?: BrokerLauncherExit,
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
        launcherExit,
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
 */
export function getBrokerSpawnOptions(
  extensionDir: string = EXTENSION_DIR,
  stderr: number | "ignore" = "ignore",
): {
  detached: true;
  stdio: ["ignore", "ignore", number | "ignore"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const storage = processSharedStorageSelection();
  return {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    cwd: extensionDir,
    env: createChildProcessEnvironment({
      NODE_NO_WARNINGS: "1",
      ...(storage === undefined ? {} : { [BROKER_STORAGE_ENV]: storage }),
    }),
    windowsHide: true,
  };
}

/**
 * Preserve a bounded previous log across truncation. Returns false when a
 * Windows broker that is still starting holds the log through its launcher's stderr redirect.
 */
function resetBrokerLog(logPath: string = BROKER_LOG): boolean {
  ensurePrivateDirectory(dirname(logPath));
  try {
    const previous = readBrokerLogTail(logPath);
    closeSync(openSync(logPath, "w"));
    if (previous.length > 0) {
      try {
        const previousPath = `${logPath}.previous`;
        writeFileSync(previousPath, Buffer.from(previous).subarray(-BROKER_LOG_TAIL_BYTES), { mode: 0o600 });
        if (process.platform !== "win32") chmodSync(previousPath, 0o600);
      } catch {}
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM")) return false;
    throw error;
  }
}

/** Read at most {@link BROKER_LOG_TAIL_BYTES} trailing bytes of the broker log. */
export function readBrokerLogTail(logPath: string = BROKER_LOG, maxBytes: number = BROKER_LOG_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const size = statSync(logPath).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString("utf-8").trim();
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

/** Path plus bounded stderr tail, appended to every broker startup failure. */
export function describeBrokerLog(logPath: string = BROKER_LOG): string {
  const tail = readBrokerLogTail(logPath);
  if (tail.length === 0) return `Broker log: ${logPath} (empty)`;
  return `Broker log: ${logPath}\n--- broker stderr (last ${Buffer.byteLength(tail)} bytes) ---\n${tail}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(
  brokerCommand: string,
  brokerArgs: string[],
  readyTimeoutMs: number = BROKER_READY_TIMEOUT_MS,
  extensionDir: string = EXTENSION_DIR,
): Promise<void> {
  ensurePrivateDirectory(INTERCOM_DIR);

  if (await isBrokerRunning()) {
    return;
  }

  const lockOwner = acquireSpawnLock();
  if (lockOwner === undefined) {
    await waitForBroker(readyTimeoutMs);
    return;
  }

  let keepLock = false;
  try {
    if (await isBrokerRunning()) {
      return;
    }

    const brokerPath = resolveBrokerEntrypoint(extensionDir);
    // Where the launcher is a Windows chain that hides the broker's exit, it reports the exit through this file.
    const launcherExit: BrokerLauncherExit | undefined =
      process.platform === "win32" ? { path: BROKER_LAUNCHER_EXIT, token: randomUUID() } : undefined;
    if (launcherExit !== undefined) {
      try {
        unlinkSync(launcherExit.path);
      } catch {
        // No earlier spawn left one, or it is not removable: its token differs from this spawn's, so it is ignored.
      }
    }
    const launch = getBrokerLaunchSpec(
      brokerPath,
      brokerCommand,
      brokerArgs,
      extensionDir,
      process.platform,
      INTERCOM_DIR,
      process.execPath,
      getCurrentBrokerRuntime(),
      BROKER_LOG,
      launcherExit,
    );
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    // Reset before spawning either way: the Windows launcher appends to this same path.
    if (!resetBrokerLog()) {
      await waitForBroker(readyTimeoutMs);
      return;
    }
    // The Windows launcher redirects the broker's own stderr, so only the direct spawn
    // needs the descriptor. Node duplicates it during spawn, so the parent copy is closed
    // immediately afterwards rather than being held open for the broker's lifetime.
    const logFd = launch.kind === "direct" ? openSync(BROKER_LOG, "a") : undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, launch.args, getBrokerSpawnOptions(extensionDir, logFd ?? "ignore"));
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(
          new Error(`Failed to spawn intercom broker: ${error.message}\n${describeBrokerLog()}`, { cause: error }),
        );
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}\n${describeBrokerLog()}`));
          return;
        }
        const exitedBeforeStartup = () =>
          new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}\n${describeBrokerLog()}`);
        if (code === 0) {
          // A broker that finds a live broker on the socket yields with a clean exit.
          void checkSocketConnectable().then((answering) => (answering ? resolve() : reject(exitedBeforeStartup())));
          return;
        }
        reject(exitedBeforeStartup());
      };

      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker(
        readyTimeoutMs,
        launcherExit === undefined ? undefined : () => readBrokerLauncherExit(launcherExit),
      ).then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        // A broker still starting keeps the lock, so later spawners wait for it instead of starting another.
        // Only now does the lock name the broker: until this hand-off it follows this live spawner, so no other
        // spawner can judge it stale and replace it while this one may still release it.
        // The Windows launcher hides the broker's pid, so its lock could only follow this live spawner and would
        // block every later spawn; there the broker's own live-socket check is what prevents a takeover.
        keepLock =
          launch.kind === "direct" &&
          child.exitCode === null &&
          child.signalCode === null &&
          handSpawnLockToBroker(child.pid, lockOwner);
        reject(toError(error));
      });
    });
  } finally {
    if (!keepLock) releaseSpawnLock(lockOwner);
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  if (!existsSync(BROKER_PID)) return false;

  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

function checkSocketConnectable(): Promise<boolean> {
  return isSocketAnswering(BROKER_SOCKET);
}

/** Records the still-starting broker on the lock so staleness follows that process instead of the spawner. */
function handSpawnLockToBroker(pid: number | undefined, owner: string): boolean {
  if (pid === undefined || !ownsSpawnLock(owner)) return false;
  try {
    appendFileSync(BROKER_SPAWN_LOCK, `${pid}\n`);
    return true;
  } catch {
    // The startup error must still reach the caller; an unrecorded lock is released like any other.
    return false;
  }
}

function ownsSpawnLock(owner: string, lockPath: string = BROKER_SPAWN_LOCK): boolean {
  try {
    return readFileSync(lockPath, "utf-8").startsWith(owner);
  } catch {
    return false;
  }
}

/** Returns the header this spawner wrote, which proves ownership on release, or undefined when another spawner holds the lock. */
function acquireSpawnLock(): string | undefined {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const owner = `${process.pid}\n${Date.now()}\n`;
    try {
      writeFileSync(BROKER_SPAWN_LOCK, owner, { flag: "wx" });
      return owner;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return undefined;
    }
  }
  return undefined;
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
export function isSpawnLockStale(lockPath: string = BROKER_SPAWN_LOCK, nowMs: number = Date.now()): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }

  try {
    const [spawnerLine = "", createdAtLine = "", brokerLine = ""] = readFileSync(lockPath, "utf-8").trim().split("\n");
    const spawnerPid = Number.parseInt(spawnerLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const brokerPid = Number.parseInt(brokerLine, 10);

    if (!Number.isFinite(spawnerPid) || !Number.isFinite(createdAt)) return true;
    if (nowMs - createdAt > BROKER_SPAWN_LOCK_MAX_AGE_MS) return true;
    return !isProcessAlive(Number.isFinite(brokerPid) ? brokerPid : spawnerPid);
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

/** Removes the lock only while it is still the one `owner` wrote; a spawner that replaced a stale lock keeps its own. */
export function releaseSpawnLock(owner: string, lockPath: string = BROKER_SPAWN_LOCK): void {
  if (!ownsSpawnLock(owner, lockPath)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

/**
 * Poll the broker socket with a short initial interval and bounded exponential backoff.
 * Startup is tens of milliseconds, so the previous flat 100 ms sleep dominated it; the
 * overall timeout semantics are unchanged.
 *
 * `launcherExit` reports a broker process this spawner cannot watch directly (behind the Windows launcher), and ends
 * the wait at once: only a broker that is alive and not yet listening is waited for the whole budget.
 */
export async function waitForBroker(
  timeoutMs = BROKER_READY_TIMEOUT_MS,
  launcherExit?: () => BrokerLauncherStatus | undefined,
): Promise<void> {
  const start = Date.now();
  let interval = BROKER_POLL_INITIAL_INTERVAL_MS;
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    const exited = launcherExit?.();
    if (exited !== undefined) {
      // A broker that finds a live broker on the socket yields with a clean exit.
      if (exited.clean && (await checkSocketConnectable())) return;
      throw new Error(
        `Intercom broker exited before startup ${exited.clean ? "with code 0" : "with a failure status"}\n${describeBrokerLog()}`,
      );
    }
    await sleep(interval);
    interval = Math.min(interval * 2, BROKER_POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `Broker failed to start within timeout (${timeoutMs} ms)\n`
      + "The broker did not answer on its socket in time; it may still be starting, which a busy machine or an empty jiti "
      + "cache slows. Try again, or raise `brokerStartupTimeoutMs` in the Intercom config.json (default "
      + `${BROKER_READY_TIMEOUT_MS} ms).\n${describeBrokerLog()}`,
  );
}
