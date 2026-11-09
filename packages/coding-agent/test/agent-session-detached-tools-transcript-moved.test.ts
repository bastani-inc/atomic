/**
 * A transcript must not move past a call that detached (#4580): while the session waits on the call's result,
 * nothing starts a turn on it, a compaction keeps the call's turn, and a result for a call whose turn the transcript
 * moved past anyway is dropped instead of failing the host.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import { withDebugLog } from "../../../test/helpers/debug-mode.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.js";
import { isToolDetachmentError } from "../src/index.js";
import {
	detachedResult,
	harnessPool,
	persistedManager,
	reopenedAfterDetaching,
	settlesWithin,
	toolResultIds,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const pool = harnessPool();
const compacting: Harness[] = [];
afterEach(async () => {
	await pool.cleanup();
	while (compacting.length > 0) await compacting.pop()?.cleanup();
});

const NOTIFICATION = { customType: "subagent-notify", content: "child finished", display: true } as const;
const NOTIFICATION_OPTIONS = { triggerTurn: true, stageAdmissionKey: "subagent:child-1" } as const;

/** Stands in for the compaction planner: every compaction keeps this text. */
const compactedText: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
};

function lines(count: number, characters: number): string {
	const width = Math.ceil(characters / count);
	return Array.from({ length: count }, (_, index) => `line ${index} `.padEnd(width, "z")).join("\n");
}

const CONTEXT_WINDOW = 10_000;

/** A session whose automatic compaction threshold sits just above what three short exchanges fill. */
async function compactingHarness(
	tool: ReturnType<typeof waitTool>,
	...observers: ExtensionFactory[]
): Promise<Harness> {
	const harness = await createHarness({
		customTools: [tool.definition],
		extensionFactories: [compactedText, ...observers],
		models: [{ id: "faux-small", contextWindow: CONTEXT_WINDOW }],
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, compression_ratio: 0.5, preserve_recent: 2 },
			retry: { enabled: false },
		},
	});
	compacting.push(harness);
	harness.session.setToolDetachment({ afterMs: 0 });
	return harness;
}

async function exchange(harness: Harness, count: number): Promise<void> {
	harness.setResponses(Array.from({ length: count }, (_, index) => fauxAssistantMessage(`answer ${index}`)));
	for (let index = 0; index < count; index++) await harness.session.prompt(`question ${index}\n${lines(24, 600)}`);
}

function compactionEntries(harness: Harness): CompactionEntry[] {
	return harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

function projectedRoles(harness: Harness): string[] {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.filter((message) => message.role !== "system")
		.map((message) => message.role);
}

/** The results the session's history holds, whatever a compaction since folded into text. */
function recordedResultIds(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
		);
}

function lastAnswer(harness: Harness): string {
	const answer = harness.sessionManager
		.getEntries()
		.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	return answer?.type === "message" ? getMessageText(answer.message) : "";
}

/** Every message in a failure, its aggregated errors and its causes. */
function failureMessages(error: unknown): string[] {
	if (!(error instanceof Error)) return [];
	const nested = error instanceof AggregateError ? error.errors : [];
	return [error.message, ...[...nested, error.cause].flatMap(failureMessages)];
}

async function untilIdle(harness: Harness): Promise<void> {
	await harness.session.agent.waitForIdle();
	const session = harness.session as unknown as { readonly _activePromptCount: number };
	while (session._activePromptCount > 0) await new Promise((resolve) => setImmediate(resolve));
	await harness.session.agent.waitForIdle();
}

