import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	BACKGROUND_COMPACTION_RESULT_TYPE,
	BACKGROUND_COMPACTION_RETRY_BASE_MS,
	type BackgroundCompactionResultRecord,
	type CompactionReadyWake,
} from "../src/core/compaction/background-compaction.ts";
import {
	BackgroundCompactionConfigError,
	BackgroundCompactionPlanningError,
	isBackgroundCompactionDiscardedError,
} from "../src/core/compaction/background-compaction-errors.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import {
	type CompactionEntry,
	type CustomEntry,
	type SessionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import type { Settings } from "../src/core/settings-manager.ts";
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
	session: AgentSession | undefined;
	failures = 0;
	text = "[User]: retained";
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
			return { compactedText: this.text };
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
		extensionFactories: [planner.factory],
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
		assert.equal(backgroundEnds[0].result?.compactedText, "[User]: retained");
		assert.equal(harness.eventsOfType("compaction_start").length, 0);
		assert.equal(harness.session.compaction.state, "idle");
		assert.deepEqual(backgroundStates(harness), ["running", "ready", "idle"]);

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
		assert.ok(
			harness.eventsOfType("entry_appended").some((event) => event.entry.id === stored.id),
			"the stored result is announced like other appended entries",
		);
		unsubscribe();
		assert.equal((await harness.session.awaitBackgroundCompaction()).state, "ready", "await is idempotent");
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
				{ toolCalls: [{ id: "call-a", name: "echo", args: {} }], usage: { input: 760, output: 10 } },
				{
					text: "over the hard threshold",
					usage: { input: 850, output: 10 },
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
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
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
		assert.equal(resultEntries(harness.sessionManager).length, 0);
		assert.equal(compactionEntries(harness.sessionManager).length, 0);

		vi.setSystemTime(Date.now() + BACKGROUND_COMPACTION_RETRY_BASE_MS - 1);
		await harness.session.prompt("inside the backoff");
		assert.equal(planner.calls.length, 1, "no retry before the backoff elapses");
		assert.equal(harness.session.compaction.state, "failed");

		vi.setSystemTime(Date.now() + 2);
		await harness.session.prompt("after the backoff");
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
