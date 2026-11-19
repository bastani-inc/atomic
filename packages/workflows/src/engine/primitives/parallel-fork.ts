import { isProxy } from "node:util/types";
import { stageSessionStore } from "../../shared/stage-session-store.js";
import type {
	StageOptions,
	WorkflowParallelOptions,
	WorkflowTaskOptions,
	WorkflowTaskStep,
} from "../../shared/types.js";

const sourceFields = [
	"context",
	"forkFromSessionId",
	"forkFromEntryId",
	"sessionStore",
	"sessionManager",
	"sessionDir",
	"cwd",
	"agentDir",
	"settingsManager",
	"workspace",
	"gitWorktreeDir",
] as const;

/** Read only plain source coordinates. Authors' computed fields and prompts still run at normal admission. */
function forkSource(step: WorkflowTaskStep, defaults: WorkflowParallelOptions): StageOptions | undefined {
	if (isProxy(step) || isProxy(defaults)) return undefined;
	const data: Partial<Record<(typeof sourceFields)[number], unknown>> = {};
	for (const key of sourceFields) {
		let field = Object.getOwnPropertyDescriptor(step, key);
		if (!field?.enumerable || ("value" in field && field.value === undefined))
			field = Object.getOwnPropertyDescriptor(defaults, key);
		if (field?.enumerable) {
			if (!("value" in field)) return undefined;
			data[key] = field.value;
		}
		if (key === "context" && data.context !== "fork") return undefined;
	}
	if (
		typeof data.forkFromSessionId !== "string" ||
		data.forkFromEntryId !== undefined ||
		data.workspace !== undefined ||
		data.gitWorktreeDir !== undefined
	)
		return undefined;
	return data as StageOptions;
}

type Source = { options: StageOptions; length: Promise<number | undefined> };

/** A live parallel shares one physical prefix length per source, not a branch tip or a replay key. */
export function captureParallelForks(
	steps: readonly WorkflowTaskStep[],
	defaults: WorkflowParallelOptions | undefined,
	read: (options: StageOptions, id: string) => Promise<number | undefined>,
): ((task: WorkflowTaskOptions, slot: number) => WorkflowTaskOptions) | undefined {
	if (isProxy(steps) || (defaults && isProxy(defaults))) return undefined;
	const sources = new Map<string, Source[]>();
	const slots = new Map<number, Source>();
	for (let slot = 0; slot < steps.length; ++slot) {
		const field = Object.getOwnPropertyDescriptor(steps, slot);
		if (!field || !("value" in field) || !field.value || typeof field.value !== "object") continue;
		const options = forkSource(field.value, defaults ?? {});
		const id = options?.forkFromSessionId;
		if (!options || id === undefined) continue;
		const peers = sources.get(id) ?? [];
		let source = peers.find((s) => sourceFields.every((k) => s.options[k] === options[k]));
		if (!source) {
			const length = read(options, id).catch(() => undefined);
			source = { options, length };
			peers.push(source);
			sources.set(id, peers);
		}
		slots.set(slot, source);
	}
	if (slots.size === 0) return undefined;
	return (task, slot) => {
		const source = slots.get(slot);
		// If a queued worker's authored coordinates changed, let it use the source it actually selected.
		return source && sourceFields.every((k) => source.options[k] === task[k])
			? { ...task, parallelForkLength: source.length }
			: task;
	};
}

/** The latest append position, including non-message entries. Missing sources retain the ordinary open behavior. */
export async function readParallelForkLength(options: StageOptions, id: string, defaultDir?: string): Promise<number> {
	const supplied = options.sessionStore ?? options.sessionManager?.getSessionStore();
	const store = supplied ?? (await stageSessionStore(options, defaultDir));
	try {
		return store.readRange ? (await store.readRange(id, 1, 0)).lastSeq : (await store.load(id)).entries.length;
	} finally {
		if (supplied === undefined) await store.close();
	}
}