describe("a compaction while a call is detached (#4580)", () => {
	test("an automatic compaction at the end of the detaching run keeps the call's turn, so its result is handed back (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		await exchange(harness, 3);
		harness.setResponses([waitForCiTurn("ci-1")]);

		await settlesWithin(harness.session.prompt(`watch ci\n${lines(110, 4_400)}`));

		assert.equal(compactionEntries(harness).length, 1, "the run's end crossed the compaction threshold");
		assert.equal(harness.session.hasPendingDetachedTurn(), true);
		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["ci-1"],
		);
		harness.setResponses([fauxAssistantMessage("ci passed")]);
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
		assert.equal(lastAnswer(harness), "ci passed");
	});

	test("a manual compaction keeps the call's turn, so its result is handed back (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		await exchange(harness, 3);
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.compact();

		assert.equal(harness.session.hasPendingDetachedTurn(), true);
		assert.deepEqual(projectedRoles(harness).slice(-1), ["assistant"], "the call's turn is still a message");
		harness.session.takeDetachedToolCalls();
		harness.setResponses([fauxAssistantMessage("ci passed")]);
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
		assert.equal(lastAnswer(harness), "ci passed");
	});

	test("the boundary covers what came before the call's turn and leaves that turn out (#4580)", async () => {
		const tool = waitTool();
		const planned: string[][] = [];
		const harness = await compactingHarness(tool, (pi) => {
			pi.on("session_before_compact", (event) => {
				planned.push(event.branchEntries.map((entry) => entry.id));
			});
		});
		await exchange(harness, 3);
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		const entries = harness.sessionManager.getEntries();
		const callTurn = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		const beforeCall = entries[entries.indexOf(callTurn!) - 1];

		await harness.session.compact();

		const [boundary] = compactionEntries(harness);
		assert.equal(boundary?.coveredThroughEntryId, beforeCall?.id);
		assert.deepEqual(
			planned,
			[entries.slice(0, entries.indexOf(callTurn!)).map((entry) => entry.id)],
			"the planner saw what precedes the call's turn and nothing of it",
		);
	});

	/** The entry before the turn of the call `harness` waits on: what a boundary may cover. */
	function entryBeforeCallTurn(harness: Harness) {
		const entries = harness.sessionManager.getEntries();
		const callTurn = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		return entries[entries.indexOf(callTurn!) - 1];
	}

	test("a notification held after the call leaves the call's turn out of a manual compaction (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		await exchange(harness, 3);
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		const beforeCall = entryBeforeCallTurn(harness);
		await harness.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);

		await harness.session.compact();

		const [boundary] = compactionEntries(harness);
		assert.equal(boundary?.coveredThroughEntryId, beforeCall?.id);
		assert.equal(harness.session.hasPendingDetachedTurn(), true);
		assert.equal(harness.session.takeDetachedToolCalls().length, 1, "the call was not dropped as stale");
		assert.deepEqual(tool.aborts, []);
		harness.setResponses([fauxAssistantMessage("ci passed, child finished")]);
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
		assert.equal(lastAnswer(harness), "ci passed, child finished");
	});

	test("a message in the context after the call leaves the call's turn out of a manual compaction (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		await exchange(harness, 3);
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		const beforeCall = entryBeforeCallTurn(harness);
		await harness.session.sendCustomMessage(
			{ customType: "note", content: "fyi", display: true },
			{ triggerTurn: false },
		);

		await harness.session.compact();

		const [boundary] = compactionEntries(harness);
		assert.equal(boundary?.coveredThroughEntryId, beforeCall?.id);
		assert.equal(harness.session.takeDetachedToolCalls().length, 1, "the call was not dropped as stale");
		harness.setResponses([fauxAssistantMessage("ci passed")]);
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
	});

	test("a transcript that waits on no call is still covered whole (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		await exchange(harness, 3);

		await harness.session.compact();

		const [boundary] = compactionEntries(harness);
		assert.equal(boundary?.coveredThroughEntryId, undefined);
	});

	test("a compaction with nothing before the call's turn to compact leaves the transcript as it is (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await assert.rejects(harness.session.compact(), /Nothing to compact/);

		assert.deepEqual(compactionEntries(harness), []);
		assert.equal(harness.session.hasPendingDetachedTurn(), true);
	});

	test("a continuation after a compaction does not start a turn while a call is detached (#4580)", async () => {
		const tool = waitTool();
		const harness = await compactingHarness(tool);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("answering the steer")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		await harness.session.steer("also check lint");

		await (
			harness.session as unknown as { _resumeAfterAutoCompaction(): Promise<void> }
		)._resumeAfterAutoCompaction();
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "no turn ran");
		assert.deepEqual(projectedRoles(harness), ["user", "assistant"]);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "toolResult", "user", "assistant"]);
	});
});

describe("whether the transcript waits on a detached call's result (#4580)", () => {
	test("is true from the detach until the result is handed back, and false for a session with nothing detached (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		assert.equal(harness.session.isWaitingOnDetachedResults(), false);
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed")]);

		await settlesWithin(harness.session.prompt("watch ci"));
		assert.equal(harness.session.isWaitingOnDetachedResults(), true);
		harness.session.takeDetachedToolCalls();
		assert.equal(harness.session.isWaitingOnDetachedResults(), true, "taking the call does not answer it");
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(harness.session.isWaitingOnDetachedResults(), false);
	});
});

