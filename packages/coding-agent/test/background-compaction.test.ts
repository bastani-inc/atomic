import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { committedContextMessages } from "../src/core/agent-session-background-compaction.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	BACKGROUND_COMPACTION_RESULT_TYPE,
	BACKGROUND_COMPACTION_RETRY_BASE_MS,
	type BackgroundCompactionResultRecord,
	type CompactionReadyWake,
	serializeBackgroundCompactionState,
} from "../src/core/compaction/background-compaction.ts";
import {
	BackgroundCompactionCommitError,
	BackgroundCompactionConfigError,
	BackgroundCompactionPersistError,
	BackgroundCompactionPlanningError,
	isBackgroundCompactionDiscardedError,
	isBackgroundCompactionNotCompactableError,
} from "../src/core/compaction/background-compaction-errors.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { sessionLifetime } from "../src/core/session-lifecycle-work.ts";
import {
	type CompactionEntry,
	type CustomEntry,
	type SessionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { StorageUnavailableError } from "../src/core/storage/errors.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createHarnessWithExtensions, type FauxResponseInput, type Harness } from "./test-harness.ts";

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");

interface PlannerCall {
	readonly reason: string;
	readonly branchIds: string[];
	/** True when a foreground compaction owned the session while the planner ran (it blocks the turn). */
	readonly foreground: boolean;
}

/**
 * A `session_before_compact` extension standing in for the planner: it supplies the compacted text
 * once released, or an empty text (a failed compaction) while `failures` remain.
 */
class Planner {
	readonly calls: PlannerCall[] = [];
	/** `fromExtension` of each `session_compact_failed` event. */
	readonly compactFailures: boolean[] = [];
	session: AgentSession | undefined;
	failures = 0;
	/** Undefined lets the model planner run. */
	text: string | undefined = "[User]: retained";
	#released = false;
	#releaseWaiters: Array<() => void> = [];
	#callWaiters: Array<{ count: number; resolve: () => void }> = [];

	constructor(released = false) {
		this.#released = released;
	}

	readonly factory: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", async (event) => {
			this.calls.push({
				reason: event.reason,
				branchIds: event.branchEntries.map((entry) => entry.id),
				foreground: this.session?.isCompacting === true,
			});
			for (const waiter of this.#callWaiters.filter((item) => this.calls.length >= item.count)) waiter.resolve();
			if (!this.#released) await new Promise<void>((resolve) => this.#releaseWaiters.push(resolve));
			if (this.failures > 0) {
				this.failures -= 1;
				return { compactedText: "   " };
			}
			return this.text === undefined ? undefined : { compactedText: this.text };
		});
		pi.on("session_compact_failed", (event) => {
			this.compactFailures.push(event.fromExtension);
		});
	};

	called(count = 1): Promise<void> {
		if (this.calls.length >= count) return Promise.resolve();
		return new Promise((resolve) => this.#callWaiters.push({ count, resolve }));
	}

	release(): void {
		this.#released = true;
		for (const resolve of this.#releaseWaiters.splice(0)) resolve();
	}
}

const BASE_SETTINGS: Partial<Settings> = {
	compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
};

function settingsWith(compaction: NonNullable<Settings["compaction"]>): Partial<Settings> {
	return { compaction: { ...BASE_SETTINGS.compaction, ...compaction } };
}

const SEED: FauxResponseInput = { text: "first answer", usage: { input: 300, output: 10 } };

interface HarnessOptions {
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	compactionWake?: { compactionReady(wake: CompactionReadyWake): void };
	sessionManager?: SessionManager;
	extensionFactories?: ExtensionFactory[];
}

async function createBackgroundHarness(
	responses: FauxResponseInput[],
	planner: Planner,
	options: HarnessOptions = {},
): Promise<Harness> {
	const tools = options.tools ?? [echoTool()];
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: options.settings ?? BASE_SETTINGS,
		responses,
		baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
		extensionFactories: [planner.factory, ...(options.extensionFactories ?? [])],
		...(options.compactionWake ? { compactionWake: options.compactionWake } : {}),
		...(options.sessionManager ? { sessionManager: options.sessionManager } : {}),
	});
	planner.session = harness.session;
	await harness.session.bindExtensions({});
	harness.session.setActiveToolsByName(tools.map((tool) => tool.name));
	harness.agent.convertToLlm = convertToLlm;
	return harness;
}

function echoTool(onExecute?: () => Promise<void>): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Returns a short result",
		parameters: Type.Object({}),
		execute: async () => {
			await onExecute?.();
			return { content: [{ type: "text", text: "echoed" }], details: {} };
		},
	};
}

function resultEntries(manager: SessionManager): CustomEntry<BackgroundCompactionResultRecord>[] {
	return manager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<BackgroundCompactionResultRecord> =>
				entry.type === "custom" && entry.customType === BACKGROUND_COMPACTION_RESULT_TYPE,
		);
}

