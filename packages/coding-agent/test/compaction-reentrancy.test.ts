import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AutoCompactionRunOutcome } from "../src/core/agent-session-methods.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

type AutoCompactionRunner = AgentSession & {
	_runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		urgency?: "load_bearing" | "recoverable",
	): Promise<AutoCompactionRunOutcome>;
};

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function seedTranscript(harness: Harness): void {
	const now = Date.now();
	for (let turn = 0; turn < 5; turn++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `task ${turn}\nline a\nline b`,
			timestamp: now + turn * 2,
		});
		harness.sessionManager.appendMessage(assistant(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1));
	}
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function boundaryCount(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

/** Extension whose compaction hook blocks until the test releases it. */
function createGate() {
	let signalStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: string[] = [];
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", async (event) => {
			calls.push(event.reason);
			signalStarted();
			await released;
			return { compactedText: "[User]: retained exactly\n(filtered 3 lines)" };
		});
	};
	return { factory, started, release: () => release(), calls };
}

/** Extension that holds an automatic run after its boundary has committed. */
function createCommittedAutomaticGate() {
	let signalCommitted!: () => void;
	let release!: () => void;
	const committed = new Promise<void>((resolve) => {
		signalCommitted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: Array<{ reason: string; preserveRecent: number; query: string }> = [];
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => {
			calls.push({
				reason: event.reason,
				preserveRecent: event.parameters.preserve_recent,
				query: event.parameters.query,
			});
			return {
				compactedText:
					event.reason === "threshold"
						? Array.from({ length: 24 }, (_, index) => `[User]: automatic line ${index + 1}`).join("\n")
						: "manual summary",
			};
		});
		pi.on("session_compact", async (event) => {
			if (event.reason !== "threshold") return;
			signalCommitted();
			await released;
		});
	};
	return { factory, committed, release: () => release(), calls };
}

function createResponseGate(): { started: Promise<void>; wait: () => Promise<void>; release: () => void } {
	let signalStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		started,
		wait: async () => {
			signalStarted();
			await released;
		},
		release: () => release(),
	};
}

const noopTool: AgentTool = {
	name: "noop",
	label: "No-op",
	description: "Return immediately",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
};

/** Extension whose tree-navigation hook blocks until the test releases it. */
function createTreeGate() {
	let signalStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_before_tree", async () => {
			signalStarted();
			await released;
		});
	};
	return { factory, started, release: () => release() };
}