describe("input that would start a turn while a call is detached (#4580)", () => {
	test("a notification waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed, child finished")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "the notification started no turn");
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "custom"]);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "custom", "toolResult", "custom", "assistant"]);
		assert.equal(harness.getPendingResponseCount(), 0);
	});

	test("a batch of notifications waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.session.setSteeringMode("all");
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed, child finished")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.sendCustomMessages(
			[{ customType: "subagent-notify", content: "earlier output", display: true }, NOTIFICATION],
			NOTIFICATION_OPTIONS,
		);
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "the batch started no turn");
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "custom", "custom"]);
		const cards = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-notify");
		assert.equal(cards.length, 2, "each message of the batch kept its own durable card");
		assert.deepEqual(
			cards.map((card) => (card.type === "custom_message" ? card.stageAdmissionKey : "not a card")),
			["subagent:child-1", undefined],
			"only the first card of the batch keeps the admission key",
		);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(harness), [
			"user",
			"assistant",
			"custom",
			"custom",
			"toolResult",
			"custom",
			"custom",
			"assistant",
		]);
	});

	test("a notification for a reopened session waits for the hand-back, which then finds the session idle (#4580)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.session.setToolDetachment({ afterMs: 0 });
		reopened.setResponses([fauxAssistantMessage("ci passed, child finished")]);

		await reopened.session.sendCustomMessages([NOTIFICATION], NOTIFICATION_OPTIONS);
		await untilIdle(reopened);
		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(reopened.getPendingResponseCount(), 0);
		assert.deepEqual(projectedRoles(reopened), ["user", "assistant", "custom", "toolResult", "custom", "assistant"]);
	});

	test("a notification with a durable card waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed, child finished")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.sendCustomMessage(NOTIFICATION, { ...NOTIFICATION_OPTIONS, persistWhenStreaming: true });
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "the notification started no turn");
		assert.equal(harness.session.hasPendingDetachedTurn(), true);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.equal(harness.getPendingResponseCount(), 0);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
		assert.equal(lastAnswer(harness), "ci passed, child finished");
	});

	test("a batch of notifications with durable cards waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed, child finished")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.sendCustomMessages([NOTIFICATION], { ...NOTIFICATION_OPTIONS, persistWhenStreaming: true });
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "the batch started no turn");
		assert.equal(harness.session.hasPendingDetachedTurn(), true);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.equal(harness.getPendingResponseCount(), 0);
		assert.deepEqual(recordedResultIds(harness), ["ci-1"]);
		assert.equal(lastAnswer(harness), "ci passed, child finished");
	});

	test("queued steering is not continued on a reopened session that waits on a result (#4580)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.session.setToolDetachment({ afterMs: 0 });
		reopened.setResponses([fauxAssistantMessage("ci passed, lint checked")]);
		reopened.session.refreshContext();
		await reopened.session.steer("also check lint");

		await (
			reopened.session as unknown as { _continueQueuedAgentMessages(): Promise<void> }
		)._continueQueuedAgentMessages();
		await untilIdle(reopened);

		assert.equal(reopened.getPendingResponseCount(), 1, "no turn ran");
		assert.deepEqual(projectedRoles(reopened), ["user", "assistant"]);
		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(reopened), ["user", "assistant", "toolResult", "user", "assistant"]);
	});

	test("a session that waits on a result is disposed with a notification held, and the session reopened delivers it after the result (#4580)", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await pool.harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(first.session.prompt("watch ci"));
		await first.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);
		first.session.takeDetachedToolCalls();

		await first.session.dispose();

		assert.deepEqual(projectedRoles(first), ["user", "assistant", "custom"], "nothing was appended after the call");
		const reopened = await pool.harnessWith(
			[tool.definition],
			await SessionManager.open(store, manager.getSessionId()),
		);
		reopened.session.setToolDetachment({ afterMs: 0 });
		const requests: string[] = [];
		reopened.setResponses([
			(context) => {
				requests.push(JSON.stringify(context.messages.map((message) => message.role)));
				return fauxAssistantMessage("ci passed, child finished");
			},
		]);
		const recovery = await reopened.session.startPendingRecovery("workflow_stage_resume");
		assert.equal(recovery.replayed, 1);
		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(requests, ['["system","user","assistant","toolResult","user"]']);
	});

	test("a session whose transcript no longer waits still refuses to be disposed with a notification queued (#4580)", async () => {
		const tool = waitTool();
		const harness = await createHarness({ customTools: [tool.definition] });
		try {
			harness.session.setToolDetachment({ afterMs: 0 });
			harness.setResponses([waitForCiTurn("ci-1")]);
			await settlesWithin(harness.session.prompt("watch ci"));
			await harness.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);
			harness.session.takeDetachedToolCalls();
			await harness.sessionManager.appendMessage({ role: "user", content: "never mind", timestamp: Date.now() });

			await assert.rejects(harness.session.dispose(), (error) => {
				assert.ok(failureMessages(error).some((message) => /queued protected reconciliation/.test(message)));
				return true;
			});
		} finally {
			// The refusal leaves the queued reconciliation in place, so the fixture's own disposal refuses it too.
			await harness.cleanup().catch(() => {});
		}
	});

	test("a follow-up waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const { reopened } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		reopened.session.setToolDetachment({ afterMs: 0 });
		reopened.setResponses([fauxAssistantMessage("ci passed"), fauxAssistantMessage("lint checked")]);
		reopened.session.refreshContext();

		await reopened.session.followUp("also check lint");
		await untilIdle(reopened);

		assert.equal(reopened.getPendingResponseCount(), 2, "the follow-up started no turn");
		assert.deepEqual(projectedRoles(reopened), ["user", "assistant"]);
		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(reopened), ["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
	});

	test("an interrupting message waits for the result instead of starting a turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("ci passed, child finished")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		await harness.session.sendCustomMessage(NOTIFICATION, { ...NOTIFICATION_OPTIONS, deliverAs: "interrupt" });
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 1, "the interrupt started no turn");
		assert.deepEqual(projectedRoles(harness), ["user", "assistant"]);
		harness.session.takeDetachedToolCalls();
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "toolResult", "custom", "assistant"]);
	});

	test("a session whose host gave up its detachment policy starts the turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("child noted")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		harness.session.setToolDetachment(undefined);

		await harness.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 0);
		assert.deepEqual(projectedRoles(harness), ["user", "assistant", "custom", "assistant"]);
	});

	test("a session that was never given a detachment policy still starts the turn (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.setResponses([fauxAssistantMessage("child noted")]);

		await harness.session.sendCustomMessage(NOTIFICATION, NOTIFICATION_OPTIONS);
		await untilIdle(harness);

		assert.equal(harness.getPendingResponseCount(), 0);
		assert.deepEqual(projectedRoles(harness), ["custom", "assistant"]);
	});
});

