import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { nodeOptionsFromEnvironment } from "@bastani/atomic-codemode/node-options";
import { ENV_HEAP_MB, getEnvValue } from "../../config.js";

const MIB = 1024 * 1024;
const ENGINE_HEAP_SHARE_OF_SYSTEM_MEMORY = 0.5;
/**
 * Options that set the size of V8's heap. Node applies a percentage of memory over an old space size, and V8 an old
 * space size over a total heap size, which then still sizes the young generation.
 */
const HEAP_SIZE_OPTIONS: ReadonlySet<string> = new Set([
	"--max-old-space-size",
	"--max-old-space-size-percentage",
	"--max-heap-size",
]);
/** The young generation's size, which adds to whichever heap size applies. */
const YOUNG_GENERATION_SIZE_OPTION = "--max-semi-space-size";
/** The heap options that are V8's own: V8 also reads them with one leading dash, which Node passes on to it. */
const V8_HEAP_OPTIONS: ReadonlySet<string> = new Set([
	"--max-old-space-size",
	"--max-heap-size",
	YOUNG_GENERATION_SIZE_OPTION,
]);

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

interface CommandLineHeapFlags {
	/** Whether the command line sets a heap size. */
	readonly setsHeapSize: boolean;
	/** The last flag for each heap option, with a value given as the next word, in command-line order. */
	readonly flags: readonly string[];
}

/** The heap flags on a command line (`process.execArgv`). Node and V8 match `_` as `-` in an option's name. */
function commandLineHeapFlags(execArgv: readonly string[]): CommandLineHeapFlags {
	const last = new Map<string, string[]>();
	for (let index = 0; index < execArgv.length; index++) {
		const flag = execArgv[index]!;
		if (flag === "--") break;
		if (!flag.startsWith("-")) continue;
		const dashes = flag.startsWith("--") ? 2 : 1;
		const equals = flag.indexOf("=");
		const name = `--${(equals === -1 ? flag : flag.slice(0, equals)).slice(dashes).replaceAll("_", "-")}`;
		if (!HEAP_SIZE_OPTIONS.has(name) && name !== YOUNG_GENERATION_SIZE_OPTION) continue;
		if (dashes === 1 && !V8_HEAP_OPTIONS.has(name)) continue;
		const value = execArgv[index + 1];
		const valueFollows = equals === -1 && value !== undefined && !value.startsWith("-");
		// A later flag for the same option replaces the earlier one, and takes its place in the order.
		last.delete(name);
		last.set(name, valueFollows ? [flag, value] : [flag]);
		if (valueFollows) index++;
	}
	return {
		setsHeapSize: [...last.keys()].some((name) => HEAP_SIZE_OPTIONS.has(name)),
		flags: [...last.values()].flat(),
	};
}

/** Whether a command line (`process.execArgv`) sets a heap size, which a process started with it keeps. */
export function commandLineSetsHeapSize(execArgv: readonly string[]): boolean {
	return commandLineHeapFlags(execArgv).setsHeapSize;
}

/**
 * Node flags that size the interactive engine's V8 heap. The engine hosts every in-process subagent, so V8's default limit (about 4 GiB) caps the whole fleet regardless of machine size. Under Node the engine
 * gets half of system memory, or of its container's memory limit when that is smaller, when this exceeds the
 * current limit. A heap size given to Node (`--max-old-space-size`, `--max-old-space-size-percentage` or
 * `--max-heap-size`) in `NODE_OPTIONS`, which the engine inherits, or on the host's own command line wins: the engine
 * gets the host's command-line heap flags, the last one for each option, so that Node sizes its heap as it sized the
 * host's. `ATOMIC_HEAP_MB` sets the size in MiB or, as `0`, turns automatic sizing off. A young generation size
 * (`--max-semi-space-size`) on the host's command line goes to the engine in every case. Other runtimes do not use V8
 * and get no flags.
 */
export function engineHeapRuntimeArgs(inputs: EngineHeapInputs): string[] {
	if (!inputs.runsOnNode) return [];
	const host = commandLineHeapFlags(inputs.execArgv);
	if (host.setsHeapSize) return [...host.flags];
	const youngGeneration = [...host.flags];
	if (nodeOptionsFromEnvironment(inputs.nodeOptions).some((option) => HEAP_SIZE_OPTIONS.has(option.name))) {
		return youngGeneration;
	}
	const configured = inputs.configuredHeapMb?.trim();
	if (configured) {
		const heapMb = Number(configured);
		if (Number.isSafeInteger(heapMb) && heapMb >= 0) {
			return heapMb === 0 ? youngGeneration : [...youngGeneration, `--max-old-space-size=${heapMb}`];
		}
	}
	const constrained = inputs.constrainedMemoryBytes;
	const memoryBytes =
		constrained !== undefined && constrained > 0
			? Math.min(inputs.totalMemoryBytes, constrained)
			: inputs.totalMemoryBytes;
	const targetMb = Math.floor((memoryBytes * ENGINE_HEAP_SHARE_OF_SYSTEM_MEMORY) / MIB);
	return targetMb > Math.floor(inputs.currentHeapLimitBytes / MIB)
		? [...youngGeneration, `--max-old-space-size=${targetMb}`]
		: youngGeneration;
}

export function engineHeapRuntimeArgsForHost(runsOnNode: boolean): string[] {
	// Other runtimes get no flags; Bun's heap statistics alone take about 14 ms to read.
	if (!runsOnNode) return [];
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