function compactionEntries(manager: SessionManager): CompactionEntry[] {
	return manager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function backgroundStates(harness: Harness): string[] {
	return harness.eventsOfType("background_compaction").map((event) => event.compaction.state);
}

/** Seed history, then cross the soft threshold on a tool turn: the background task starts at the next turn. */
const TRIGGER: FauxResponseInput[] = [
	SEED,
	{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
	{ text: "after tool", usage: { input: 770, output: 10 } },
];

async function startBackgroundTask(harness: Harness, planner: Planner): Promise<void> {
	await harness.session.prompt(longPrompt);
	await harness.session.prompt(`${longPrompt}\nsecond`);
	await planner.called();
}

describe("background compaction (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	test("starts past the soft threshold, keeps turns running, and commits once at the next turn boundary (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(
			[...TRIGGER, { text: "after commit", usage: { input: 400, output: 10 } }],
			planner,
		);
		harnesses.push(harness);
		const extensionErrors: string[] = [];
		harness.session.extensionRunner.onError((error) => extensionErrors.push(String(error.error)));

		await harness.session.prompt(longPrompt);
		assert.equal(harness.session.compaction.state, "idle");
		assert.equal(planner.calls.length, 0, "below the soft threshold nothing starts");

		await harness.session.prompt(`${longPrompt}\nsecond`);
		await planner.called();
		assert.equal(harness.session.isCompacting, false);
		assert.equal(harness.eventsOfType("compaction_start").length, 0);
		assert.equal(harness.faux.callCount, 3, "the turn after the trigger ran while the planner was held");
		assert.equal(harness.session.compaction.state, "running");
		assert.equal(planner.calls[0].reason, "threshold");
		assert.equal(planner.calls[0].foreground, false);

		const prefixIds = planner.calls[0].branchIds;
		const branchAtStart = harness.sessionManager.getBranch().map((entry) => entry.id);
		assert.ok(prefixIds.length < branchAtStart.length, "entries appended after the safe point are not frozen");
		planner.release();
		const settled = await harness.session.awaitBackgroundCompaction();
		assert.equal(settled.state, "ready");
		const [stored] = resultEntries(harness.sessionManager);
		assert.equal(stored.data?.upToEntryId, prefixIds.at(-1));
		assert.equal(settled.upToEntryId, prefixIds.at(-1));
		assert.equal(settled.startedAt, stored.data?.startedAt);
		assert.equal(compactionEntries(harness.sessionManager).length, 0, "a ready result is not yet a boundary");

		const branchBeforeCommit = harness.sessionManager.getBranch();
		const upToIndex = branchBeforeCommit.findIndex((entry) => entry.id === stored.data?.upToEntryId);
		const tailBefore = branchBeforeCommit
			.slice(upToIndex + 1)
			.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message");
		const tailJson = tailBefore.map((entry) => JSON.stringify(entry));
		assert.ok(tailBefore.length >= 2, "entries were appended after the frozen prefix");

		await harness.session.prompt("next");
		const boundaries = compactionEntries(harness.sessionManager);
		assert.equal(boundaries.length, 1);
		assert.equal(boundaries[0].coveredThroughEntryId, stored.data?.upToEntryId);
		assert.equal(boundaries[0].summary, "[User]: retained");
		const backgroundEnds = harness.eventsOfType("compaction_end").filter((event) => event.background === true);
		assert.equal(backgroundEnds.length, 1);
		assert.equal(backgroundEnds[0].reason, "threshold");
		assert.equal(backgroundEnds[0].midTurn, true, "applied before the next prompt's first request");
		assert.equal(backgroundEnds[0].result?.compactedText, "[User]: retained");
		assert.equal(backgroundEnds[0].aborted, false);
		assert.equal(backgroundEnds[0].willRetry, false);
		assert.equal(harness.eventsOfType("compaction_start").length, 0);
		assert.equal(harness.session.compaction.state, "idle");
		assert.deepEqual(backgroundStates(harness), ["running", "ready", "idle"]);
		assert.deepEqual(extensionErrors, [], "a session without a wake dispatcher reports nothing");

		const tailAfter = tailBefore.map((entry) => JSON.stringify(harness.sessionManager.getEntry(entry.id)));
		assert.deepEqual(tailAfter, tailJson, "appended entries stay byte-identical");
		const projection = harness.sessionManager.buildSessionProjection();
		for (const entry of tailBefore) {
			const projected = projection.entries.find((item) => item.sourceEntry.id === entry.id);
			assert.ok(projected, `tail entry ${entry.id} is replayed`);
			assert.equal(JSON.stringify(projected.messages), JSON.stringify([entry.message]));
		}
		const lastRequestRoles = harness.faux.contexts.at(-1)?.messages.map((message) => message.role);
		assert.deepEqual(lastRequestRoles, ["system", "user", "assistant", "toolResult", "assistant", "user"]);

		await harness.session.prompt("again");
		assert.equal(compactionEntries(harness.sessionManager).length, 1, "the result is applied once");
	});

	test("stores the result as one entry and wakes the session with 'compaction ready' (#4330)", async () => {
		const planner = new Planner();
		const wakes: CompactionReadyWake[] = [];
		const harness = await createBackgroundHarness(TRIGGER, planner, {
			compactionWake: { compactionReady: (wake) => wakes.push(wake) },
		});
		harnesses.push(harness);
		const ready: string[] = [];
		const unsubscribe = harness.session.onCompactionReady((state) => ready.push(state.state));
		await startBackgroundTask(harness, planner);
		assert.deepEqual(wakes, []);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
		const [stored] = resultEntries(harness.sessionManager);
		assert.deepEqual(wakes, [
			{
				sessionId: harness.sessionManager.getSessionId(),
				resultEntryId: stored.id,
				upToEntryId: stored.data?.upToEntryId,
			},
		]);
		assert.deepEqual(ready, ["ready"]);
		unsubscribe();
		await harness.sessionManager.appendCustomEntry(BACKGROUND_COMPACTION_RESULT_TYPE, {
			...stored.data,
			startedAt: "later",
		});
		assert.ok(
			harness.eventsOfType("entry_appended").some((event) => event.entry.id === stored.id),
			"the stored result is announced like other appended entries",
		);
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready", "await is idempotent");
		assert.deepEqual(ready, ["ready"], "an unsubscribed listener hears nothing more");
	});

	test("a fork or branch taken before the commit reconstructs its pre-compaction history (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness([...TRIGGER, "after commit"], planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		await harness.session.awaitBackgroundCompaction();
		const forkPoint = harness.sessionManager.getLeafId();
		assert.ok(forkPoint);
		const before = JSON.stringify(harness.sessionManager.buildSessionProjection().messages);
		await harness.session.prompt("next");
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
		assert.equal(
			harness.eventsOfType("compaction_end").find((event) => event.background)?.midTurn,
			false,
			"applied when the run that stored it ended",
		);
		assert.notEqual(JSON.stringify(harness.sessionManager.buildSessionProjection().messages), before);

		const header = harness.sessionManager.getHeader();
		assert.ok(header);
		const copy = SessionManager.inMemory(harness.tempDir, undefined, [
			header,
			...harness.sessionManager.getEntries(),
		]);
		await copy.createBranchedSession(forkPoint);
		assert.equal(JSON.stringify(copy.buildSessionProjection().messages), before, "branched copy");

		const navigated = SessionManager.inMemory(harness.tempDir, undefined, [
			header,
			...harness.sessionManager.getEntries(),
		]);
		await navigated.branch(forkPoint);
		assert.equal(JSON.stringify(navigated.buildSessionProjection().messages), before, "tree navigation");
	});

	test("two overlapping compactions resolve to the newer one and the older is never applied (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(
			[SEED, "second answer", "third answer", "fourth answer", "fifth answer"],
			planner,
			{ settings: settingsWith({ background: true, backgroundThresholdPercent: 90 }) },
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await harness.session.prompt("third");
		const branch = harness.sessionManager.getBranch();
		const messages = branch.filter((entry) => entry.type === "message");
		const older = messages[1].id;
		const newer = messages[3].id;
		const template = await storedRecordFor(harness, planner);
		await harness.sessionManager.appendCustomEntry(BACKGROUND_COMPACTION_RESULT_TYPE, {
			...template,
			upToEntryId: newer,
			summary: "[User]: newer",
		});
		await harness.sessionManager.appendCustomEntry(BACKGROUND_COMPACTION_RESULT_TYPE, {
			...template,
			upToEntryId: older,
			summary: "[User]: older finished last",
		});
		assert.equal(harness.session.compaction.upToEntryId, newer);

		await harness.session.prompt("fourth");
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.equal(boundary.summary, "[User]: newer");
		assert.equal(boundary.coveredThroughEntryId, newer);

		await harness.sessionManager.appendCustomEntry(BACKGROUND_COMPACTION_RESULT_TYPE, {
			...template,
			upToEntryId: older,
			summary: "[User]: late",
		});
		assert.equal(harness.session.compaction.state, "idle", "a result the boundary covers is not ready");
		await harness.session.prompt("fifth");
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
	});

	test("a hard-threshold turn commits a ready result instead of planning in the foreground (#4330)", async () => {
		const planner = new Planner();
		let harness!: Harness;
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 60, cacheRead: 700, output: 10 } },
				{
					text: "over the hard threshold",
					usage: { input: 150, cacheRead: 700, output: 10 },
					beforeEmit: async () => {
						planner.release();
						await harness.session.awaitBackgroundCompaction();
					},
				},
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await harness.session._awaitPendingPostCompactionContinuation();
		assert.equal(planner.calls.length, 1, "only the background task planned");
		assert.equal(planner.calls[0].foreground, false);
		const ends = harness.eventsOfType("compaction_end");
		assert.equal(ends.length, 1);
		assert.equal(ends[0].reason, "threshold");
		assert.equal(ends[0].background, true);
		assert.equal(ends[0].result?.compactedText, "[User]: retained");
		assert.ok((ends[0].cacheMiss?.expectedMissedTokens ?? 0) > 0, "the foreground commit reports its cache miss");
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.equal(boundary.coveredThroughEntryId, resultEntries(harness.sessionManager)[0].data?.upToEntryId);
		assert.equal(harness.session.compaction.state, "idle");
	});

	test("without a ready result the hard threshold compacts in the foreground and cancels the task (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(
			[...TRIGGER, { text: "over the hard threshold", usage: { input: 850, output: 10 } }],
			planner,
		);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		const prompt = harness.session.prompt("push past the hard threshold");
		await planner.called(2);
		assert.equal(planner.calls[1].foreground, true);
		planner.release();
		await prompt;
		assert.deepEqual(
			harness.eventsOfType("compaction_start").map((event) => event.reason),
			["threshold"],
		);
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 0, "the cancelled task stored nothing");
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
		assert.equal(compactionEntries(harness.sessionManager)[0].coveredThroughEntryId, undefined);
	});

	test("context overflow still compacts in the foreground (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(
			[
				SEED,
				{ error: "prompt is too long: 1200 tokens > 1000 maximum", usage: { input: 0, output: 0 } },
				"recovered",
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await harness.session._awaitPendingPostCompactionContinuation();
		assert.deepEqual(
			harness.eventsOfType("compaction_start").map((event) => event.reason),
			["overflow"],
		);
		assert.equal(planner.calls[0].foreground, true);
		assert.equal(resultEntries(harness.sessionManager).length, 0);
	});

	test("a failed task leaves history unchanged, records a typed reason and retries with backoff (#4330)", async () => {
		vi.useFakeTimers({ toFake: ["Date", "performance"] });
		vi.setSystemTime(new Date("2026-11-05T00:08:00.000Z"));
		const planner = new Planner(true);
		planner.failures = 1;
		const harness = await createBackgroundHarness(
			[...TRIGGER, { text: "still busy", usage: { input: 780, output: 10 } }],
			planner,
		);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		const failed = await harness.session.awaitBackgroundCompaction();
		assert.equal(failed.state, "failed");
		assert.ok(failed.error instanceof BackgroundCompactionPlanningError);
		assert.equal(failed.error.code, "planner-failed");
		assert.equal(failed.error.attempt, 1);
		assert.equal(failed.error.retryable, true);
		assert.equal((failed.error.cause as Error).message, "No compacted text provided by extension");
		assert.equal(failed.upToEntryId, planner.calls[0].branchIds.at(-1));
		assert.equal(failed.startedAt, "2026-11-05T00:08:00.000Z");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);

		vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
		vi.advanceTimersByTime(BACKGROUND_COMPACTION_RETRY_BASE_MS - 1);
		await harness.session.prompt("inside the backoff");
		assert.equal(planner.calls.length, 1, "no retry before the backoff elapses");
		assert.equal(harness.session.compaction.state, "failed");

		vi.advanceTimersByTime(1);
		await harness.session.prompt("after the backoff, though the wall clock stepped back");
		await planner.called(2);
		assert.notEqual((await harness.session.awaitBackgroundCompaction()).state, "failed");
		assert.equal(resultEntries(harness.sessionManager).length, 1, "the retry stored its result");
	});

	test("a ready result whose prefix was edited afterwards is discarded with a typed reason (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness([...TRIGGER, "after"], planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		planner.release();
		const ready = await harness.session.awaitBackgroundCompaction();
		assert.equal(ready.state, "ready");
		const target = planner.calls[0].branchIds.find((id) => {
			const entry = harness.sessionManager.getEntry(id);
			return entry?.type === "message" && entry.message.role === "user";
		}) as string;
		await harness.sessionManager.appendContextEdit(target, { content: "edited" });
		await harness.session.prompt("next");
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		const discarded = harness.eventsOfType("background_compaction").find((event) => event.discarded !== undefined);
		assert.ok(discarded?.discarded);
		assert.ok(isBackgroundCompactionDiscardedError(discarded.discarded));
		assert.equal(discarded.discarded.fields.reason, "context-edited");
	});

	test("reports the expected prompt cache miss when a result is applied (#4330)", async () => {
		const planner = new Planner();
		const cached = {
			input: 60,
			cacheRead: 700,
			output: 10,
			cost: { input: 0.0006, output: 0, cacheRead: 0.0007, cacheWrite: 0, total: 0.0013 },
		};
		const harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: cached },
				{ text: "after tool", usage: cached },
				"after commit",
			],
			planner,
		);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
		await harness.session.prompt("next");
		const [committed] = harness.eventsOfType("compaction_end").filter((event) => event.background === true);
		assert.ok(committed?.cacheMiss, "the commit reports the cache miss it causes");
		assert.ok(committed.cacheMiss.expectedMissedTokens > 0);
		assert.ok(committed.cacheMiss.expectedMissedTokens <= 760, "never more than the cached prompt");
		assert.ok(committed.cacheMiss.expectedMissedCost > 0);
	});

	test("abortCompaction cancels a running background task (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		harness.session.abortCompaction();
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.deepEqual(backgroundStates(harness), ["running", "idle"], "the cancellation is reported");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
	});

	test("disposing the session cancels a running task without a failure or a stored result (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		await startBackgroundTask(harness, planner);
		const settled = harness.session.awaitBackgroundCompaction();
		const disposed = harness.session.dispose();
		planner.release();
		await disposed;
		assert.equal((await settled).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
		harness.cleanup();
	});

	test("toggling background compaction off falls back to today's foreground behaviour (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(
			[...TRIGGER, { text: "over the hard threshold", usage: { input: 850, output: 10 } }],
			planner,
			{ settings: settingsWith({ background: false }) },
		);
		harnesses.push(harness);
		assert.equal(harness.session.backgroundCompactionEnabled, false);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		assert.equal(planner.calls.length, 0, "nothing starts at the soft threshold");
		assert.deepEqual(backgroundStates(harness), []);
		await harness.session.prompt("push past the hard threshold");
		assert.deepEqual(
			harness.eventsOfType("compaction_start").map((event) => event.reason),
			["threshold"],
		);
		assert.equal(planner.calls[0].foreground, true);
		assert.equal(compactionEntries(harness.sessionManager)[0].coveredThroughEntryId, undefined);
	});

	test("the threshold percentage is configurable (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(
			[SEED, { text: "sixty percent", usage: { input: 600, output: 10 } }],
			planner,
			{ settings: settingsWith({ backgroundThresholdPercent: 50 }) },
		);
		harnesses.push(harness);
		assert.equal(harness.session.backgroundCompactionThresholdPercent, 50);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await planner.called();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");

		const defaults = new Planner(true);
		const below = await createBackgroundHarness(
			[SEED, { text: "sixty percent", usage: { input: 600, output: 10 } }],
			defaults,
		);
		harnesses.push(below);
		assert.equal(below.session.backgroundCompactionThresholdPercent, 75);
		await below.session.prompt(longPrompt);
		await below.session.prompt(`${longPrompt}\nsecond`);
		assert.equal(defaults.calls.length, 0, "60% is below the default 75% threshold");
	});

	test("session setters persist the settings, validate input, and stop a running task when disabled (#4330)", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		assert.equal(harness.session.backgroundCompactionEnabled, true);
		await startBackgroundTask(harness, planner);
		harness.session.setBackgroundCompactionThresholdPercent(60);
		assert.equal(harness.settingsManager.getCompactionBackgroundThresholdPercent(), 60);
		assert.throws(
			() => harness.session.setBackgroundCompactionThresholdPercent(150),
			(error: unknown) =>
				error instanceof BackgroundCompactionConfigError &&
				error.source === "sdk" &&
				error.field === "compaction.backgroundThresholdPercent" &&
				error.reason === "out-of-range",
		);
		harness.session.setBackgroundCompactionEnabled(true);
		assert.equal(harness.session.compaction.state, "running", "enabling again keeps the running task");
		harness.session.setBackgroundCompactionEnabled(false);
		assert.equal(harness.settingsManager.getCompactionBackground(), false);
		assert.equal(harness.session.backgroundCompactionEnabled, false);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
		await harness.settingsManager.flush();
	});

	test("an invalid setting is reported as a typed failure instead of breaking the turn (#4330)", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(TRIGGER, planner, {
			settings: { compaction: { ...BASE_SETTINGS.compaction, backgroundThresholdPercent: 0 } },
		});
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		const state = harness.session.compaction;
		assert.equal(state.state, "failed");
		assert.deepEqual(Object.keys(state), ["state", "error"], "a settings failure has no task position");
		assert.deepEqual(backgroundStates(harness), ["failed"], "reported once, not at every boundary");
		assert.ok(state.error instanceof BackgroundCompactionConfigError);
		assert.equal(state.error.source, "settings");
		assert.equal(state.error.reason, "out-of-range");
		assert.equal(harness.session.getLastAssistantText(), "after tool");
		assert.equal(planner.calls.length, 0);
	});
});

