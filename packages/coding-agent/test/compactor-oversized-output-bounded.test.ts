import assert from "node:assert/strict";
import type { AgentMessage, AgentTool } from "@bastani/atomic-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai";
import { Type } from "typebox";
import { afterEach, describe, it, vi } from "vitest";
import { estimateTextTokens, estimateTokens } from "../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const API_KEY = "sk-morph-secret-key-0123456789";
const WINDOW = 40_000;
const RESERVE = 4_000;
/** About 36,500 estimated tokens: the boundary built from it lands between the trigger and the window. */
const ABOVE_TRIGGER_WORDS = 29_200;
/** About 50,000 estimated tokens: more than the whole window. */
const ABOVE_WINDOW_WORDS = 40_000;
/** A first prompt that leaves the context between the trigger and the window. */
const LARGE_PROMPT = `start\n${"word ".repeat(29_000)}`;

const smallResultTool: AgentTool = {
	name: "small_result",
	label: "Small result",
	description: "Returns a short result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

interface TurnCounts {
	compactorCalls: number;
	providerRequests: number;
	overflowErrors: number;
	compactions: string[];
}

interface Probe {
	harness: Harness;
	counts(): TurnCounts;
	since(before: TurnCounts): TurnCounts;
	/** A provider reply that fails the way a real provider does when the request is larger than its window. */
	windowed(reply: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory;
	/** A provider reply that reports a context overflow whatever the request's size. */
	overflow: FauxResponseFactory;
}

function requestTokens(context: { systemPrompt?: string; messages: readonly unknown[] }): number {
	return (
		estimateTextTokens(context.systemPrompt ?? "") +
		context.messages.reduce<number>((sum, message) => sum + estimateTokens(message as AgentMessage), 0)
	);
}

async function probe(compactorWords: number): Promise<Probe> {
	let compactorCalls = 0;
	let providerRequests = 0;
	let overflowErrors = 0;
	vi.stubGlobal("fetch", (async () => {
		compactorCalls++;
		return new Response(JSON.stringify({ output: "word ".repeat(compactorWords) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch);
	const harness = await createHarness({
		models: [{ id: "windowed", contextWindow: WINDOW, maxTokens: 1_000 }],
		tools: [smallResultTool],
		settings: {
			compactionModel: "morph/morph-compactor",
			compaction: { enabled: true, reserveTokens: RESERVE },
			retry: { enabled: false },
		},
	});
	await harness.authStorage.modify("morph", async () => ({ type: "api_key", key: API_KEY }));
	const counts = (): TurnCounts => ({
		compactorCalls,
		providerRequests,
		overflowErrors,
		compactions: harness
			.eventsOfType("compaction_end")
			.filter((event) => event.result !== undefined)
			.map((event) => `${event.reason}${event.midTurn ? " (mid-turn)" : ""}: ${event.result?.form}`),
	});
	return {
		harness,
		counts,
		since(before) {
			const now = counts();
			return {
				compactorCalls: now.compactorCalls - before.compactorCalls,
				providerRequests: now.providerRequests - before.providerRequests,
				overflowErrors: now.overflowErrors - before.overflowErrors,
				compactions: now.compactions.slice(before.compactions.length),
			};
		},
		overflow: () => {
			providerRequests++;
			overflowErrors++;
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `prompt is too long: ${WINDOW + 500} tokens > ${WINDOW} maximum`,
			});
		},
		windowed(reply) {
			return (context) => {
				providerRequests++;
				const tokens = requestTokens(context);
				if (tokens <= WINDOW) return reply();
				overflowErrors++;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `prompt is too long: ${tokens} tokens > ${WINDOW} maximum`,
				});
			};
		},
	};
}

describe("a compactor whose output stays past the trigger or the window never compacts in a loop", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		vi.unstubAllGlobals();
		await harness?.cleanup();
		harness = undefined;
	});

	it("the pre-request check compacts once per user turn when the output stays above the trigger", async () => {
		const run = await probe(ABOVE_TRIGGER_WORDS);
		harness = run.harness;
		harness.setResponses(Array.from({ length: 8 }, () => run.windowed(() => fauxAssistantMessage("answer"))));
		await harness.session.prompt(LARGE_PROMPT);
		assert.deepEqual(run.counts(), { compactorCalls: 0, providerRequests: 1, overflowErrors: 0, compactions: [] });

		const turns: TurnCounts[] = [];
		for (const prompt of ["continue", "and again", "once more"]) {
			const before = run.counts();
			await harness.session.prompt(prompt);
			turns.push(run.since(before));
		}
		for (const turn of turns) {
			assert.deepEqual(turn, {
				compactorCalls: 1,
				providerRequests: 1,
				overflowErrors: 0,
				compactions: ["threshold: compacted"],
			});
		}
		assert.equal(harness.session.getLastAssistantText(), "answer");
	});

	it("the pre-request check compacts once, then the provider's overflow is recovered once and surfaced, when the output is above the window", async () => {
		const run = await probe(ABOVE_WINDOW_WORDS);
		harness = run.harness;
		harness.setResponses(Array.from({ length: 8 }, () => run.windowed(() => fauxAssistantMessage("answer"))));
		await harness.session.prompt(LARGE_PROMPT);

		const turns: TurnCounts[] = [];
		for (const prompt of ["continue", "and again"]) {
			const before = run.counts();
			await harness.session.prompt(prompt);
			await harness.session.agent.waitForIdle();
			turns.push(run.since(before));
		}
		for (const turn of turns) {
			assert.ok(turn.compactorCalls >= 1 && turn.compactorCalls <= 2, JSON.stringify(turn));
			assert.equal(turn.providerRequests, 2, JSON.stringify(turn));
			assert.equal(turn.overflowErrors, 2, JSON.stringify(turn));
			assert.equal(turn.compactions.at(-1), "overflow: compacted", JSON.stringify(turn));
		}
		assert.match(
			harness.eventsOfType("compaction_end").at(-1)?.errorMessage ?? "",
			/Context overflow recovery failed after one compact-and-retry attempt/u,
		);
	});

	for (const [size, words] of [
		["above the trigger", ABOVE_TRIGGER_WORDS],
		["above the window", ABOVE_WINDOW_WORDS],
	] as const) {
		it(`provider overflow recovery compacts and retries once when the output is ${size}`, async () => {
			const run = await probe(words);
			harness = run.harness;
			harness.setResponses([
				run.overflow,
				...Array.from({ length: 6 }, () => run.windowed(() => fauxAssistantMessage("recovered"))),
			]);
			await harness.session.prompt("start");
			await harness.session.agent.waitForIdle();
			const turn = run.since({ compactorCalls: 0, providerRequests: 0, overflowErrors: 0, compactions: [] });
			assert.equal(turn.compactorCalls, 1, JSON.stringify(turn));
			assert.equal(turn.providerRequests, 2, JSON.stringify(turn));
			if (size === "above the trigger") {
				assert.deepEqual(turn.compactions, ["overflow: compacted"]);
				assert.equal(harness.session.getLastAssistantText(), "recovered");
			} else {
				assert.deepEqual(turn.compactions, ["overflow: compacted"]);
				assert.match(
					harness.eventsOfType("compaction_end").at(-1)?.errorMessage ?? "",
					/Context overflow recovery failed after one compact-and-retry attempt/u,
				);
			}
		});

		it(`a turn of tool calls compacts once before its first request when the output is ${size}`, async () => {
			const run = await probe(words);
			harness = run.harness;
			harness.session.setActiveToolsByName(["small_result"]);
			const toolCall = run.windowed(() =>
				fauxAssistantMessage([fauxToolCall("small_result", {})], { stopReason: "toolUse" }),
			);
			harness.setResponses([
				run.windowed(() => fauxAssistantMessage("first")),
				...Array.from({ length: 5 }, () => toolCall),
				...Array.from({ length: 6 }, () => run.windowed(() => fauxAssistantMessage("done"))),
			]);
			await harness.session.prompt(LARGE_PROMPT);
			const before = run.counts();
			await harness.session.prompt("use the tool five times");
			await harness.session.agent.waitForIdle();
			const turn = run.since(before);
			if (size === "above the trigger") {
				assert.deepEqual(turn, {
					compactorCalls: 1,
					providerRequests: 6,
					overflowErrors: 0,
					compactions: ["threshold: compacted"],
				});
				assert.equal(harness.session.getLastAssistantText(), "done");
			} else {
				assert.deepEqual(turn, {
					compactorCalls: 2,
					providerRequests: 2,
					overflowErrors: 2,
					compactions: ["threshold: compacted", "overflow: compacted"],
				});
				assert.match(
					harness.eventsOfType("compaction_end").at(-1)?.errorMessage ?? "",
					/Context overflow recovery failed after one compact-and-retry attempt/u,
				);
			}
		});
	}
});