describe("manual compaction re-entrancy", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createHarness(factory: ExtensionFactory): Promise<Harness> {
		const harness = await createHarnessWithExtensions({ extensionFactories: [factory] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedTranscript(harness);
		return harness;
	}

	it("joins a concurrent compact() call to the single in-flight run", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);

		const first = harness.session.compact({ preserve_recent: 2 });
		await gate.started;
		expect(harness.session.isCompacting).toBe(true);
		const second = harness.session.compact({ preserve_recent: 2 });
		gate.release();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(gate.calls).toEqual(["manual"]);
		expect(secondResult).toBe(firstResult);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ reason: "manual", aborted: false });
		expect(boundaryCount(harness)).toBe(1);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("does not overwrite the live abort controller, so abortCompaction() cancels both callers", async () => {
		let signalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const abortable: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", async (event) => {
				signalStarted();
				await new Promise<void>((resolve) =>
					event.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return { cancel: true };
			});
		};
		const harness = await createHarness(abortable);

		const first = harness.session.compact({ preserve_recent: 2 });
		await started;
		const second = harness.session.compact({ preserve_recent: 2 });
		harness.session.abortCompaction();

		await expect(first).rejects.toThrow(/Compaction cancelled/);
		await expect(second).rejects.toThrow(/Compaction cancelled/);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", aborted: true }),
		]);
		expect(boundaryCount(harness)).toBe(0);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("emits manual completion when abort settlement fails before compaction starts", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		const failure = new Error("abort settlement failed");
		const rejectedQueue = Promise.reject(failure);
		void rejectedQueue.catch(() => {});
		(harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue = rejectedQueue;

		await expect(harness.session.compact({ preserve_recent: 2 })).rejects.toThrow(failure.message);

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				aborted: false,
				errorMessage: "Compaction failed: abort settlement failed",
			}),
		]);
		expect(harness.session.isCompacting).toBe(false);
		expect(gate.calls).toEqual([]);
	});

	it("keeps a failed abort drain handled while an automatic compaction settles", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
		await gate.started;

		const failure = new Error("abort settlement failed");
		const abort = vi.spyOn(harness.session, "abort").mockRejectedValue(failure);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		let manual: Promise<unknown> | undefined;
		try {
			manual = harness.session.compact({ preserve_recent: 2 });
			void manual.catch(() => {});
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(unhandledRejections).toEqual([]);

			gate.release();
			await expect(manual).rejects.toThrow(failure.message);
			await automatic;
			expect(unhandledRejections).toEqual([]);
		} finally {
			gate.release();
			if (manual) await Promise.allSettled([manual, automatic]);
			process.off("unhandledRejection", onUnhandledRejection);
			abort.mockRestore();
		}
	});

	it("runs only the requested manual compaction when an active response crosses the threshold", async () => {
		const responseGate = createResponseGate();
		const harness = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 1_000, maxTokens: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 100, preserve_recent: 2 } },
			tools: [noopTool],
			responses: [
				{ toolCalls: [{ id: "noop-1", name: "noop", args: {} }], usage: { input: 100, output: 10 } },
				{
					text: "second response",
					usage: { input: 950, output: 10, totalTokens: 960 },
					beforeEmit: responseGate.wait,
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({ compactedText: `${event.reason} summary` }));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedTranscript(harness);

		const prompt = harness.session.prompt("Run the tool, then continue responding.");
		await responseGate.started;
		const manual = harness.session.compact();
		responseGate.release();
		const [, manualResult] = await Promise.all([prompt, manual]);

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["manual"]);
		expect(boundaryCount(harness)).toBe(1);
		expect(manualResult.compactedText).toBe("manual summary");
	});

	it("cancels an in-flight automatic compaction before running the manual request", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
		await gate.started;

		const manual = harness.session.compact({ preserve_recent: 2 });
		gate.release();
		const manualResult = await manual;
		await automatic;

		expect(manualResult.compactedText).toBe("[User]: retained exactly\n(filtered 3 lines)");
		expect(gate.calls).toEqual(["threshold", "manual"]);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold", "manual"]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: true }),
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
		expect(boundaryCount(harness)).toBe(1);
	});

	it("does not resume an automatic retry after manual takeover of a committed boundary", async () => {
		const gate = createCommittedAutomaticGate();
		const harness = await createHarness(gate.factory);
		const continueSpy = vi.spyOn(harness.agent, "continue").mockResolvedValue();
		vi.useFakeTimers();
		try {
			const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction(
				"threshold",
				true,
				"recoverable",
			);
			await gate.committed;

			const manual = harness.session.compact({ preserve_recent: 0, query: "manual-only-query" });
			gate.release();
			const manualResult = await manual;
			await automatic;
			await vi.advanceTimersByTimeAsync(100);

			expect(continueSpy).not.toHaveBeenCalled();
			expect(manualResult.compactedText).toBe("manual summary");
			expect(gate.calls.at(-1)).toEqual({
				reason: "manual",
				preserveRecent: 0,
				query: "manual-only-query",
			});
			expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold", "manual"]);
			expect(harness.eventsOfType("compaction_end")).toEqual([
				expect.objectContaining({ reason: "threshold", aborted: false, manualTakeoverPending: true }),
				expect.objectContaining({ reason: "manual", aborted: false }),
			]);
			expect(boundaryCount(harness)).toBe(2);
		} finally {
			gate.release();
			continueSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does not resume an armed automatic retry after manual compaction completes", async () => {
		const factory: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => ({
				compactedText:
					event.reason === "threshold"
						? Array.from({ length: 24 }, (_, index) => `[User]: automatic line ${index + 1}`).join("\n")
						: "manual summary",
			}));
		};
		const harness = await createHarness(factory);
		const continueSpy = vi.spyOn(harness.agent, "continue").mockResolvedValue();
		vi.useFakeTimers();
		try {
			const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction(
				"threshold",
				true,
				"recoverable",
			);
			await automatic;

			await harness.session.compact({ preserve_recent: 0 });
			await vi.advanceTimersByTimeAsync(100);

			expect(continueSpy).not.toHaveBeenCalled();
		} finally {
			continueSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("keeps the agent event subscription connected during manual compaction", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);

		const manual = harness.session.compact({ preserve_recent: 2 });
		await gate.started;

		expect((harness.session as unknown as { _unsubscribeAgent?: () => void })._unsubscribeAgent).toBeTypeOf(
			"function",
		);

		gate.release();
		await manual;
	});

	it("delivers a prompt submitted by a manual compaction-end listener", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		let listenerObservedIdle = false;
		let queuedPrompt: Promise<void> | undefined;

		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.reason !== "manual" || !event.result) return;
			listenerObservedIdle = !harness.session.isCompacting;
			queuedPrompt = harness.session.prompt("queued after compaction");
		});

		const manual = harness.session.compact({ preserve_recent: 2 });
		await gate.started;
		gate.release();
		await manual;
		if (!queuedPrompt) throw new Error("manual compaction did not notify the queued prompt listener");
		await queuedPrompt;
		unsubscribe();

		expect(listenerObservedIdle).toBe(true);
		expect(harness.faux.callCount).toBe(1);
	});

	it("starts a fresh manual run from a manual completion listener", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		let followUp: Promise<unknown> | undefined;
		let requestedFollowUp = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (requestedFollowUp || event.type !== "compaction_end" || event.reason !== "manual" || !event.result) return;
			requestedFollowUp = true;
			seedTranscript(harness);
			followUp = harness.session.compact({ preserve_recent: 2 });
		});

		const first = harness.session.compact({ preserve_recent: 2 });
		await gate.started;
		gate.release();
		await first;
		if (!followUp) throw new Error("manual completion listener did not start a second compaction");
		await followUp;
		unsubscribe();

		expect(gate.calls).toEqual(["manual", "manual"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
	});

	it("compacts and resumes a response truncated below its requested output limit", async () => {
		const harness = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 1_000_000, maxTokens: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 0, preserve_recent: 2 } },
			responses: [
				{ text: "partial response", stopReason: "length", usage: { input: 100, output: 50, totalTokens: 150 } },
				{ text: "completed response", stopReason: "stop", usage: { input: 100, output: 50, totalTokens: 150 } },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						compactedText: "[User]: retained exactly\n(filtered 3 lines)",
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedTranscript(harness);

		await harness.session.prompt("finish the task");

		expect(harness.faux.callCount).toBe(2);
		const overflowEnds = harness.eventsOfType("compaction_end").filter((event) => event.reason === "overflow");
		expect(overflowEnds).toHaveLength(1);
		expect(overflowEnds[0]).toMatchObject({ aborted: false, willRetry: true });
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "completed response" }],
		});
	});

	it("stops after one compact-and-retry when a second response is truncated", async () => {
		const harness = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 1_000_000, maxTokens: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 0, preserve_recent: 2 } },
			responses: [
				{
					text: "first partial response",
					stopReason: "length",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
				{
					text: "second partial response",
					stopReason: "length",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						compactedText: "[User]: retained exactly\n(filtered 3 lines)",
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedTranscript(harness);

		await harness.session.prompt("finish the task");

		expect(harness.faux.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			willRetry: false,
			errorMessage: "Response truncation recovery stopped after one retry.",
		});
	});

	it("limits an uncompactable below-cap response to one recovery retry", async () => {
		const harness = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 1_000_000, maxTokens: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 0, preserve_recent: 2 } },
			responses: [
				{
					text: "first partial response",
					stopReason: "length",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
				{
					text: "second partial response",
					stopReason: "length",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		vi.useFakeTimers();
		try {
			const prompt = harness.session.prompt("finish the task");
			for (let retry = 0; retry < 4; retry++) {
				await vi.advanceTimersByTimeAsync(100);
			}
			await prompt;

			expect(harness.faux.callCount).toBe(2);
			expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(
				1,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still runs load-bearing overflow recovery after an uncompactable below-cap retry", async () => {
		const harness = await createHarnessWithExtensions({
			model: { ...fauxModel, contextWindow: 1_000_000, maxTokens: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 0, preserve_recent: 2 } },
			responses: [
				{
					text: "partial response",
					stopReason: "length",
					usage: { input: 100, output: 50, totalTokens: 150 },
				},
				{
					stopReason: "error",
					error: "prompt is too long",
					usage: { input: 100, output: 0, totalTokens: 100 },
				},
				{ text: "recovered response", stopReason: "stop", usage: { input: 100, output: 50, totalTokens: 150 } },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({
						compactedText: "[User]: retained exactly\n(filtered 3 lines)",
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		vi.useFakeTimers();
		try {
			const prompt = harness.session.prompt("finish the task");
			for (let retry = 0; retry < 4; retry++) {
				await vi.advanceTimersByTimeAsync(100);
			}
			await prompt;

			expect(harness.faux.callCount).toBe(3);
			expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(
				2,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("allows a fresh manual compaction once the previous run settles", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);

		const first = harness.session.compact({ preserve_recent: 2 });
		await gate.started;
		gate.release();
		await first;
		expect(harness.session.isCompacting).toBe(false);

		// Fresh transcript so the released latch can own a second physical run.
		seedTranscript(harness);
		const second = await harness.session.compact({ preserve_recent: 2 });

		expect(second.rung).toBe("extension");
		expect(gate.calls).toEqual(["manual", "manual"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(boundaryCount(harness)).toBe(2);
	});
	test("records and clears the active reason for manual and automatic compaction", async () => {
		const manualGate = createGate();
		const manualHarness = await createHarness(manualGate.factory);
		const manual = manualHarness.session.compact({ preserve_recent: 2 });
		await manualGate.started;
		assert.equal(manualHarness.session.compactionReason, "manual");
		manualGate.release();
		await manual;
		assert.equal(manualHarness.session.compactionReason, undefined);

		const automaticGate = createGate();
		const automaticHarness = await createHarness(automaticGate.factory);
		const automatic = (automaticHarness.session as AutoCompactionRunner)._runAutoCompaction(
			"threshold",
			false,
			"recoverable",
		);
		await automaticGate.started;
		assert.equal(automaticHarness.session.compactionReason, "threshold");
		automaticGate.release();
		await automatic;
		assert.equal(automaticHarness.session.compactionReason, undefined);
	});
	test("records and clears the active reason during branch navigation", async () => {
		const treeGate = createTreeGate();
		const harness = await createHarness(treeGate.factory);
		const targetId = harness.sessionManager.getTree()[0]?.entry.id;
		assert.ok(targetId);

		const navigation = harness.session.navigateTree(targetId, { summarize: false });
		await treeGate.started;
		assert.equal(harness.session.compactionReason, "branchSummary");
		treeGate.release();
		const result = await navigation;

		assert.equal(result.cancelled, false);
		assert.equal(harness.session.compactionReason, undefined);
	});
	test("preserves an outer automatic reason across overlapping branch navigation", async () => {
		const compactionGate = createGate();
		const treeGate = createTreeGate();
		const harness = await createHarnessWithExtensions({
			extensionFactories: [compactionGate.factory, treeGate.factory],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedTranscript(harness);

		const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false, "recoverable");
		await compactionGate.started;
		assert.equal(harness.session.compactionReason, "threshold");

		const targetId = harness.sessionManager.getTree()[0]?.entry.id;
		assert.ok(targetId);
		const navigation = harness.session.navigateTree(targetId, { summarize: false });
		await treeGate.started;
		assert.equal(harness.session.compactionReason, "threshold");

		treeGate.release();
		const result = await navigation;
		assert.equal(result.cancelled, false);
		assert.equal(harness.session.compactionReason, "threshold");

		compactionGate.release();
		await automatic;
		assert.equal(harness.session.compactionReason, undefined);
	});
});