/** A valid stored record produced by a real background task, used as a template. */
async function storedRecordFor(harness: Harness, planner: Planner): Promise<BackgroundCompactionResultRecord> {
	const scratchPlanner = new Planner(true);
	scratchPlanner.text = planner.text;
	const scratch = await createBackgroundHarness(TRIGGER, scratchPlanner);
	try {
		await startBackgroundTask(scratch, scratchPlanner);
		await scratch.session.awaitBackgroundCompaction();
		const [stored] = resultEntries(scratch.sessionManager);
		assert.ok(stored.data);
		return { ...stored.data, firstKeptEntryId: null };
	} finally {
		scratch.cleanup();
		assert.ok(harness);
	}
}

describe("background compaction turn latency (counted, #4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/**
	 * Same conversation and usage both ways: a tool turn at 76% of the window, then a tool turn at 82%
	 * (over the 80% hard threshold). Counts the planner runs that a turn had to wait for.
	 */
	async function run(background: boolean) {
		const planner = new Planner();
		let harness!: Harness;
		const releaseThenSettle = echoTool(async () => {
			planner.release();
			if (background) await harness.session.awaitBackgroundCompaction();
		});
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{ toolCalls: [{ id: "call-b", name: "echo", args: {} }], usage: { input: 820, output: 10 } },
				{ text: "done", usage: { input: 400, output: 10 } },
			],
			planner,
			{ settings: settingsWith({ background }), tools: [releaseThenSettle] },
		);
		harnesses.push(harness);
		let compactingAtTurnStart = 0;
		harness.session.subscribe((event) => {
			if (event.type === "turn_start" && harness.session.isCompacting) compactingAtTurnStart += 1;
		});
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nwork`);
		return {
			providerRequests: harness.faux.callCount,
			plannerRunsOnTurnPath: planner.calls.filter((call) => call.foreground).length,
			plannerRunsInBackground: planner.calls.filter((call) => !call.foreground).length,
			blockingCompactions: harness.eventsOfType("compaction_start").length,
			compactingAtTurnStart,
			committedBackground: harness.eventsOfType("compaction_end").filter((event) => event.background).length,
			boundaries: compactionEntries(harness.sessionManager).length,
		};
	}

	test("background compaction removes the blocking planner run from the turn path (#4330)", async () => {
		const before = await run(false);
		const after = await run(true);
		assert.deepEqual(before, {
			providerRequests: 4,
			plannerRunsOnTurnPath: 1,
			plannerRunsInBackground: 0,
			blockingCompactions: 1,
			compactingAtTurnStart: 0,
			committedBackground: 0,
			boundaries: 1,
		});
		assert.deepEqual(after, {
			providerRequests: 4,
			plannerRunsOnTurnPath: 0,
			plannerRunsInBackground: 1,
			blockingCompactions: 0,
			compactingAtTurnStart: 0,
			committedBackground: 1,
			boundaries: 1,
		});
	});

	test("turns keep completing while a background task never finishes (#4330)", async () => {
		const planner = new Planner();
		const turns = 6;
		const harness = await createBackgroundHarness(
			[
				SEED,
				...Array.from({ length: turns }, (_, index) => ({
					toolCalls: [{ id: `call-${index}`, name: "echo", args: {} }],
					usage: { input: 760 + index, output: 10 },
				})),
				{ text: "done", usage: { input: 770, output: 10 } },
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nwork`);
		assert.equal(harness.faux.callCount, 1 + turns + 1, "every turn completed with the planner held");
		assert.equal(planner.calls.length, 1, "one task, never restarted while it runs");
		assert.equal(harness.session.compaction.state, "running");
		assert.equal(harness.eventsOfType("compaction_start").length, 0);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
	});
});

