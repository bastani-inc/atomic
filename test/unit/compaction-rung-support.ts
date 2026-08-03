/**
 * Shared fixtures for the compaction fallback-rung matrix (RFC §8).
 *
 * Kept out of `*.test.ts` so `bun test test/unit` does not treat it as a suite.
 */

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { DEFAULT_COMPACTION_SETTINGS } from "../../packages/coding-agent/src/core/compaction/compaction.js";
import type { CompactionRunRequest } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type {
	BorrowedPlanner,
	NumberedRegion,
	PlannerAuth,
	VerbatimCompactionParameters,
	VerbatimCompactionPreparation,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { resolvePlannerRequest } from "../../packages/coding-agent/src/core/compaction/range-planner.js";

export const PARAMETERS: VerbatimCompactionParameters = {
	compression_ratio: 0.5,
	preserve_recent: 2,
	query: "test focus",
};

export function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "primary",
		id: "planner-a",
		api: "openai-responses",
		baseUrl: "https://primary.example",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
		...overrides,
	} as Model<Api>;
}

export function region(lineCount = 60, protectedLines: number[] = []): NumberedRegion {
	return {
		__brand: "NumberedRegion",
		lines: Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`),
		headerLineNumbers: new Set<number>(),
		priorMarkerNs: new Map<number, number>(),
		protectedLineNumbers: new Set<number>(protectedLines),
		tokenEstimate: lineCount * 4,
	} as NumberedRegion;
}

export function preparation(overrides: Partial<VerbatimCompactionPreparation> = {}): VerbatimCompactionPreparation {
	const built = overrides.region ?? region();
	return {
		firstKeptEntryId: "tail-1",
		region: built,
		regionEntryIds: ["e1", "e2"],
		keptTailMessageCount: 2,
		tokensBefore: 10_000,
		parameters: PARAMETERS,
		settings: DEFAULT_COMPACTION_SETTINGS,
		...overrides,
	};
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as Usage;

/** One scripted planner response. */
export interface ScriptedResponse {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	usage?: Partial<Usage>;
	/** Throw from the stream instead of returning a message. */
	throws?: string;
}

export interface RecordedCall {
	model: Model<Api>;
	options: SimpleStreamOptions;
}

export interface ScriptedStream {
	streamFn: StreamFn;
	calls: RecordedCall[];
}

/**
 * Build a stream function that answers per model id, falling back to `default`.
 * Each entry is consumed in order; the last entry repeats.
 */
export function scriptedStream(script: Record<string, ScriptedResponse[]>): ScriptedStream {
	const calls: RecordedCall[] = [];
	const cursors = new Map<string, number>();
	const streamFn = ((model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) => {
		calls.push({ model, options: options ?? ({} as SimpleStreamOptions) });
		const key = script[model.id] ? model.id : "default";
		const entries = script[key] ?? [{ text: "1,10\n" }];
		const index = Math.min(cursors.get(key) ?? 0, entries.length - 1);
		cursors.set(key, index + 1);
		const scripted = entries[index];
		return {
			result: async (): Promise<AssistantMessage> => {
				if (scripted.throws) throw new Error(scripted.throws);
				return {
					role: "assistant",
					content: scripted.text === undefined ? [] : [{ type: "text", text: scripted.text }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { ...ZERO_USAGE, ...scripted.usage },
					stopReason: scripted.stopReason ?? (scripted.errorMessage ? "error" : "stop"),
					...(scripted.errorMessage ? { errorMessage: scripted.errorMessage } : {}),
					timestamp: Date.now(),
				} as AssistantMessage;
			},
		};
	}) as unknown as StreamFn;
	return { streamFn, calls };
}

export function borrowed(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
	auth: PlannerAuth = { apiKey: "primary-key" },
): BorrowedPlanner {
	return { model, budget: resolvePlannerRequest(model, thinkingLevel), auth };
}

/** Minimal `FallbackModelLookup` over a fixed candidate set. */
export function registryOf(models: Model<Api>[], unauthenticated: string[] = []) {
	const authenticated = (model: Model<Api>) => !unauthenticated.includes(model.id);
	return {
		getAvailableSnapshot: () => models.filter(authenticated),
		getModel: (provider: string, id: string) =>
			models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: (provider: string) =>
			models.some((model) => model.provider === provider && authenticated(model)),
	};
}
export function runRequest(overrides: Partial<CompactionRunRequest> & { streamFn: StreamFn }): CompactionRunRequest {
	return {
		resolveAuth: async () => ({ apiKey: "primary-key" }),
		thinkingLevel: "high",
		urgency: "recoverable",
		...overrides,
	};
}
