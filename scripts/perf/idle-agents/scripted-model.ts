/**
 * What both hosts of the idle-agents benchmark share: the scripted model and its provider, the short tool every turn
 * calls, and the long tool whose live operation an idle agent waits on.
 */
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { AuthStorage } from "../../../packages/coding-agent/src/core/auth-storage.js";
import type { ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/index.js";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.js";
import { liveAsyncResources } from "./async-resources.js";

export interface DelaySummary {
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

/** ~1.2 KB of completion text: 12 chunks of about 100 characters, as agent_scale streams. */
export const CHUNK =
	"The scripted model streams this sentence as one chunk of roughly one hundred characters of output. ";
export const COMPLETION_TEXT = CHUNK.repeat(12);
export const TOOL_OUTPUT = "lookup result: ".padEnd(100, "x");
export const WAIT_TOOL = "wait_for_ci";

export const lookupTool: ToolDefinition = {
	name: "lookup",
	label: "Lookup",
	description: "Returns a short fixed result",
	parameters: Type.Object({ key: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: TOOL_OUTPUT }], details: undefined }),
};

/**
 * The long tool's own work, one live operation per agent that is waiting: finishing it is what produces the result
 * that wakes the agent. This is the state a real tool's operation holds (a CI watch, a child process), so it counts
 * against the agent here as it would there.
 */
export const operations = new Map<string, (result: AgentToolResult) => void>();

export const waitTool: ToolDefinition = {
	name: WAIT_TOOL,
	label: "Wait for CI",
	description: "Waits for a CI run that finishes later",
	parameters: Type.Object({ run: Type.String() }),
	detachable: true,
	execute: (_toolCallId, params) =>
		new Promise<AgentToolResult>((resolve) => operations.set((params as { run: string }).run, resolve)),
};

const AGENT_PROMPT_PATTERN = /^Agent (\d+),/;

/** The agent a transcript belongs to, named by its first prompt. */
export function agentOf(messages: readonly TranscriptMessage[]): number {
	const content = messages.find((message) => message.role === "user")?.content;
	const text = typeof content === "string" ? content : (content?.find((part) => part.type === "text")?.text ?? "");
	return Number(AGENT_PROMPT_PATTERN.exec(text)?.[1] ?? 0);
}

export type TranscriptMessage = {
	readonly role: string;
	readonly toolName?: string;
	readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
};

export function delaySummary(histogram: ReturnType<typeof monitorEventLoopDelay>): DelaySummary {
	return { p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
}

/** Wait, by event-loop turns, until work still finishing lets go of its timers: the counts must repeat five times. */
export async function settle(): Promise<void> {
	let previous = "";
	let repeats = 0;
	for (let turn = 0; turn < 500 && repeats < 5; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
		const current = JSON.stringify(liveAsyncResources());
		repeats = current === previous ? repeats + 1 : 0;
		previous = current;
	}
}

/** The scripted provider and the model runtime that knows it, under the benchmark's temporary directory. */
export async function scriptedProvider(root: string, index: number) {
	const faux = registerFauxProvider({ tokenSize: { min: 25, max: 25 } });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(root, `models-${index}.json`),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	return { faux, model, modelRuntime };
}

export interface WakeResult {
	readonly latencyMs: readonly number[];
	readonly elapsedMs: number;
	readonly delay: DelaySummary;
}

/**
 * Wakes a sample of the released agents, one at a time or all at once, timing each from the wake to the agent being
 * woken, finished and released again, with the event-loop delay while they ran. `ids` is read each call, so agents
 * released later are included.
 */
export function wakeDriver(options: {
	readonly ids: () => readonly string[];
	readonly wake: (id: string) => Promise<number>;
	readonly script: (requests: number) => void;
}) {
	let woken = 0;
	/** The next `count` released agents not woken yet, spread over the population. */
	function nextToWake(count: number): string[] {
		const ids = options.ids();
		const stride = Math.max(1, Math.floor(ids.length / Math.max(1, count * 2)));
		const picked: string[] = [];
		for (let index = woken; index < ids.length && picked.length < count; index += stride)
			picked.push(ids[index] as string);
		woken += 1;
		return picked;
	}
	async function timedWakes(targets: readonly string[], concurrent: boolean): Promise<WakeResult> {
		options.script(targets.length);
		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		const started = performance.now();
		const latencyMs: number[] = [];
		if (concurrent) latencyMs.push(...(await Promise.all(targets.map((id) => options.wake(id)))));
		else for (const id of targets) latencyMs.push(await options.wake(id));
		const elapsedMs = performance.now() - started;
		histogram.disable();
		return { latencyMs, elapsedMs, delay: delaySummary(histogram) };
	}
	return {
		wakeSequential: (count: number) => timedWakes(nextToWake(count), false),
		wakeBurst: (count: number) => timedWakes(nextToWake(count), true),
	};
}