/** Count, per next-turn hook call, the reads of the session event queue: each one is a wait for queued saves. */
function countHookQueueWaits(harness: Harness): number[] {
	const session = harness.session as unknown as { _agentEventQueue: Promise<void> };
	let queue = session._agentEventQueue;
	const perHook: number[] = [];
	let inHook = false;
	Object.defineProperty(session, "_agentEventQueue", {
		configurable: true,
		get() {
			if (inHook) perHook[perHook.length - 1] += 1;
			return queue;
		},
		set(value: Promise<void>) {
			queue = value;
		},
	});
	const agent = harness.agent as unknown as { prepareNextTurnWithContext: (...args: unknown[]) => Promise<unknown> };
	const hook = agent.prepareNextTurnWithContext;
	agent.prepareNextTurnWithContext = async (...args: unknown[]) => {
		perHook.push(0);
		inHook = true;
		try {
			return await hook.apply(harness.agent, args);
		} finally {
			inHook = false;
		}
	};
	return perHook;
}

const TWO_TOOL_TURNS: FauxResponseInput[] = [
	{ toolCalls: [{ id: "work-1", name: "echo", args: {} }], usage: { input: 100, output: 10 } },
	{ toolCalls: [{ id: "work-2", name: "echo", args: {} }], usage: { input: 110, output: 10 } },
	{ text: "work done", usage: { input: 120, output: 10 } },
];

describe("background compaction waits in the next-turn hook (counted, #4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function ready(responses: FauxResponseInput[], tools?: AgentTool[]) {
		const planner = new Planner();
		const harness = await createBackgroundHarness(responses, planner, tools ? { tools } : {});
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		return harness;
	}

	const discardEvents = (harness: Harness) =>
		harness.eventsOfType("background_compaction").filter((event) => event.discarded !== undefined);

	test("a result left behind by tree navigation costs tool turns nothing and is applied once on return", async () => {
		const harness = await ready([...TRIGGER, ...TWO_TOOL_TURNS, "back"]);
		const leaf = harness.sessionManager.getLeafId() as string;
		const firstAnswer = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(firstAnswer);
		await harness.session.navigateTree(firstAnswer.id);
		const waits = countHookQueueWaits(harness);
		const stateEvents = backgroundStates(harness).length;

		await harness.session.prompt("work");
		assert.equal(backgroundStates(harness).length, stateEvents, "leaving a result behind reports nothing");
		assert.deepEqual(waits, [0, 0], "no tool turn waits for saves when nothing can be applied");
		assert.equal(harness.session._backgroundCompaction.announcedResultEntryId, undefined);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		assert.equal(harness.eventsOfType("compaction_end").filter((event) => event.background).length, 0);
		assert.deepEqual(discardEvents(harness), [], "a result on another branch is not discarded");

		await harness.session.navigateTree(leaf);
		assert.equal(harness.session.compaction.state, "ready", "returning to its branch makes it ready again");
		await harness.session.prompt("back");
		assert.equal(compactionEntries(harness.sessionManager).length, 1, "applied exactly once");
		assert.equal(harness.session.compaction.state, "idle");
	});

	test("tool turns inside the commit backoff neither wait for saves nor retry, and the retry waits once", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		let advanceDuringTurn = false;
		const tool = echoTool(async () => {
			if (advanceDuringTurn) vi.advanceTimersByTime(BACKGROUND_COMPACTION_RETRY_BASE_MS);
		});
		const harness = await ready([...TRIGGER, "failed apply", ...TWO_TOOL_TURNS, ...TWO_TOOL_TURNS], [tool]);
		const append = harness.sessionManager.appendCompaction.bind(harness.sessionManager);
		let attempts = 0;
		harness.sessionManager.appendCompaction = async (...args) => {
			attempts += 1;
			if (attempts === 1) throw new Error("injected storage write failure");
			return append(...args);
		};
		await harness.session.prompt("failed apply");
		assert.equal(harness.session.compaction.error?.code, "commit-failed");
		const waits = countHookQueueWaits(harness);

		await harness.session.prompt("inside the backoff");
		assert.deepEqual(waits, [0, 0]);
		assert.equal(attempts, 1, "no retry inside the backoff");

		advanceDuringTurn = true;
		await harness.session.prompt("the backoff ends during this turn");
		assert.deepEqual(waits.slice(2), [1, 0], "the retry waits for queued saves once, then nothing");
		assert.equal(attempts, 2);
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
	});

	test("an announced result that a newer boundary covers is reported once and costs tool turns nothing", async () => {
		const harness = await ready([...TRIGGER, ...TWO_TOOL_TURNS]);
		const [stored] = resultEntries(harness.sessionManager);
		await harness.sessionManager.appendCompaction(
			"[User]: newer",
			null,
			900,
			stored.data?.details as never,
			undefined,
			stored.data?.upToEntryId,
		);
		const waits = countHookQueueWaits(harness);
		await harness.session.prompt("work");
		assert.deepEqual(waits, [0, 0]);
		const discarded = discardEvents(harness);
		assert.equal(discarded.length, 1);
		assert.equal(discarded[0].discarded?.fields.reason, "superseded");
		assert.equal(harness.session._backgroundCompaction.announcedResultEntryId, undefined);
	});

	test("a result applied by the next-turn hook waits for queued saves exactly once", async () => {
		const planner = new Planner(true);
		let harness!: Harness;
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					toolCalls: [{ id: "call-b", name: "echo", args: {} }],
					usage: { input: 770, output: 10 },
					beforeEmit: async () => {
						await harness.session.awaitBackgroundCompaction();
					},
				},
				{ toolCalls: [{ id: "call-c", name: "echo", args: {} }], usage: { input: 300, output: 10 } },
				{ text: "done", usage: { input: 310, output: 10 } },
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		const waits = countHookQueueWaits(harness);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
		assert.deepEqual(waits, [0, 1, 0], "only the hook that applies the result waits");
	});
});

