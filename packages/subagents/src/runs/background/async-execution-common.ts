import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "@bastani/atomic";
import { formatPiSpawnError, resolvePiPackageRoot, validatePiSpawnCwd } from "../shared/pi-spawn.ts";
import { getAsyncConfigPath, TEMP_ROOT_DIR, type SubagentRunMode } from "../../shared/types.ts";
import type { AsyncExecutionResult, AsyncSpawnResult } from "./async-execution-types.ts";

const require = createRequire(import.meta.url);
export const piPackageRoot = resolvePiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => piPackageRoot ? path.join(piPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

const jitiCliPath = resolveJitiCliPath();

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.",
	].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

/**
 * Spawn the async runner process
 */
export function writeAsyncRunnerConfig(cfg: object, suffix: string): string {
	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
	return cfgPath;
}

export function spawnRunner(cfg: object, suffix: string, cwd: string): AsyncSpawnResult {
	const cwdValidation = validatePiSpawnCwd(cwd);
	if (!cwdValidation.ok) return { error: cwdValidation.error };

	if (!jitiCliPath) {
		return { error: "upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed" };
	}

	const cfgPath = writeAsyncRunnerConfig(cfg, suffix);
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	const spawnSpec = { command: process.execPath, args: [jitiCliPath, runner, cfgPath] };
	let proc: ReturnType<typeof spawn>;
	try {
		proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (error) {
		const spawnError = error instanceof Error ? error : new Error(String(error));
		return { error: formatPiSpawnError(spawnError, spawnSpec, cwd) };
	}
	proc.on("error", (error) => {
		console.error(`[${APP_NAME}-subagents] async spawn failed: ${formatPiSpawnError(error, spawnSpec, cwd)}`);
	});
	if (typeof proc.pid !== "number") {
		const noPidError = Object.assign(
			new Error(`spawn ${spawnSpec.command} failed before assigning a pid`),
			fs.existsSync(spawnSpec.command) ? {} : { code: "ENOENT" },
		);
		return { error: formatPiSpawnError(noPidError, spawnSpec, cwd) };
	}
	proc.unref();
	return { pid: proc.pid };
}

export function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

export const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: subagent";

export class UnavailableSubagentSkillError extends Error {}
export class AsyncStartValidationError extends Error {}
