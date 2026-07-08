import { existsSync, readFileSync } from "fs";
import { getAgentConfigPaths } from "@bastani/atomic";

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx", "bun", or "node") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;

  /** Enable/disable intercom (default: true) */
  enabled: boolean;

  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;
}

const CONFIG_PATHS = getAgentConfigPaths("intercom", "config.json");
const CONFIG_PATH = CONFIG_PATHS.find((path) => existsSync(path)) ?? CONFIG_PATHS[0]!;

export const DEFAULT_BROKER_COMMAND = "npx";
export const DEFAULT_BROKER_ARGS = ["--no-install", "tsx"] as const;

const defaults: IntercomConfig = {
  brokerCommand: DEFAULT_BROKER_COMMAND,
  brokerArgs: [...DEFAULT_BROKER_ARGS],
  confirmSend: false,
  enabled: true,
  replyHint: true,
};

export function loadConfig(): IntercomConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...defaults };
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = { ...defaults };

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

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${CONFIG_PATH}:`, error);
    return { ...defaults };
  }
}