describe("background compaction scheduling edges (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function readyHarness(responses: FauxResponseInput[] = [...TRIGGER, "after"]) {
		const planner = new Planner();
		const harness = await createBackgroundHarness(responses, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		return { harness, planner };
	}

	test("a stored result is never applied twice by concurrent boundaries", async () => {
		const { harness } = await readyHarness();
		const [first, second] = await Promise.all([
			harness.session._commitReadyBackgroundCompaction(),
			harness.session._commitReadyBackgroundCompaction(),
		]);
		assert.ok(first);
		assert.equal(second, undefined);
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
		assert.ok(await harness.session._commitReadyBackgroundCompaction().then((value) => value === undefined));
	});

	test("a foreground owner may apply a stored result; an ordinary boundary may not while it runs", async () => {
		const { harness } = await readyHarness();
		harness.session._autoCompactionAbortController = new AbortController();
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.ok(await harness.session._commitReadyBackgroundCompaction({ foreground: true }));
		harness.session._autoCompactionAbortController = undefined;
	});

	test("nothing is applied after a failed save, after disposal, or while background compaction is off", async () => {
		const { harness } = await readyHarness();
		harness.session._persistenceFailure = "could not save";
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		harness.session._persistenceFailure = undefined;
		harness.settingsManager.setCompactionBackground(false);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		harness.settingsManager.setCompactionBackground(true);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		await harness.session.dispose();
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
	});

	test("a next-turn commit waits for queued saves so the boundary follows them", async () => {
		const { harness } = await readyHarness();
		let probeId = "";
		harness.session._agentEventQueue = new Promise<void>((resolve) => {
			setTimeout(async () => {
				probeId = await harness.sessionManager.appendCustomEntry("probe", {});
				resolve();
			}, 5);
		});
		assert.equal(await harness.session._runBackgroundCompactionBoundary(true, true), true);
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.equal(boundary.parentId, probeId);
		assert.equal(harness.eventsOfType("compaction_end").at(-1)?.midTurn, true);
	});

	test("a result that a queued save invalidates while the commit waits is discarded instead of applied", async () => {
		const { harness, planner } = await readyHarness();
		const target = planner.calls[0].branchIds.find((id) => {
			const entry = harness.sessionManager.getEntry(id);
			return entry?.type === "message" && entry.message.role === "user";
		}) as string;
		harness.session._agentEventQueue = new Promise<void>((resolve) => {
			setTimeout(async () => {
				await harness.sessionManager.appendContextEdit(target, { content: "edited" });
				resolve();
			}, 5);
		});
		assert.equal(await harness.session._runBackgroundCompactionBoundary(true, true), false);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		assert.equal(harness.eventsOfType("background_compaction").at(-1)?.discarded?.fields.reason, "context-edited");
	});

	test("a commit reports session_compact with the threshold reason", async () => {
		const reasons: string[] = [];
		const planner = new Planner();
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: BASE_SETTINGS,
			responses: [...TRIGGER, "after"],
			baseToolsOverride: { echo: echoTool() },
			extensionFactories: [
				planner.factory,
				(pi) => {
					pi.on("session_compact", (event) => {
						reasons.push(event.reason);
					});
				},
			],
		});
		harnesses.push(harness);
		planner.session = harness.session;
		await harness.session.bindExtensions({});
		harness.session.setActiveToolsByName(["echo"]);
		harness.agent.convertToLlm = convertToLlm;
		await startBackgroundTask(harness, planner);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
		await harness.session.prompt("next");
		assert.deepEqual(reasons, ["threshold"]);
	});

	test("does not start when a result already waits or nothing is safe to freeze", async () => {
		const { harness, planner } = await readyHarness();
		harness.session._maybeStartBackgroundCompaction(900);
		assert.equal(planner.calls.length, 1, "a stored result is committed before anything new starts");

		const fresh = new Planner(true);
		const empty = await createBackgroundHarness(["unused"], fresh);
		harnesses.push(empty);
		await empty.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "pending", name: "echo", arguments: {} }],
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		empty.session._maybeStartBackgroundCompaction(900);
		assert.equal(empty.session.compaction.state, "idle", "only an unanswered call: nothing is safe");

		assert.equal(fresh.calls.length, 0);
	});

	test("a prefix with too few compactable lines fails as not-compactable", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness([{ text: "short", usage: { input: 760, output: 10 } }], planner);
		harnesses.push(harness);
		await harness.session.prompt("tiny");
		const state = await harness.session.awaitBackgroundCompaction();
		assert.equal(state.state, "failed");
		assert.ok(isBackgroundCompactionNotCompactableError(state.error));
		assert.ok(state.upToEntryId);
		assert.equal(state.error.upToEntryId, state.upToEntryId);
		assert.equal(planner.calls.length, 0, "the extension hook never runs for an empty region");
	});

	test("a result whose prefix left the branch, or that a newer boundary covers, is discarded on save", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		const [first] = harness.sessionManager.getBranch();
		await harness.sessionManager.branch(first.id);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		const offBranch = harness.eventsOfType("background_compaction").at(-1)?.discarded;
		assert.equal(offBranch?.fields.reason, "off-branch");
		assert.equal(offBranch?.phase, "persist");
		assert.equal(resultEntries(harness.sessionManager).length, 0);

		const second = new Planner();
		const superseded = await createBackgroundHarness(TRIGGER, second);
		harnesses.push(superseded);
		await startBackgroundTask(superseded, second);
		const template = await storedRecordFor(superseded, new Planner(true));
		const upToEntryId = second.calls[0].branchIds.at(-1);
		await superseded.sessionManager.appendCompaction(
			"[User]: newer",
			null,
			900,
			template.details,
			undefined,
			upToEntryId,
		);
		second.release();
		assert.equal((await superseded.session.awaitBackgroundCompaction()).state, "idle");
		const covered = superseded.eventsOfType("background_compaction").at(-1)?.discarded;
		assert.equal(covered?.fields.reason, "superseded", "a boundary covering exactly the frozen prefix supersedes it");
		assert.equal(covered?.phase, "persist");
		assert.equal(resultEntries(superseded.sessionManager).length, 0);
	});

	test("a failed save is a retryable typed failure with its cause", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		const diskFull = new Error("disk full");
		harness.sessionManager.appendCustomEntry = async () => {
			throw diskFull;
		};
		planner.release();
		const state = await harness.session.awaitBackgroundCompaction();
		assert.equal(state.state, "failed");
		assert.ok(state.error instanceof BackgroundCompactionPersistError);
		assert.equal(state.error.retryable, true);
		assert.equal(state.error.cause, diskFull);
		assert.equal(state.error.upToEntryId, planner.calls[0].branchIds.at(-1));
	});

	test("listener, wake and settings failures are reported instead of escaping", async () => {
		const planner = new Planner();
		const reported: string[] = [];
		const harness = await createBackgroundHarness(TRIGGER, planner, {
			compactionWake: {
				compactionReady: () => {
					throw new Error("wake failed");
				},
			},
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) =>
			reported.push(`${error.extensionPath}:${error.event}:${error.error}`),
		);
		harness.session.onCompactionReady(() => {
			throw new Error("listener failed");
		});
		harness.session.subscribe((event) => {
			if (event.type === "background_compaction" && event.compaction.state === "ready")
				throw new Error("subscriber failed");
			if (event.type === "entry_appended" && event.entry.type === "custom") throw new Error("entry listener failed");
		});
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		assert.deepEqual(reported.sort(), [
			"<background_compaction>:background_compaction:entry listener failed",
			"<background_compaction>:background_compaction:listener failed",
			"<background_compaction>:background_compaction:subscriber failed",
			"<background_compaction>:background_compaction:wake failed",
		]);
		harness.settingsManager.getCompactionBackground = () => {
			throw new Error("settings unavailable");
		};
		assert.throws(() => harness.session._maybeStartBackgroundCompaction(900), /settings unavailable/);
	});

	test("a finished task releases its session-lifetime listener", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		const lifetime = sessionLifetime(harness.session);
		const before = getEventListeners(lifetime, "abort").length;
		await startBackgroundTask(harness, planner);
		assert.equal(getEventListeners(lifetime, "abort").length, before + 1);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
		assert.equal(getEventListeners(lifetime, "abort").length, before);
	});

	test("a JSONL session backs up before applying a stored result", async () => {
		const planner = new Planner();
		const directory = mkdtempSync(join(tmpdir(), "background-compaction-backup-"));
		try {
			const sessionManager = await SessionManager.create(directory, join(directory, "sessions"));
			const harness = await createBackgroundHarness([...TRIGGER, "after"], planner, { sessionManager });
			harnesses.push(harness);
			await startBackgroundTask(harness, planner);
			planner.release();
			await harness.session.awaitBackgroundCompaction();
			await harness.session.prompt("next");
			const [boundary] = compactionEntries(harness.sessionManager);
			const backupPath = (boundary.details as { backupPath?: string }).backupPath;
			assert.ok(backupPath?.endsWith(".background-compact.bak"), backupPath);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a hard-threshold commit that still leaves the context too large compacts again in the foreground", async () => {
		const planner = new Planner();
		planner.text = Array.from({ length: 200 }, (_, line) => `[User]: kept line ${line}`).join("\n");
		let harness!: Harness;
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					text: "over the hard threshold",
					usage: { input: 850, output: 10 },
					beforeEmit: async () => {
						planner.release();
						await harness.session.awaitBackgroundCompaction();
						planner.text = "[User]: small";
					},
				},
			],
			planner,
		);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await harness.session._awaitPendingPostCompactionContinuation();
		harnesses.push(harness);
		const boundaries = compactionEntries(harness.sessionManager);
		assert.equal(boundaries.length, 2, "the stored result, then a foreground boundary on top");
		assert.equal(boundaries[0].coveredThroughEntryId !== undefined, true);
		assert.equal(boundaries[1].coveredThroughEntryId, undefined);
		const ends = harness.eventsOfType("compaction_end");
		assert.equal(ends.at(-1)?.background, undefined, "the event reports the foreground boundary");
		assert.equal(planner.calls.at(-1)?.foreground, true);
	});

	test("the post-tool preflight applies a stored result instead of planning", async () => {
		const cached = { input: 60, cacheRead: 700, output: 10 };
		const { harness, planner } = await readyHarness([
			SEED,
			{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: cached },
			{ text: "after tool", usage: cached },
			"after",
		]);
		const oversized = Array.from({ length: 40 }, (_, index) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text: `filler ${index} ${longPrompt}` }],
			timestamp: index,
		}));
		await harness.session._preflightPostToolContext(oversized);
		harness.session._finishPostToolCompactionPreflight(harness.session.agent.state.messages.slice());
		const end = harness.eventsOfType("compaction_end").at(-1);
		assert.equal(end?.background, true);
		assert.equal(end?.midTurn, true);
		assert.ok((end?.cacheMiss?.expectedMissedTokens ?? 0) > 0, "the mid-turn commit reports its cache miss");
		assert.equal(planner.calls.length, 1, "the stored result was used without planning again");
		assert.equal(compactionEntries(harness.sessionManager)[0].coveredThroughEntryId !== undefined, true);
	});
});

