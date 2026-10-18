import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { ENV_HEAP_MB, getEnvValue } from "../../config.js";

const MIB = 1024 * 1024;
const ENGINE_HEAP_SHARE_OF_SYSTEM_MEMORY = 0.5;
const MAX_OLD_SPACE_FLAG = /^--max[-_]old[-_]space[-_]size(?:=|$)/;

export interface EngineHeapInputs {
	readonly runsOnNode: boolean;
	readonly totalMemoryBytes: number;
	/** The process's cgroup memory limit from `process.constrainedMemory()`; absent or `0` when unconstrained. */
	readonly constrainedMemoryBytes: number | undefined;
	readonly currentHeapLimitBytes: number;
	readonly nodeOptions: string | undefined;
	readonly execArgv: readonly string[];
	readonly configuredHeapMb: string | undefined;
}

function lastHostHeapFlag(execArgv: readonly string[]): string[] | undefined {
	const index = execArgv.findLastIndex((arg) => MAX_OLD_SPACE_FLAG.test(arg));
	if (index === -1) return undefined;
	const flag = execArgv[index]!;
	const value = execArgv[index + 1];
	return flag.includes("=") || value === undefined ? [flag] : [flag, value];
}

/** Splits `NODE_OPTIONS` the way Node does: whitespace separates options, double quotes group, `\` escapes. */
export function splitNodeOptions(nodeOptions: string): string[] {
	const options: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (let index = 0; index < nodeOptions.length; index++) {
		const character = nodeOptions[index]!;
		if (character === "\\" && quoted && index + 1 < nodeOptions.length) {
			current += nodeOptions[++index];
		} else if (character === '"') {
			quoted = !quoted;
			started = true;
		} else if (/\s/.test(character) && !quoted) {
			if (started) options.push(current);
			current = "";
			started = false;
		} else {
			current += character;
			started = true;
		}
	}
	if (started) options.push(current);
	return options;
}

/**
 * Node flags that size the interactive engine's V8 heap. The engine hosts every in-process subagent and workflow
 * stage, so V8's default limit (about 4 GiB) caps the whole fleet regardless of machine size. Under Node the engine
 * gets half of system memory, or of its container's memory limit when that is smaller, when this exceeds the
 * current limit. An explicit `--max-old-space-size` in
 * `NODE_OPTIONS` (inherited by the engine) or on the host's own command line wins, the last command-line flag first,
 * as Node applies it, and `ATOMIC_HEAP_MB` sets
 * the size in MiB or, as `0`, turns automatic sizing off. Other runtimes do not use V8 and get no flags.
 */
export function engineHeapRuntimeArgs(inputs: EngineHeapInputs): string[] {
	if (!inputs.runsOnNode) return [];
	const forwarded = lastHostHeapFlag(inputs.execArgv);
	if (forwarded) return forwarded;
	if (splitNodeOptions(inputs.nodeOptions ?? "").some((option) => MAX_OLD_SPACE_FLAG.test(option))) return [];
	const configured = inputs.configuredHeapMb?.trim();
	if (configured) {
		const heapMb = Number(configured);
		if (Number.isSafeInteger(heapMb) && heapMb >= 0) return heapMb === 0 ? [] : [`--max-old-space-size=${heapMb}`];
	}
	const constrained = inputs.constrainedMemoryBytes;
	const memoryBytes =
		constrained !== undefined && constrained > 0
			? Math.min(inputs.totalMemoryBytes, constrained)
			: inputs.totalMemoryBytes;
	const targetMb = Math.floor((memoryBytes * ENGINE_HEAP_SHARE_OF_SYSTEM_MEMORY) / MIB);
	return targetMb > Math.floor(inputs.currentHeapLimitBytes / MIB) ? [`--max-old-space-size=${targetMb}`] : [];
}

export function engineHeapRuntimeArgsForHost(runsOnNode: boolean): string[] {
	return engineHeapRuntimeArgs({
		runsOnNode,
		totalMemoryBytes: totalmem(),
		constrainedMemoryBytes: process.constrainedMemory(),
		currentHeapLimitBytes: getHeapStatistics().heap_size_limit,
		nodeOptions: process.env.NODE_OPTIONS,
		execArgv: process.execArgv,
		configuredHeapMb: getEnvValue(ENV_HEAP_MB),
	});
}
