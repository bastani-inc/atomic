import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ENV_OFFLINE, getEnvValue } from "../config.ts";
import { createGitEnvironment } from "../utils/git-env.ts";

export function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

export function isOfflineModeEnabled(): boolean {
	const value = getEnvValue(ENV_OFFLINE);
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isGitCommand(command: string): boolean {
	const commandName = basename(command).toLowerCase();
	return commandName === "git" || commandName === "git.exe";
}

export function getCommandEnv(command: string, overrides?: Record<string, string>): NodeJS.ProcessEnv {
	const baseEnv = getEnv();
	if (isGitCommand(command)) return createGitEnvironment(overrides, baseEnv);
	return overrides ? { ...baseEnv, ...overrides } : baseEnv;
}