describe("background compaction task lifecycle (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function harnessFor(responses: FauxResponseInput[], planner: Planner, options: HarnessOptions = {}) {
		const harness = await createBackgroundHarness(responses, planner, options);
		harnesses.push(harness);
		return harness;
	}

	async function ready(responses: FauxResponseInput[] = [...TRIGGER, "after"], planner = new Planner()) {
		const harness = await harnessFor(responses, planner);
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		return harness;
	}

	const oversizedContext = () =>
		Array.from({ length: 40 }, (_, index) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text: `filler ${index} ${longPrompt}` }],
			timestamp: index,
		}));

	test("a manual compaction, running or about to start, keeps an ordinary boundary from committing", async () => {
		const harness = await ready();
		harness.session._compactionAbortController = new AbortController();
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		harness.session._compactionAbortController = undefined;
		harness.session._manualCompactionPromise = new Promise(() => {});
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		harness.session._manualCompactionPromise = undefined;
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		assert.ok(await harness.session._commitReadyBackgroundCompaction());
	});

	test("a save failure reported while queued saves drain stops the next-turn commit", async () => {
		const harness = await ready();
		harness.session._agentEventQueue = new Promise<void>((resolve) => {
			setTimeout(() => {
				harness.session._persistenceFailure = "could not save";
				resolve();
			}, 5);
		});
		assert.equal(await harness.session._runBackgroundCompactionBoundary(true, true), false);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
		harness.session._persistenceFailure = undefined;
	});

	test("cancelling while the result is being saved settles as cancelled, not failed", async () => {
		const planner = new Planner();
		const harness = await harnessFor(TRIGGER, planner);
		await startBackgroundTask(harness, planner);
		harness.sessionManager.appendCustomEntry = async () => {
			harness.session.abortCompaction();
			throw new Error("save interrupted");
		};
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.deepEqual(backgroundStates(harness), ["running", "idle"]);
	});

	test("an unexpected failure inside the task is reported and the task still settles", async () => {
		const planner = new Planner();
		const harness = await harnessFor(TRIGGER, planner);
		await startBackgroundTask(harness, planner);
		const reported: string[] = [];
		harness.session.extensionRunner.onError((error) => reported.push(String(error.error)));
		const getBranch = harness.sessionManager.getBranch.bind(harness.sessionManager);
		harness.sessionManager.getBranch = () => {
			throw new Error("branch unavailable");
		};
		planner.release();
		await vi.waitFor(() => assert.deepEqual(reported, ["branch unavailable"]));
		harness.sessionManager.getBranch = getBranch;
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
	});

	test("a session without a model never starts a task", async () => {
		const planner = new Planner(true);
		const harness = await harnessFor(["unused"], planner);
		await harness.sessionManager.appendMessage({ role: "user", content: longPrompt, timestamp: 1 });
		harness.agent.state.model = undefined as never;
		harness.session._maybeStartBackgroundCompaction(900);
		assert.equal(harness.session.compaction.state, "idle");
	});

	test("a one-entry history can be frozen", async () => {
		const planner = new Planner(true);
		const harness = await harnessFor(["unused"], planner);
		await harness.sessionManager.appendMessage({ role: "user", content: longPrompt, timestamp: 1 });
		harness.session._maybeStartBackgroundCompaction(900);
		assert.equal(harness.session.compaction.state, "running");
		const settled = await harness.session.awaitBackgroundCompaction();
		assert.equal(settled.state, "failed", "the recent-message tail leaves nothing to compact");
		assert.equal(settled.upToEntryId, harness.sessionManager.getBranch()[0].id);
	});

	test("an unsubscribed ready listener is not called", async () => {
		const planner = new Planner();
		const harness = await harnessFor(TRIGGER, planner);
		const kept: string[] = [];
		const dropped: string[] = [];
		const unsubscribe = harness.session.onCompactionReady((wake) => dropped.push(wake.upToEntryId));
		harness.session.onCompactionReady((wake) => kept.push(wake.upToEntryId));
		unsubscribe();
		await startBackgroundTask(harness, planner);
		planner.release();
		await harness.session.awaitBackgroundCompaction();
		assert.equal(kept.length, 1);
		assert.deepEqual(dropped, []);
	});

	test("enabling background compaction while a task runs lets it finish", async () => {
		const planner = new Planner();
		const harness = await harnessFor(TRIGGER, planner);
		await startBackgroundTask(harness, planner);
		harness.session.setBackgroundCompactionEnabled(true);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
	});

	test("a result that is ready by the next tool turn is applied mid-turn before its request", async () => {
		const planner = new Planner(true);
		let harness!: Harness;
		harness = await harnessFor(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					toolCalls: [{ id: "call-b", name: "echo", args: {} }],
					usage: { input: 770, output: 10 },
					beforeEmit: async () => {
						await harness.session.awaitBackgroundCompaction();
					},
				},
				{ text: "done", usage: { input: 300, output: 10 } },
			],
			planner,
			{
				extensionFactories: [
					(pi) => {
						pi.on("message_end", async (event) => {
							if (event.message.role === "toolResult") await new Promise((resolve) => setTimeout(resolve, 20));
						});
					},
				],
			},
		);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		const [committed] = harness.eventsOfType("compaction_end").filter((event) => event.background === true);
		assert.ok(committed, "the stored result was applied during the turn");
		assert.equal(committed.midTurn, true);
		const [boundary] = compactionEntries(harness.sessionManager);
		const parent = boundary.parentId ? harness.sessionManager.getEntry(boundary.parentId) : undefined;
		assert.ok(
			parent?.type === "message" && parent.message.role === "toolResult" && parent.message.toolCallId === "call-b",
			"the boundary follows the tool result that was still being saved",
		);
		assert.equal(harness.session.getLastAssistantText(), "done");
		const roles = harness.faux.contexts.at(-1)?.messages.map((message) => message.role);
		assert.equal(roles?.[1], "user", "the request after the commit starts from the compacted context");
	});

	test("the committed context is a copy the agent loop may append to", async () => {
		const harness = await harnessFor(["unused"], new Planner(true));
		const live = harness.agent.state.messages;
		const committed = committedContextMessages(harness.session);
		assert.notEqual(committed, live);
		assert.deepEqual(committed, live);
	});

	test("a post-tool crossing with nothing compactable and no stored result sends the request unchanged", async () => {
		const harness = await harnessFor(["unused"], new Planner(true));
		const fitting = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(3_400) }], timestamp: 1 },
		];
		assert.equal(await harness.session._preflightPostToolContext(fitting), fitting);
		const end = harness.eventsOfType("compaction_end").at(-1);
		assert.equal(end?.result, undefined);
		assert.equal(end?.midTurn, true);
	});

	test("a post-tool commit that leaves the context too large compacts again and reports the foreground boundary", async () => {
		const planner = new Planner();
		planner.text = Array.from({ length: 200 }, (_, line) => `[User]: kept line ${line}`).join("\n");
		const harness = await ready([...TRIGGER, "after"], planner);
		planner.text = "[User]: small";
		await harness.session._preflightPostToolContext(oversizedContext());
		harness.session._finishPostToolCompactionPreflight(harness.session.agent.state.messages.slice());
		assert.equal(compactionEntries(harness.sessionManager).length, 2);
		const end = harness.eventsOfType("compaction_end").at(-1);
		assert.equal(end?.background, undefined);
		assert.equal(end?.result?.compactedText.includes("[User]: small"), true);
	});

	test("a background task can plan with the session model and records the planner's usage", async () => {
		const planner = new Planner(true);
		planner.text = undefined;
		const harness = await harnessFor(
			[
				{ text: "first answer", usage: { input: 760, output: 10 } },
				{ text: "1:2,6\n", usage: { input: 40, output: 4 } },
				"after commit",
			],
			planner,
			{ settings: settingsWith({ preserve_recent: 0 }) },
		);
		const model = harness.session.model;
		assert.ok(model);
		harness.session.modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: model.api,
			models: [model],
		});
		await harness.session.prompt(longPrompt);
		const settled = await harness.session.awaitBackgroundCompaction();
		assert.equal(settled.state, "ready");
		const [stored] = resultEntries(harness.sessionManager);
		assert.equal(stored.data?.fromExtension, false);
		assert.equal(stored.data?.usage?.input, 40);
		await harness.session.prompt("next");
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.deepEqual(boundary.usage, stored.data?.usage);
	});
});

