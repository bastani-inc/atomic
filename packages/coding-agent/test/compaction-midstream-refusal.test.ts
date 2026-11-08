import assert from "node:assert/strict";
import type { AssistantMessage, Context } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import {
	type CompactionRungResult,
	type CompactionRunRequest,
	runVerbatimCompaction,
} from "../src/core/compaction/compaction-runner.js";
import type { NumberedRegion, VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
import { policyRefusalPhase, syntheticErrorResponse } from "../src/core/compaction/planner-outcome.js";
import { planDeletedLineRanges, RangePlanError } from "../src/core/compaction/range-planner.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import {
	conversationRegion,
	fallbackModel,
	plannerModel,
	preparationFor,
	REFUSED_BEFORE_OUTPUT,
	REFUSED_MIDSTREAM,
} from "./compaction-midstream-fixtures.js";
import { planner } from "./compaction-planner-fixtures.js";
import { plannerRequest } from "./structured-planner-test-helpers.js";
import { createFauxStreamFn, type FauxResponseInput } from "./test-harness.js";

const WHOLE = preparationFor(conversationRegion(8));
const timestamp = new Date(0).toISOString();
const summaryEntries: SessionEntry[] = [
	{
		type: "message",
		id: "old",
		parentId: null,
		timestamp,
		message: { role: "user", content: "history", timestamp: 0 },
	},
	{
		type: "message",
		id: "tail",
		parentId: "old",
		timestamp,
		message: { role: "user", content: "recent".repeat(20000), timestamp: 1 },
	},
];
const SUMMARY_MARKER = /structured context checkpoint summary/;

interface Run {
	readonly result: CompactionRungResult;
	readonly models: string[];
	readonly contexts: Context[];
}

interface RunOptions extends Partial<CompactionRunRequest> {
	readonly preparation?: VerbatimCompactionPreparation;
}

function fallbackContext() {
	return {
		fallbackModels: ["test/fallback"],
		preferredProvider: "test",
		sessionThinkingLevel: "off" as const,
		registry: {
			getAvailableSnapshot: () => [plannerModel, fallbackModel],
			getModel: (provider: string, id: string) =>
				[plannerModel, fallbackModel].find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
	};
}

function recording(responses: FauxResponseInput[]) {
	const { streamFn, state } = createFauxStreamFn(responses);
	const models: string[] = [];
	return {
		models,
		state,
		streamFn: ((candidate, context, options) => {
			models.push(candidate.id);
			return streamFn(candidate, context, options);
		}) satisfies CompactionRunRequest["streamFn"],
	};
}

async function compact(responses: FauxResponseInput[], options: RunOptions = {}): Promise<Run> {
	const { preparation = WHOLE, ...request } = options;
	const stream = recording(responses);
	const result = await runVerbatimCompaction(preparation, plannerModel, {
		streamFn: stream.streamFn,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		...request,
	});
	return { result, models: stream.models, contexts: stream.state.contexts };
}

function messageCounts(contexts: readonly Context[]): number[] {
	return contexts.map((context) => plannerRequest(context).messages.length);
}

function verbatim(region: NumberedRegion, ranges: Array<[number, number]>): string {
	const deleted = ranges.map(([start, end]) => ({ start, end }));
	return reconstructCompactedTranscript(region, validateDeletedRanges(deleted, region)).text;
}

function assertNoSummaryRequest(contexts: readonly Context[]): void {
	for (const context of contexts) assert.doesNotMatch(JSON.stringify(context), SUMMARY_MARKER);
}

function aborted(controller: AbortController): FauxResponseInput {
	return { text: "1:1,2", beforeEmit: () => controller.abort() };
}

/** A request that never completes until its signal aborts, and a promise that settles once it has started. */
function hangingRequest(): { response: FauxResponseInput; started: Promise<void> } {
	const started = Promise.withResolvers<void>();
	return {
		started: started.promise,
		response: {
			text: "1:1,2",
			beforeEmit: (signal) => {
				started.resolve();
				return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			},
		},
	};
}

/** Settle `start()` after the planning time limit runs out, once the hanging request is in flight. */
async function settledAfterTimeLimit<T>(
	start: () => Promise<T>,
	started: Promise<void>,
	limitMs: number,
): Promise<PromiseSettledResult<T>> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	try {
		const running = Promise.allSettled([start()]);
		await started;
		await vi.advanceTimersByTimeAsync(limitMs);
		return (await running)[0];
	} finally {
		vi.useRealTimers();
	}
}