describe("a call whose turn the transcript moved past (#4580)", () => {
	test("is settled and dropped when the host takes the detached calls, and recorded in the debug log (#4580)", async () => {
		await withDebugLog("ATOMIC_DEBUG", async (log) => {
			const tool = waitTool();
			const harness = await pool.harnessWith([tool.definition]);
			harness.session.setToolDetachment({ afterMs: 0 });
			harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("never mind, done")]);
			await settlesWithin(harness.session.prompt("watch ci"));
			await harness.session.prompt("never mind, report now");

			assert.deepEqual(harness.session.takeDetachedToolCalls(), []);

			assert.equal(tool.aborts.length, 1, "the stale call's work was cancelled");
			assert.match(tool.aborts[0] ?? "", /^AbortError: .*moved past/);
			const [record, ...rest] = log.records().filter((entry) => entry.event === "stale-detached-call");
			assert.equal(rest.length, 0);
			assert.equal(record?.area, "workflow");
			assert.equal(record?.data.toolCallId, "ci-1");
			assert.equal(record?.data.toolName, "wait_for_ci");
			assert.equal(record?.data.reason, "transcript-moved");
			assert.equal(typeof record?.data.sessionId, "string");
		});
	});

	test("is settled and dropped when its turn also wrote text, however many blocks the turn has (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[fauxText("checking the build"), fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("never mind, done"),
		]);
		await settlesWithin(harness.session.prompt("watch ci"));
		await harness.session.prompt("never mind, report now");

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);

		assert.equal(tool.aborts.length, 1);
	});

	test("is dropped once its result is in the transcript, although it was never handed back (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));
		await harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "ci-1",
			toolName: "wait_for_ci",
			content: [{ type: "text", text: "passed elsewhere" }],
			isError: false,
			timestamp: Date.now(),
		});

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);

		assert.equal(tool.aborts.length, 1);
	});

	test("is not taken away while the transcript still waits on it (#4580)", async () => {
		const tool = waitTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await settlesWithin(harness.session.prompt("watch ci"));

		const calls = harness.session.takeDetachedToolCalls();

		assert.deepEqual(
			calls.map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.deepEqual(tool.aborts, []);
	});

	test("its result is ignored when it is handed back, and recorded in the debug log (#4580)", async () => {
		await withDebugLog("ATOMIC_DEBUG", async (log) => {
			const tool = waitTool();
			const { reopened, store, sessionId } = await reopenedAfterDetaching(
				pool,
				[tool.definition],
				[waitForCiTurn("ci-1")],
			);
			const writer = await SessionManager.open(store, sessionId);
			await writer.appendMessage({ role: "user", content: "never mind the build", timestamp: Date.now() });
			const moved = await pool.harnessWith([tool.definition], await SessionManager.open(store, sessionId));
			void reopened;

			await moved.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

			assert.deepEqual(toolResultIds(moved.sessionManager), []);
			assert.deepEqual(projectedRoles(moved), ["user", "assistant", "user"]);
			const records = log.records().filter((entry) => entry.event === "stale-detached-call");
			assert.equal(records.length, 1);
			assert.equal(records[0]?.data.toolCallId, "ci-1");
			assert.equal(records[0]?.data.reason, "transcript-moved");
		});
	});

	test("is dropped, and the call the transcript still waits on is handed back, when a later turn detached another (#4580)", async () => {
		const tool = waitTool();
		const { manager, store } = await persistedManager();
		const first = await pool.harnessWith([tool.definition], manager);
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([waitForCiTurn("ci-0"), waitForCiTurn("ci-1")]);
		await settlesWithin(first.session.prompt("watch ci"));
		await settlesWithin(first.session.prompt("check again"));

		const taken = first.session.takeDetachedToolCalls();

		assert.deepEqual(
			taken.map((call) => call.toolCallId),
			["ci-1"],
		);
		assert.equal(tool.aborts.length, 1, "only the stale call was cancelled");
		const moved = await pool.harnessWith([tool.definition], await SessionManager.open(store, manager.getSessionId()));
		moved.setResponses([fauxAssistantMessage("ci passed")]);
		await moved.session.resumeDetachedTurn([
			detachedResult("ci-0", "an older run"),
			detachedResult("ci-1", "passed"),
		]);
		assert.deepEqual(toolResultIds(moved.sessionManager), ["ci-1"]);
		assert.equal(getMessageText(moved.session.messages.at(-1)), "ci passed");
	});

	test("its result is ignored by a session that holds no detachable tool (#4580)", async () => {
		const tool = waitTool();
		const { store, sessionId } = await reopenedAfterDetaching(pool, [tool.definition], [waitForCiTurn("ci-1")]);
		const writer = await SessionManager.open(store, sessionId);
		await writer.appendMessage({ role: "user", content: "never mind the build", timestamp: Date.now() });
		const toolless = await pool.harnessWith([], await SessionManager.open(store, sessionId));

		await toolless.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.deepEqual(toolResultIds(toolless.sessionManager), []);
	});

	test("still refuses a result for a call no assistant message issued (#4580)", async () => {
		const tool = waitTool();
		const { reopened, store, sessionId } = await reopenedAfterDetaching(
			pool,
			[tool.definition],
			[waitForCiTurn("ci-1")],
		);
		void reopened;
		const writer = await SessionManager.open(store, sessionId);
		await writer.appendMessage({ role: "user", content: "never mind the build", timestamp: Date.now() });
		const moved = await pool.harnessWith([tool.definition], await SessionManager.open(store, sessionId));

		await assert.rejects(moved.session.resumeDetachedTurn([detachedResult("no-such-call", "passed")]), (error) => {
			assert.ok(isToolDetachmentError(error));
			assert.equal(error.code, "unknown-tool-call");
			assert.equal(error.fields.toolCallId, "no-such-call");
			return true;
		});
	});
});
