import type { SubagentToolResult } from "../../shared/types.js";
import type { SubagentParamsLike } from "./subagent-executor-types.js";

/** The line a launch that still asks to wait in the foreground gets first in its result. */
export const LEGACY_FOREGROUND_WAIT_NOTE =
	'Note: subagents always run in the background; the foreground wait this call asked for was removed. Use subagent({ action: "wait", id }) to wait for a launched child.';

/**
 * Launches a model asked to run in the foreground, by their agents and tasks, from the moment their arguments are
 * prepared until they execute. Schema validation copies the arguments in between, so nothing else links the two.
 * Bounded: a prepared call that never executes (its arguments failed validation) is forgotten in time.
 */
const MAX_REMEMBERED_LAUNCHES = 64;
const rememberedForegroundLaunches: string[] = [];

interface LaunchShape {
	readonly agent?: unknown;
	readonly task?: unknown;
	readonly tasks?: unknown;
}

function launchKey(params: LaunchShape): string {
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((task: LaunchShape | null) => [task?.agent, task?.task])
		: undefined;
	return JSON.stringify([params.agent, params.task, tasks]);
}

function asksForForeground(wait: unknown): boolean {
	return typeof wait === "object" && wait !== null && (wait as { kind?: unknown }).kind === "foreground";
}

function withoutWait<T extends object>(args: T): { readonly launch: T; readonly foreground: boolean } {
	if (!Object.hasOwn(args, "wait")) return { launch: args, foreground: false };
	const { wait, ...launch } = args as T & { readonly wait?: unknown };
	return { launch: launch as T, foreground: asksForForeground(wait) };
}

/**
 * Drops the `wait` a model's call still passes, which the tool no longer has: every launch runs in the background. A
 * launch that asked to wait in the foreground is remembered, so its result can say why it returned at once.
 */
export function withoutLegacyWait<T extends object>(args: T): T {
	const { launch, foreground } = withoutWait(args);
	if (foreground) {
		rememberedForegroundLaunches.push(launchKey(launch));
		if (rememberedForegroundLaunches.length > MAX_REMEMBERED_LAUNCHES) rememberedForegroundLaunches.shift();
	}
	return launch;
}

/**
 * The launch to run, without the `wait` an extension or SDK caller may still pass, and whether it asked to wait in the
 * foreground: directly, or as a model's call {@link withoutLegacyWait} prepared.
 */
export function takeLegacyForegroundWait(params: SubagentParamsLike): {
	readonly params: SubagentParamsLike;
	readonly foreground: boolean;
} {
	const { launch, foreground } = withoutWait(params);
	if (foreground) return { params: launch, foreground };
	const index = rememberedForegroundLaunches.indexOf(launchKey(launch));
	if (index >= 0) rememberedForegroundLaunches.splice(index, 1);
	return { params: launch, foreground: index >= 0 };
}

/** The result with {@link LEGACY_FOREGROUND_WAIT_NOTE} as its first line. */
export function withLegacyForegroundWaitNote(result: SubagentToolResult): SubagentToolResult {
	const [first, ...rest] = result.content;
	const content =
		first?.type === "text"
			? [{ ...first, text: `${LEGACY_FOREGROUND_WAIT_NOTE}\n${first.text}` }, ...rest]
			: [{ type: "text" as const, text: LEGACY_FOREGROUND_WAIT_NOTE }, ...result.content];
	return { ...result, content };
}
