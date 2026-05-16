import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDirs as getAtomicAgentDirs, getEnvValue } from "@bastani/atomic";

export function getAgentDir(): string {
  const configured = getEnvValue(`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`)?.trim();
  if (!configured) {
    return join(homedir(), CONFIG_DIR_NAME, "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function getAgentDirs(): string[] {
  const configured = getEnvValue(`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`)?.trim();
  return configured ? [getAgentDir()] : getAtomicAgentDirs();
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

export function getAgentPaths(...segments: string[]): string[] {
  return getAgentDirs().map((dir) => join(dir, ...segments));
}
