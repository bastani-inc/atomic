import { existsSync, mkdirSync } from "fs";
import { access, mkdir } from "fs/promises";
import { join } from "path";
import { getAgentDir as getDefaultAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.ts";

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.atomic/agent/sessions/.
 */
export function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

export async function getDefaultSessionDirAsync(cwd: string, agentDir: string = getDefaultAgentDir()): Promise<string> {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	try {
		await access(sessionDir);
	} catch {
		await mkdir(sessionDir, { recursive: true });
	}
	return sessionDir;
}
