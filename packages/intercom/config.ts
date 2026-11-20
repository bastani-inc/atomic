import { reportOwnedIntercomDiagnostic } from "./diagnostics.js";
import { existsSync, readFileSync } from "fs";
import { readFile } from "node:fs/promises";
import { getAgentConfigPaths } from "@bastani/atomic";
import { DEFAULT_MAX_PENDING_REPLY_WAITS } from "./reply-waiter.ts";
import { BROKER_READY_TIMEOUT_MS, MIN_BROKER_STARTUP_TIMEOUT_MS } from "./broker/startup-timeout.js";

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx", "bun", or "node") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** How long a spawn attempt waits for a new broker to answer on its socket, in milliseconds */
  brokerStartupTimeoutMs: number;

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Maximum concurrent blocking asks for this session. */
  maxPendingAsks: number;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;


  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** Default intercom home group for this session (overridden by env/orchestrator). */
  group?: string;

  /** Interactive sessions join the broker at startup (default: true; `ATOMIC_INTERCOM_JOIN_AT_STARTUP` overrides). */
  joinAtStartup: boolean;
}

const CONFIG_PATHS = getAgentConfigPaths("intercom", "config.json");

export const DEFAULT_BROKER_COMMAND = "npx";
export const DEFAULT_BROKER_ARGS = ["--no-install", "tsx"] as const;

const defaults: IntercomConfig = {
  brokerCommand: DEFAULT_BROKER_COMMAND,
  brokerArgs: [...DEFAULT_BROKER_ARGS],
  brokerStartupTimeoutMs: BROKER_READY_TIMEOUT_MS,
  confirmSend: false,
  maxPendingAsks: DEFAULT_MAX_PENDING_REPLY_WAITS,
  replyHint: true,
  joinAtStartup: true,
};

export function defaultConfig(): IntercomConfig {
  return { ...defaults, brokerArgs: [...DEFAULT_BROKER_ARGS] };
}

function parseConfig(raw: string): IntercomConfig {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object");
  }

  const parsedConfig = parsed as Record<string, unknown>;
  const config: IntercomConfig = defaultConfig();

  if (Object.hasOwn(parsedConfig, "brokerCommand")) {
    if (typeof parsedConfig.brokerCommand !== "string") {
      throw new Error(`"brokerCommand" must be a string`);
    }
    const brokerCommand = parsedConfig.brokerCommand.trim();
    if (!brokerCommand) {
      throw new Error(`"brokerCommand" must not be empty`);
    }
    config.brokerCommand = brokerCommand;
  }

  if (Object.hasOwn(parsedConfig, "brokerArgs")) {
    if (!Array.isArray(parsedConfig.brokerArgs)) {
      throw new Error(`"brokerArgs" must be an array`);
    }
    const brokerArgs: string[] = [];
    for (const arg of parsedConfig.brokerArgs) {
      if (typeof arg !== "string") {
        throw new Error(`"brokerArgs" items must be strings`);
      }
      brokerArgs.push(arg);
    }
    config.brokerArgs = brokerArgs;
  }

  if (Object.hasOwn(parsedConfig, "brokerStartupTimeoutMs")) {
    if (
      !Number.isInteger(parsedConfig.brokerStartupTimeoutMs)
      || Number(parsedConfig.brokerStartupTimeoutMs) < MIN_BROKER_STARTUP_TIMEOUT_MS
    ) {
      throw new Error(`"brokerStartupTimeoutMs" must be an integer of at least ${MIN_BROKER_STARTUP_TIMEOUT_MS}`);
    }
    config.brokerStartupTimeoutMs = Number(parsedConfig.brokerStartupTimeoutMs);
  }

  if (Object.hasOwn(parsedConfig, "confirmSend")) {
    if (typeof parsedConfig.confirmSend !== "boolean") {
      throw new Error(`"confirmSend" must be a boolean`);
    }
    config.confirmSend = parsedConfig.confirmSend;
  }

  if (Object.hasOwn(parsedConfig, "maxPendingAsks")) {
    if (!Number.isInteger(parsedConfig.maxPendingAsks) || Number(parsedConfig.maxPendingAsks) < 1) {
      throw new Error(`"maxPendingAsks" must be an integer greater than or equal to 1`);
    }
    config.maxPendingAsks = Number(parsedConfig.maxPendingAsks);
  }

  if (Object.hasOwn(parsedConfig, "replyHint")) {
    if (typeof parsedConfig.replyHint !== "boolean") {
      throw new Error(`"replyHint" must be a boolean`);
    }
    config.replyHint = parsedConfig.replyHint;
  }

  if (Object.hasOwn(parsedConfig, "joinAtStartup")) {
    if (typeof parsedConfig.joinAtStartup !== "boolean") {
      throw new Error(`"joinAtStartup" must be a boolean`);
    }
    config.joinAtStartup = parsedConfig.joinAtStartup;
  }

  if (Object.hasOwn(parsedConfig, "status")) {
    if (typeof parsedConfig.status !== "string") {
      throw new Error(`"status" must be a string`);
    }
    config.status = parsedConfig.status;
  }

  if (Object.hasOwn(parsedConfig, "group")) {
    if (typeof parsedConfig.group !== "string") {
      throw new Error(`"group" must be a string`);
    }
    config.group = parsedConfig.group;
  }

  return config;
}

export function loadConfig(): IntercomConfig {
  const configPath = CONFIG_PATHS.find((path) => existsSync(path)) ?? CONFIG_PATHS[0]!;
  if (!existsSync(configPath)) {
    return defaultConfig();
  }

  try {
    return parseConfig(readFileSync(configPath, "utf-8"));
  } catch (error) {
    if (!reportOwnedIntercomDiagnostic()) console.error(`Failed to load intercom config at ${configPath}:`, error);
    return defaultConfig();
  }
}

export async function loadConfigAsync(): Promise<IntercomConfig> {
  for (const configPath of CONFIG_PATHS) {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!reportOwnedIntercomDiagnostic()) console.error(`Failed to load intercom config at ${configPath}:`, error);
      return defaultConfig();
    }
    try {
      return parseConfig(raw);
    } catch (error) {
      if (!reportOwnedIntercomDiagnostic()) console.error(`Failed to load intercom config at ${configPath}:`, error);
      return defaultConfig();
    }
  }
  return defaultConfig();
}
