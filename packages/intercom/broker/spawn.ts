import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net from "net";
import { isBunBinary } from "@bastani/atomic";
import {
  getBrokerPidPath,
  getBrokerSocketPath,
  getBrokerSpawnLockPath,
  getIntercomDirPath,
} from "./paths.js";

const INTERCOM_DIR = getIntercomDirPath();
const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SOCKET = getBrokerSocketPath();
const BROKER_PID = getBrokerPidPath();
const BROKER_SPAWN_LOCK = getBrokerSpawnLockPath();

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

function resolveTsxCliPath(extensionDir: string): string | null {
  try {
    const tsxMain = requireFromExtensionDir(extensionDir).resolve("tsx");
    return join(dirname(tsxMain), "cli.mjs");
  } catch {
    const bundledTsx = join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
    return existsSync(bundledTsx) ? bundledTsx : null;
  }
}

export function getTsxCliPath(extensionDir: string = EXTENSION_DIR): string {
  return resolveTsxCliPath(extensionDir) ?? join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
}

export function getJitiCliPath(extensionDir: string = EXTENSION_DIR): string {
  try {
    const jitiPackage = requireFromExtensionDir(extensionDir).resolve("jiti/package.json");
    return join(dirname(jitiPackage), "lib", "jiti-cli.mjs");
  } catch {
    return join(extensionDir, "node_modules", "jiti", "lib", "jiti-cli.mjs");
  }
}

function getDefaultBrokerRunnerPath(extensionDir: string): string {
  return resolveTsxCliPath(extensionDir) ?? getJitiCliPath(extensionDir);
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
  mkdirSync(dirname(launcherPath), { recursive: true });
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
): BrokerLaunchSpec {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs, runtime),
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

export function getBrokerSpawnOptions(extensionDir: string = EXTENSION_DIR): {
  detached: true;
  stdio: "ignore";
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(brokerCommand: string, brokerArgs: string[]): Promise<void> {
  mkdirSync(INTERCOM_DIR, { recursive: true });

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    const brokerPath = join(dirname(fileURLToPath(import.meta.url)), "broker.ts");
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error.message}`, { cause: error }));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        reject(toError(error));
      });
    });
  } finally {
    releaseSpawnLock();
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
  return new Promise((resolve) => {
    const socket = net.connect(BROKER_SOCKET);
    const finish = (isConnected: boolean) => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(isConnected);
    };
    const onConnect = () => {
      socket.end();
      finish(true);
    };
    const onError = () => {
      socket.destroy();
      finish(false);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
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
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
