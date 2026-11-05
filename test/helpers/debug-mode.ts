import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { setDebugSetting } from "../../packages/coding-agent/src/core/debug-setting.js";
import { DEBUG_ENV_VARS } from "./debug-env.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/** How a test turns debug mode on: the `debug` setting, or `ATOMIC_DEBUG=1`. */
export type DebugModeSource = "setting" | "ATOMIC_DEBUG";

export const DEBUG_MODE_SOURCES: readonly DebugModeSource[] = ["setting", "ATOMIC_DEBUG"];

export interface DebugLogRecord {
	readonly at: string;
	readonly pid: number;
	readonly area: string;
	readonly event: string;
	readonly data: Record<string, unknown>;
}

export interface DebugLogFixture {
	readonly agentDir: string;
	readonly path: string;
	/** Every record written so far; empty when the log was never created. */
	records(): DebugLogRecord[];
	/** Whether anything created the debug log file. */
	exists(): boolean;
}

/**
 * Runs `body` with the debug log in a fresh agent directory, debug mode turned on through `source` (or left off), and
 * the area variables cleared, then restores the environment and the setting.
 */
export async function withDebugLog<T>(
	source: DebugModeSource | "off",
	body: (log: DebugLogFixture) => T | Promise<T>,
): Promise<T> {
	const agentDir = makeTempDirectory("atomic-debug-log-");
	const path = join(agentDir, "atomic-debug.log");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	for (const name of DEBUG_ENV_VARS) vi.stubEnv(name, undefined);
	if (source === "ATOMIC_DEBUG") vi.stubEnv("ATOMIC_DEBUG", "1");
	setDebugSetting(source === "setting");
	const log: DebugLogFixture = {
		agentDir,
		path,
		exists: () => existsSync(path),
		records: () =>
			existsSync(path)
				? readFileSync(path, "utf8")
						.split("\n")
						.filter((line) => line.startsWith("{"))
						.map((line) => JSON.parse(line) as DebugLogRecord)
				: [],
	};
	try {
		return await body(log);
	} finally {
		setDebugSetting(false);
		vi.unstubAllEnvs();
		removeTempDirectory(agentDir);
	}
}

/** The records of one area, without the per-write timestamp and pid. */
export function areaRecords(log: DebugLogFixture, area: string): { event: string; data: Record<string, unknown> }[] {
	return log
		.records()
		.filter((record) => record.area === area)
		.map(({ event, data }) => ({ event, data }));
}