describe("foreground compaction with background compaction off (#4330)", () => {
	const OFF = settingsWith({ background: false });

	async function jsonlHarness(
		responses: FauxResponseInput[],
		planner: Planner,
		run: (harness: Harness) => Promise<void>,
	) {
		const directory = mkdtempSync(join(tmpdir(), "foreground-compaction-backup-"));
		const sessionManager = await SessionManager.create(directory, join(directory, "sessions"));
		const harness = await createBackgroundHarness(responses, planner, { settings: OFF, sessionManager });
		try {
			await run(harness);
		} finally {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	}

	const backupPath = (harness: Harness) =>
		(compactionEntries(harness.sessionManager)[0]?.details as { backupPath?: string } | undefined)?.backupPath;

	test("a threshold compaction backs up as auto-compact and an overflow as overflow-auto-compact", async () => {
		await jsonlHarness(
			[...TRIGGER, { text: "over the hard threshold", usage: { input: 850, output: 10 } }],
			new Planner(true),
			async (harness) => {
				await harness.session.prompt(longPrompt);
				await harness.session.prompt(`${longPrompt}\nsecond`);
				await harness.session.prompt("push past the hard threshold");
				assert.ok(backupPath(harness)?.endsWith(".auto-compact.bak"), backupPath(harness));
			},
		);
		await jsonlHarness(
			[
				SEED,
				{ error: "prompt is too long: 1200 tokens > 1000 maximum", usage: { input: 0, output: 0 } },
				"recovered",
			],
			new Planner(true),
			async (harness) => {
				await harness.session.prompt(longPrompt);
				await harness.session.prompt(`${longPrompt}\nsecond`);
				await harness.session._awaitPendingPostCompactionContinuation();
				assert.ok(backupPath(harness)?.endsWith(".overflow-auto-compact.bak"), backupPath(harness));
			},
		);
	});

	test("a failed save after an extension supplied the text reports fromExtension", async () => {
		const planner = new Planner(true);
		const harness = await createBackgroundHarness(
			[...TRIGGER, { text: "over the hard threshold", usage: { input: 850, output: 10 } }],
			planner,
			{ settings: OFF },
		);
		try {
			harness.sessionManager.appendCompaction = async () => {
				throw new Error("disk full");
			};
			await harness.session.prompt(longPrompt);
			await harness.session.prompt(`${longPrompt}\nsecond`);
			await harness.session.prompt("push past the hard threshold").catch(() => {});
			assert.deepEqual(planner.compactFailures, [true]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("background compaction commit failures (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	const AFTER: FauxResponseInput[] = ["next answer", "third answer", "fourth answer", "fifth answer", "sixth answer"];

	async function readyWith(responses: FauxResponseInput[], options: HarnessOptions = {}) {
		const planner = new Planner();
		const harness = await createBackgroundHarness(responses, planner, options);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		return { harness, planner };
	}

	/** Make the boundary append fail `failures` times (every time when undefined) and count the attempts. */
	function failCommits(harness: Harness, failures?: number) {
		const append = harness.sessionManager.appendCompaction.bind(harness.sessionManager);
		const attempts = { count: 0, cause: new Error("injected storage write failure") };
		harness.sessionManager.appendCompaction = async (...args) => {
			attempts.count += 1;
			if (failures === undefined || attempts.count <= failures) throw attempts.cause;
			return append(...args);
		};
		return attempts;
	}

	async function promptAndCountRequests(harness: Harness, text: string): Promise<number> {
		const before = harness.faux.callCount;
		await harness.session.prompt(text);
		return harness.faux.callCount - before;
	}

	test("a failed commit keeps the turn running, reports commit-failed, and is applied once after the backoff", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		const [stored] = resultEntries(harness.sessionManager);
		const attempts = failCommits(harness, 1);

		assert.equal(await promptAndCountRequests(harness, "next"), 1, "the prompt still reaches the provider");
		assert.equal(harness.session.getLastAssistantText(), "next answer");
		const failed = harness.session.compaction;
		assert.equal(failed.state, "failed");
		assert.ok(failed.error instanceof BackgroundCompactionCommitError);
		assert.equal(failed.error.code, "commit-failed");
		assert.equal(failed.error.phase, "commit");
		assert.equal(failed.error.retryable, true);
		assert.equal(failed.error.cause, attempts.cause);
		assert.equal(failed.error.resultEntryId, stored.id);
		assert.equal(failed.error.attempt, 1);
		assert.equal(failed.upToEntryId, stored.data?.upToEntryId);
		assert.equal(harness.eventsOfType("compaction_end").length, 0, "a failed background commit is not a compaction");
		assert.equal(backgroundStates(harness).at(-1), "failed");

		vi.advanceTimersByTime(BACKGROUND_COMPACTION_RETRY_BASE_MS - 1);
		assert.equal(await promptAndCountRequests(harness, "third"), 1);
		assert.equal(attempts.count, 1, "no new attempt inside the backoff");

		vi.advanceTimersByTime(1);
		assert.equal(await promptAndCountRequests(harness, "fourth"), 1);
		assert.equal(attempts.count, 2);
		assert.equal(compactionEntries(harness.sessionManager).length, 1, "applied exactly once");
		assert.equal(harness.eventsOfType("compaction_end").filter((event) => event.background).length, 1);
		assert.equal(harness.session.compaction.state, "idle");
	});

	test("a commit that keeps failing never blocks a prompt and is attempted only as the backoff allows", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		const attempts = failCommits(harness);
		for (const [advanceMs, text, expectedAttempts] of [
			[0, "next", 1],
			[0, "third", 1],
			[BACKGROUND_COMPACTION_RETRY_BASE_MS, "fourth", 2],
			[BACKGROUND_COMPACTION_RETRY_BASE_MS, "fifth", 2],
			[BACKGROUND_COMPACTION_RETRY_BASE_MS, "sixth", 3],
		] as const) {
			vi.advanceTimersByTime(advanceMs);
			assert.equal(await promptAndCountRequests(harness, text), 1, text);
			assert.equal(attempts.count, expectedAttempts, text);
		}
		const state = harness.session.compaction;
		assert.equal(state.state, "failed");
		assert.equal(state.error instanceof BackgroundCompactionCommitError && state.error.attempt, 3);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
	});

	test("a failed next-turn commit still sends the tool turn's follow-up request", async () => {
		const planner = new Planner(true);
		let harness!: Harness;
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					toolCalls: [{ id: "call-b", name: "echo", args: {} }],
					usage: { input: 770, output: 10 },
					beforeEmit: async () => {
						await harness.session.awaitBackgroundCompaction();
						failCommits(harness);
					},
				},
				{ text: "done", usage: { input: 780, output: 10 } },
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		assert.equal(harness.session.getLastAssistantText(), "done");
		assert.equal(harness.session.compaction.error?.code, "commit-failed");
		assert.equal(compactionEntries(harness.sessionManager).length, 0);
	});

	test("a hard-threshold turn whose ready commit fails compacts in the foreground", async () => {
		const planner = new Planner();
		let harness!: Harness;
		harness = await createBackgroundHarness(
			[
				SEED,
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					text: "over the hard threshold",
					usage: { input: 850, output: 10 },
					beforeEmit: async () => {
						planner.release();
						await harness.session.awaitBackgroundCompaction();
						failCommits(harness, 1);
					},
				},
				"after",
			],
			planner,
		);
		harnesses.push(harness);
		await harness.session.prompt(longPrompt);
		await harness.session.prompt(`${longPrompt}\nsecond`);
		await harness.session._awaitPendingPostCompactionContinuation();
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.ok(boundary, "the foreground compaction wrote its own boundary");
		assert.equal(boundary.coveredThroughEntryId, undefined);
		assert.equal(planner.calls.at(-1)?.foreground, true);
		assert.equal(harness.eventsOfType("compaction_end").at(-1)?.background, undefined);
		assert.equal(harness.session.compaction.state, "idle", "the superseded result no longer reports a failure");
		await harness.session.prompt("after");
		const discarded = harness.eventsOfType("background_compaction").at(-1);
		assert.equal(discarded?.compaction.state, "idle");
		assert.equal(discarded?.discarded?.fields.reason, "superseded");
	});

	test("a JSONL session whose backup fails reports the storage error as the cause", async () => {
		const directory = mkdtempSync(join(tmpdir(), "background-compaction-commit-failure-"));
		try {
			const sessionManager = await SessionManager.create(directory, join(directory, "sessions"));
			const { harness } = await readyWith([...TRIGGER, ...AFTER], { sessionManager });
			const unavailable = new StorageUnavailableError({ adapter: "jsonl", location: "backup" }, new Error("EIO"));
			harness.sessionManager.writeBackupSnapshot = async () => {
				throw unavailable;
			};
			assert.equal(await promptAndCountRequests(harness, "next"), 1);
			const state = harness.session.compaction;
			assert.equal(state.error?.code, "commit-failed");
			assert.equal(state.error?.cause, unavailable);
			assert.equal(compactionEntries(harness.sessionManager).length, 0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a commit failure stops holding back new tasks once a newer boundary covers its result", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const { harness, planner } = await readyWith([...TRIGGER, ...AFTER]);
		const [stored] = resultEntries(harness.sessionManager);
		failCommits(harness, 1);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(harness.session.compaction.error?.code, "commit-failed");
		harness.session._backgroundCompaction.announcedResultEntryId = undefined;
		await harness.sessionManager.appendCompaction(
			"[User]: newer",
			null,
			900,
			stored.data?.details as never,
			undefined,
			stored.data?.upToEntryId,
		);
		await harness.sessionManager.appendMessage({ role: "user", content: longPrompt, timestamp: 9 });

		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(harness.session.compaction.state, "idle");
		harness.session._maybeStartBackgroundCompaction(900);
		assert.equal(harness.session.compaction.state, "running", "the commit backoff no longer applies");
		planner.release();
		await harness.session.awaitBackgroundCompaction();
	});

	test("a failed commit of a result loaded from storage is still reported when it is discarded", async () => {
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		const [stored] = resultEntries(harness.sessionManager);
		harness.session._backgroundCompaction.announcedResultEntryId = undefined;
		const attempts = failCommits(harness, 1);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(attempts.count, 1);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined, "held back by the backoff");
		await harness.sessionManager.appendCompaction(
			"[User]: newer",
			null,
			900,
			stored.data?.details as never,
			undefined,
			stored.data?.upToEntryId,
		);
		await harness.session._commitReadyBackgroundCompaction();
		const discarded = harness.eventsOfType("background_compaction").at(-1);
		assert.equal(discarded?.discarded?.fields.reason, "superseded");
		assert.equal(discarded?.compaction.state, "idle");
	});

	test("a foreground compaction applies a result whose commit failed without waiting for the backoff", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		failCommits(harness, 1);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined, "an ordinary boundary waits");
		assert.ok(await harness.session._commitReadyBackgroundCompaction({ foreground: true }));
		assert.equal(compactionEntries(harness.sessionManager).length, 1);
		assert.equal(harness.session.compaction.state, "idle");
	});

	test("a newer saved result is reported ready even while an older one failed to apply", async () => {
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		const [older] = resultEntries(harness.sessionManager);
		failCommits(harness);
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(harness.session.compaction.state, "failed");
		await harness.sessionManager.appendMessage({ role: "user", content: "later", timestamp: 9 });
		const laterId = harness.sessionManager.getLeafId() as string;
		await harness.sessionManager.appendCustomEntry(BACKGROUND_COMPACTION_RESULT_TYPE, {
			...older.data,
			upToEntryId: laterId,
		});
		const state = harness.session.compaction;
		assert.equal(state.state, "ready");
		assert.equal(state.upToEntryId, laterId);
	});

	test("a commit failure during disposal is not recorded", async () => {
		const { harness } = await readyWith([...TRIGGER, ...AFTER]);
		harness.sessionManager.appendCompaction = async () => {
			await harness.session.dispose();
			throw new Error("closed");
		};
		assert.equal(await harness.session._commitReadyBackgroundCompaction(), undefined);
		assert.equal(harness.session.compaction.state, "ready");
	});
});

describe("background compaction settings changed on disk (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function reloadWith(harness: Harness, compaction: Record<string, unknown>) {
		harness.settingsManager.drainErrors();
		writeFileSync(join(harness.tempDir, "settings.json"), JSON.stringify({ compaction }));
		await harness.settingsManager.reload();
		return harness.settingsManager.drainErrors().map(({ error }) => error);
	}

	test("an invalid value loaded by a reload keeps status reads working, and a valid write clears it", async () => {
		const harness = await createBackgroundHarness(["unused"], new Planner(true));
		harnesses.push(harness);
		const errors = await reloadWith(harness, { backgroundThresholdPercent: 150 });
		assert.equal(errors.length, 1);
		assert.ok(errors[0] instanceof BackgroundCompactionConfigError);
		assert.equal(errors[0].reason, "out-of-range");
		assert.equal(errors[0].source, "settings");

		assert.equal(harness.session.backgroundCompactionThresholdPercent, 75, "the default Atomic falls back to");
		assert.equal(harness.session.backgroundCompactionEnabled, false, "off while a setting is invalid");
		const failed = harness.session.compaction;
		assert.equal(failed.state, "failed");
		assert.ok(failed.error instanceof BackgroundCompactionConfigError);
		assert.equal(failed.error.field, "compaction.backgroundThresholdPercent");
		harness.session._maybeStartBackgroundCompaction(900);
		assert.deepEqual(backgroundStates(harness), ["failed"], "reported once however often it is read");

		harness.session.setBackgroundCompactionEnabled(true);
		assert.equal(harness.session.compaction.state, "failed", "the threshold is still invalid");
		assert.deepEqual(backgroundStates(harness), ["failed"]);

		harness.session.setBackgroundCompactionThresholdPercent(60);
		assert.equal(harness.session.compaction.state, "idle");
		assert.equal(harness.session.backgroundCompactionEnabled, true);
		assert.equal(harness.session.backgroundCompactionThresholdPercent, 60);
		assert.deepEqual(backgroundStates(harness), ["failed", "idle"]);
	});

	test("a reload that replaces one invalid value with another reports the new one", async () => {
		const harness = await createBackgroundHarness(["unused"], new Planner(true));
		harnesses.push(harness);
		await reloadWith(harness, { backgroundThresholdPercent: "75" });
		const first = harness.session.compaction.error;
		assert.ok(first instanceof BackgroundCompactionConfigError);
		assert.equal(first.reason, "not-a-number");
		const sameField = await reloadWith(harness, { backgroundThresholdPercent: 150 });
		assert.equal(sameField.length, 1);
		const second = harness.session.compaction.error;
		assert.ok(second instanceof BackgroundCompactionConfigError);
		assert.equal(second.reason, "out-of-range", "a new reason for the same setting is reported");
		const errors = await reloadWith(harness, { background: "yes" });
		assert.equal(errors.length, 1);
		assert.ok(errors[0] instanceof BackgroundCompactionConfigError);
		assert.equal(errors[0].source, "settings");
		assert.equal(harness.session.backgroundCompactionEnabled, false);
		const state = harness.session.compaction;
		assert.ok(state.error instanceof BackgroundCompactionConfigError);
		assert.equal(state.error.field, "compaction.background");
		assert.equal(state.error.reason, "not-a-boolean");
		assert.deepEqual(backgroundStates(harness), ["failed", "failed", "failed"]);
	});

	test("a settings write leaves a failure that is not about settings in place", async () => {
		const planner = new Planner(true);
		planner.failures = 1;
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		await harness.session.awaitBackgroundCompaction();
		const states = backgroundStates(harness).length;
		harness.session.setBackgroundCompactionThresholdPercent(60);
		assert.equal(harness.session.compaction.error?.code, "planner-failed");
		assert.equal(backgroundStates(harness).length, states, "nothing to report");
	});
});

