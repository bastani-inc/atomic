import { join } from "path";
import { getAgentDir } from "@bastani/atomic";

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

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }

  return join(getIntercomDirPath(agentDir), "broker.sock");
}
