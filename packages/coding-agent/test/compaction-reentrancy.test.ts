import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

type AutoCompactionRunner = AgentSession & {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void>;
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

	it("fails fast instead of racing an in-flight automatic compaction", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);

		const auto = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
		await gate.started;
		expect(harness.session.isCompacting).toBe(true);

		await expect(harness.session.compact({ preserve_recent: 2 })).rejects.toThrow(
			/automatic compaction is already in progress/i,
		);

		expect(gate.calls).toEqual(["threshold"]);
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "threshold" })]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);

		gate.release();
		await auto;

		expect(gate.calls).toEqual(["threshold"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ reason: "threshold" })]);
		expect(boundaryCount(harness)).toBe(1);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("publishes automatic ownership before synchronously notifying start listeners", async () => {
		const gate = createGate();
		const harness = await createHarness(gate.factory);
		let manualOutcome: Promise<"fulfilled" | Error> | undefined;

		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "compaction_start" || event.reason !== "threshold" || event.midTurn) return;
			// Re-enter from inside the synchronous start notification. Attaching the
			// rejection handler here also avoids an unhandled-rejection warning.
			manualOutcome = harness.session.compact({ preserve_recent: 2 }).then(
				() => "fulfilled" as const,
				(error: Error) => error,
			);
		});

		const auto = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
		await gate.started;
		expect(manualOutcome).toBeDefined();

		gate.release();
		await auto;

		const outcome = await manualOutcome;
		unsubscribe();

		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toMatch(/automatic compaction is already in progress/i);
		expect(gate.calls).toEqual(["threshold"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(boundaryCount(harness)).toBe(1);
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
		const automatic = (automaticHarness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
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

		const automatic = (harness.session as AutoCompactionRunner)._runAutoCompaction("threshold", false);
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