test("a mid-stream refusal is retried, then planned in halves into one verbatim plan without a summary (#4543)", async () => {
	const { result, models, contexts } = await compact([REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "1:1,3\n2:2,3", "1:1,3"], {
		summaryEntries,
	});

	assert.equal(result.backend, "planner");
	assert.equal(result.rung, "planned");
	assert.equal(result.summary, undefined);
	assert.deepEqual(models, ["primary", "primary", "primary", "primary"]);
	assert.deepEqual(messageCounts(contexts), [8, 8, 4, 4]);
	assertNoSummaryRequest(contexts);
	assert.deepEqual(result.ranges, [
		{ start: 1, end: 3 },
		{ start: 6, end: 7 },
		{ start: 17, end: 19 },
	]);
	assert.equal(
		result.text,
		verbatim(WHOLE.region, [
			[1, 3],
			[6, 7],
			[17, 19],
		]),
	);
	assert.deepEqual(
		[...plannerRequest(contexts[2]).messages, ...plannerRequest(contexts[3]).messages].flatMap(
			(message) => message.lines,
		),
		WHOLE.region.lines,
	);
	assert.equal(result.usage?.input, 400);
	assert.equal(result.usage?.output, 2 * 25_000 + 2 * 50);
});

test("a mid-stream refusal that the retry gets past is not split (#4543)", async () => {
	const { result, contexts } = await compact([REFUSED_MIDSTREAM, "1:1,3"], { summaryEntries });

	assert.equal(result.backend, "planner");
	assert.deepEqual(result.ranges, [{ start: 1, end: 3 }]);
	assert.deepEqual(messageCounts(contexts), [8, 8]);
});

test("a retry that fails without a refusal still reaches the summary on the same model (#4543)", async () => {
	for (const retryFailure of ["1:900,999", { stopReason: "error" as const, error: "Invalid request" }]) {
		const { result, models, contexts } = await compact([REFUSED_MIDSTREAM, retryFailure, "checkpoint"], {
			summaryEntries,
		});

		assert.equal(result.backend, "summary");
		assert.deepEqual(models, ["primary", "primary", "primary"]);
		assert.deepEqual(messageCounts(contexts.slice(0, 2)), [8, 8]);
		assert.match(JSON.stringify(contexts[2]), SUMMARY_MARKER);
	}
});

test("a load-bearing run whose retry fails without a refusal summarizes instead of clearing context (#4543)", async () => {
	const { result, contexts } = await compact([REFUSED_MIDSTREAM, "1:900,999", "checkpoint"], {
		summaryEntries,
		urgency: "load_bearing",
	});

	assert.equal(result.rung, "planned");
	assert.equal(result.backend, "summary");
	assert.equal(result.freshReason, undefined);
	assert.equal(contexts.length, 3);
	assert.match(JSON.stringify(contexts[2]), SUMMARY_MARKER);
});

test("an input refusal is not retried or split and goes straight to the summary (#4543)", async () => {
	const { result, models, contexts } = await compact([REFUSED_BEFORE_OUTPUT, "checkpoint"], { summaryEntries });

	assert.equal(result.backend, "summary");
	assert.deepEqual(models, ["primary", "primary"]);
	assert.deepEqual(messageCounts(contexts.slice(0, 1)), [8]);
	assert.match(JSON.stringify(contexts[1]), SUMMARY_MARKER);
});

test("a thrown refusal is an input refusal and goes straight to the summary (#4543)", async () => {
	const { streamFn, state } = createFauxStreamFn(["checkpoint"]);
	let planningRequests = 0;
	const result = await runVerbatimCompaction(WHOLE, plannerModel, {
		streamFn: (candidate, context, options) => {
			if (!SUMMARY_MARKER.test(JSON.stringify(context))) {
				planningRequests++;
				throw new Error("The model refused to complete the request");
			}
			return streamFn(candidate, context, options);
		},
		summaryEntries,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
	});

	assert.equal(planningRequests, 1);
	assert.equal(result.backend, "summary");
	assert.equal(state.callCount, 1);
});