describe("background compaction while it is off (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function ready(responses: FauxResponseInput[] = [...TRIGGER, ...TWO_TOOL_TURNS, "next"]) {
		const planner = new Planner();
		const harness = await createBackgroundHarness(responses, planner);
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "settings.json"), JSON.stringify(BASE_SETTINGS));
		await harness.settingsManager.reload();
		await startBackgroundTask(harness, planner);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready");
		return { harness, planner };
	}

	async function rpcState(harness: Harness) {
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: vi.fn(),
		});
		const response = await handle({ id: "state", type: "get_state" });
		assert.ok(response?.success === true && response.command === "get_state");
		return response.data.compaction;
	}

	/** Every surface reports the same state: the SDK, RPC `get_state` and the last state event. */
	async function assertSameStateEverywhere(harness: Harness, expected: string) {
		const sdk = serializeBackgroundCompactionState(harness.session.compaction);
		assert.equal(sdk.state, expected);
		assert.deepEqual(await rpcState(harness), sdk);
		assert.deepEqual(harness.eventsOfType("background_compaction").at(-1)?.compaction, sdk);
		assert.deepEqual(serializeBackgroundCompactionState(await harness.session.awaitBackgroundCompaction()), sdk);
	}

	test("a saved result reads idle while background compaction is off and ready again once it is back on", async () => {
		const { harness } = await ready();
		await assertSameStateEverywhere(harness, "ready");
		harness.session.setBackgroundCompactionEnabled(false);
		await assertSameStateEverywhere(harness, "idle");
		assert.deepEqual(backgroundStates(harness).slice(-1), ["idle"]);
		const events = backgroundStates(harness).length;
		harness.session.setBackgroundCompactionEnabled(false);
		assert.equal(backgroundStates(harness).length, events, "nothing changed, nothing reported");

		const commits = harness.eventsOfType("compaction_end").length;
		const waits = countHookQueueWaits(harness);
		await harness.session.prompt("work");
		assert.deepEqual(waits, [0, 0], "nothing to apply, nothing to wait for");
		assert.equal(compactionEntries(harness.sessionManager).length, 0, "the saved result is not applied while off");
		assert.equal(harness.eventsOfType("compaction_end").length, commits);

		harness.session.setBackgroundCompactionEnabled(true);
		await assertSameStateEverywhere(harness, "ready");
		await harness.session.prompt("next");
		assert.equal(compactionEntries(harness.sessionManager).length, 1, "applied exactly once");
	});

	test("an invalid setting reads failed on every surface", async () => {
		const { harness } = await ready();
		writeFileSync(
			join(harness.tempDir, "settings.json"),
			JSON.stringify(settingsWith({ backgroundThresholdPercent: 0 })),
		);
		await harness.settingsManager.reload();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "failed", "even as the first read");
		await assertSameStateEverywhere(harness, "failed");
		assert.equal(harness.session.compaction.error?.code, "invalid-setting");
	});

	test("the hard threshold compacts in the foreground while background compaction is off, even with a saved result", async () => {
		const { harness } = await ready([
			...TRIGGER,
			{ text: "over the hard threshold", usage: { input: 850, output: 10 } },
			"after",
		]);
		harness.session.setBackgroundCompactionEnabled(false);
		await harness.session.prompt("push past the hard threshold");
		await harness.session._awaitPendingPostCompactionContinuation();
		const [boundary] = compactionEntries(harness.sessionManager);
		assert.ok(boundary);
		assert.equal(boundary.coveredThroughEntryId, undefined);
	});

	test("turning automatic compaction off cancels a running task and reports idle", async () => {
		const planner = new Planner();
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		harness.session.setAutoCompactionEnabled(false);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 0);
		assert.equal(backgroundStates(harness).at(-1), "idle");
	});

	test("turning it off forgets task failures and their backoff, so turning it on starts fresh", async () => {
		const planner = new Planner(true);
		planner.failures = 1;
		const harness = await createBackgroundHarness(TRIGGER, planner);
		harnesses.push(harness);
		await startBackgroundTask(harness, planner);
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "failed");
		harness.session.setBackgroundCompactionEnabled(false);
		assert.equal(harness.session.compaction.state, "idle");
		harness.session.setBackgroundCompactionEnabled(true);
		assert.equal(harness.session.compaction.state, "idle", "the old failure is gone");
		harness.session._maybeStartBackgroundCompaction(900);
		assert.equal(harness.session.compaction.state, "running", "no backoff left over");
		await harness.session.awaitBackgroundCompaction();
	});

	test("a task that finishes after background compaction was switched off does not announce its result", async () => {
		const planner = new Planner();
		const wakes: CompactionReadyWake[] = [];
		const harness = await createBackgroundHarness(TRIGGER, planner, {
			compactionWake: { compactionReady: (wake) => wakes.push(wake) },
		});
		harnesses.push(harness);
		const listened: string[] = [];
		harness.session.onCompactionReady((state) => listened.push(state.state));
		await startBackgroundTask(harness, planner);
		harness.settingsManager.setCompactionBackground(false);
		planner.release();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "idle");
		assert.equal(resultEntries(harness.sessionManager).length, 1, "the result is kept for later");
		assert.deepEqual(listened, []);
		assert.deepEqual(wakes, []);
		assert.equal(backgroundStates(harness).at(-1), "idle");
	});
});