test("every part refused stops after four planner requests and then summarizes (#4543)", async () => {
	const { result, contexts } = await compact(
		[REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "checkpoint"],
		{ summaryEntries },
	);

	assert.equal(result.backend, "summary");
	assert.equal(contexts.length, 5);
	assert.deepEqual(messageCounts(contexts.slice(0, 4)), [8, 8, 4, 2]);
	assert.match(JSON.stringify(contexts[4]), SUMMARY_MARKER);
});

test("refused halves are planned in quarters and every part's ranges merge (#4543)", async () => {
	const { result, contexts } = await compact(
		[
			REFUSED_MIDSTREAM,
			REFUSED_MIDSTREAM,
			REFUSED_MIDSTREAM,
			"1:1,3",
			"2:1,2",
			REFUSED_BEFORE_OUTPUT,
			"1:2,3",
			"1:1,1\n2:1,1",
		],
		{ summaryEntries },
	);

	assert.equal(result.backend, "planner");
	assert.deepEqual(messageCounts(contexts), [8, 8, 4, 2, 2, 4, 2, 2]);
	assertNoSummaryRequest(contexts);
	assert.deepEqual(result.ranges, [
		{ start: 1, end: 3 },
		{ start: 13, end: 14 },
		{ start: 18, end: 19 },
		{ start: 25, end: 25 },
		{ start: 29, end: 29 },
	]);
});

test("without summary entries a refused split ends as a policy refusal that names its phase (#4543)", async () => {
	const stream = recording([REFUSED_MIDSTREAM]);
	const error = await runVerbatimCompaction(WHOLE, plannerModel, {
		streamFn: stream.streamFn,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
	}).catch((caught: unknown) => caught);

	assert.ok(error instanceof RangePlanError);
	assert.equal(error.outcome?.kind, "policyRefusal");
	assert.equal(error.outcome?.kind === "policyRefusal" ? error.outcome.phase : undefined, "midstream");
	assert.equal(stream.state.callCount, 4);
});

test("a load-bearing run whose split is refused starts a fresh window after four planner requests (#4543)", async () => {
	const { result, contexts } = await compact([REFUSED_MIDSTREAM], { urgency: "load_bearing" });

	assert.equal(result.rung, "fresh");
	assert.equal(contexts.length, 4);
	assert.ok(result.freshReason);
});

test("a region holding one message is retried but cannot be split (#4543)", async () => {
	const { result, contexts } = await compact([REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "checkpoint"], {
		preparation: preparationFor(conversationRegion(1, 30)),
		summaryEntries,
	});

	assert.equal(result.backend, "summary");
	assert.equal(contexts.length, 3);
	assert.match(JSON.stringify(contexts[2]), SUMMARY_MARKER);
});

test("cancelling during the split ends the run without another request or a summary (#4543)", async () => {
	const controller = new AbortController();
	const stream = recording([REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, aborted(controller), "checkpoint"]);

	await assert.rejects(
		runVerbatimCompaction(WHOLE, plannerModel, {
			streamFn: stream.streamFn,
			resolveAuth: async () => ({ apiKey: "key" }),
			thinkingLevel: "off",
			urgency: "load_bearing",
			signal: controller.signal,
			summaryEntries,
		}),
		/Compaction cancelled/,
	);
	assert.equal(stream.state.callCount, 3);
});

test("the planning time limit ends a split without a summary and a load-bearing run starts fresh (#4543)", async () => {
	const hanging = hangingRequest();
	const stream = recording([REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, hanging.response, "checkpoint"]);
	const settled = await settledAfterTimeLimit(
		() =>
			runVerbatimCompaction(WHOLE, plannerModel, {
				streamFn: stream.streamFn,
				resolveAuth: async () => ({ apiKey: "key" }),
				thinkingLevel: "off",
				urgency: "load_bearing",
				planningTimeoutMs: 1_000,
				summaryEntries,
			}),
		hanging.started,
		1_000,
	);

	assert.equal(settled.status, "fulfilled");
	assert.equal(settled.status === "fulfilled" ? settled.value.rung : undefined, "fresh");
	assert.match(settled.status === "fulfilled" ? (settled.value.freshReason ?? "") : "", /timed out after 1000 ms/);
	assert.equal(stream.state.callCount, 3);
});

test("a recoverable run whose split hits the planning time limit fails as a timeout (#4543)", async () => {
	const hanging = hangingRequest();
	const stream = recording([REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, hanging.response, "checkpoint"]);
	const settled = await settledAfterTimeLimit(
		() =>
			runVerbatimCompaction(WHOLE, plannerModel, {
				streamFn: stream.streamFn,
				resolveAuth: async () => ({ apiKey: "key" }),
				thinkingLevel: "off",
				urgency: "recoverable",
				planningTimeoutMs: 1_000,
				summaryEntries,
			}),
		hanging.started,
		1_000,
	);

	assert.equal(settled.status, "rejected");
	assert.ok(settled.status === "rejected" && settled.reason instanceof RangePlanError);
	assert.equal(settled.reason.outcome?.kind, "providerError");
	assert.equal(stream.state.callCount, 3);
});

test("a failed split and summary advance to the borrowed planner (#4543)", async () => {
	const { result, models } = await compact(
		[REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "1:1,3"],
		{ summaryEntries, fallback: fallbackContext() },
	);

	assert.deepEqual(models, ["primary", "primary", "primary", "primary", "primary", "fallback"]);
	assert.equal(result.backend, "planner");
	assert.equal(result.model, "test/fallback");
	assert.deepEqual(result.plannerModel, { provider: "test", id: "fallback", thinkingLevel: "off" });
});

test("a borrowed planner recovers from a mid-stream refusal by splitting too (#4543)", async () => {
	const { result, models } = await compact(
		[{ stopReason: "error", error: "Invalid request" }, REFUSED_MIDSTREAM, REFUSED_MIDSTREAM, "1:1,3", "1:1,3"],
		{ summaryEntries, fallback: fallbackContext() },
	);

	assert.deepEqual(models, ["primary", "fallback", "fallback", "fallback", "fallback"]);
	assert.equal(result.backend, "planner");
	assert.deepEqual(result.plannerModel, { provider: "test", id: "fallback", thinkingLevel: "off" });
	assert.deepEqual(result.ranges, [
		{ start: 1, end: 3 },
		{ start: 17, end: 19 },
	]);
});

const REGION = conversationRegion(8);

function refusedResponse(usage: Partial<AssistantMessage["usage"]>): AssistantMessage {
	return {
		...syntheticErrorResponse(plannerModel, "The model refused to complete the request"),
		usage: { ...syntheticErrorResponse(plannerModel, "").usage, ...usage },
	};
}

test("a refusal is mid-stream once output or reasoning tokens were generated (#4543)", () => {
	assert.equal(policyRefusalPhase(refusedResponse({})), "input");
	assert.equal(policyRefusalPhase(refusedResponse({ output: 1 })), "midstream");
	assert.equal(policyRefusalPhase(refusedResponse({ reasoning: 1 })), "midstream");
	assert.equal(policyRefusalPhase(refusedResponse({ output: 0, reasoning: 0 })), "input");
	assert.equal(
		policyRefusalPhase({ ...refusedResponse({}), usage: undefined } as unknown as AssistantMessage),
		"input",
	);
});

test("the planner reports each refusal's phase on the outcome (#4543)", async () => {
	const cases: Array<[AssistantMessage | Error, "input" | "midstream"]> = [
		[refusedResponse({ output: 4_000, reasoning: 3_000 }), "midstream"],
		[refusedResponse({ output: 0, reasoning: 2_000 }), "midstream"],
		[refusedResponse({}), "input"],
		[new Error("The model refused to complete the request"), "input"],
	];
	for (const [refusal, phase] of cases) {
		const outcome = await planDeletedLineRanges(REGION, WHOLE.parameters, planner(plannerModel, undefined), 16, {
			streamFn: (() => {
				if (refusal instanceof Error) throw refusal;
				return { result: async () => refusal };
			}) as never,
		});

		assert.equal(outcome.kind, "policyRefusal");
		assert.equal(outcome.kind === "policyRefusal" ? outcome.phase : undefined, phase);
	}
});
