import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.js";
import type { SendMessagesOptions, SubagentChildPolicy } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	StorageTransientError,
	StorageWriteLockTimeoutError,
	StorageWriterQueueUnusableError,
} from "../src/core/storage/errors.js";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { detachedResult, waitForCiTurn, waitTool } from "./helpers/detached-tools.js";
import { createHarness, type Harness } from "./suite/harness.js";

const CARD_TYPE = "batch-retry-card";
const CONTENTS = ["first batch card", "second batch card", "third batch card"];
const messages = CONTENTS.map((content) => ({ customType: CARD_TYPE, content, display: true }));
const sharedOptions = {
	triggerTurn: true,
	persistWhenStreaming: true,
	stageAdmissionKey: "batch-retry-shared-key",
} satisfies SendMessagesOptions;

const harnesses: Harness[] = [];
const executions: AbortController[] = [];
const finishTools: Array<() => void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses) harness.session.pauseQueuedMessages();
	for (const finish of finishTools.splice(0)) finish();
	for (const execution of executions.splice(0)) execution.abort();
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

async function childHarness(sessionManager: SessionManager): Promise<Harness> {
	const execution = new AbortController();
	executions.push(execution);
	const subagentPolicy = {
		managementActions: "restricted",
		fanoutAuthorized: false,
		inheritProjectContext: false,
		inheritSkills: false,
		depth: 1,
		executionEnded: execution.signal,
		taskPending: () => true,
	} satisfies SubagentChildPolicy;
	const harness = await createHarness({ sessionManager, subagentPolicy });
	harnesses.push(harness);
	return harness;
}

function failThirdCardOnce(manager: SessionManager): Error {
	const append = manager.appendCustomMessageEntry.bind(manager);
	const failure = new SessionConflictError(manager.getSessionId(), 0, 1);
	let failed = false;
	vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
		if (args[0] === CARD_TYPE && args[1] === CONTENTS[2] && !failed) {
			failed = true;
			throw failure;
		}
		return append(...args);
	});
	return failure;
}

function assertCardsSavedOnce(manager: SessionManager): void {
	const contents = manager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : []));
	assert.deepEqual(contents, CONTENTS, "each occurrence has exactly one durable display card, in batch order");
}

function assertConsumedOnce(harness: Harness, contents = CONTENTS): void {
	const consumed = harness
		.eventsOfType("message_end")
		.flatMap((event) =>
			event.message.role === "custom" && event.message.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE
				? [event.message.content]
				: [],
		);
	assert.deepEqual(consumed, contents, "each card's model-facing input is consumed exactly once");
}

function answerMessages(harness: Harness): void {
	harness.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("answered pending input")));
}

async function assertNoReplayOnReopen(
	store: MemorySessionStore,
	sessionId: string,
	retryCompletedBatch = true,
): Promise<void> {
	const reopened = await childHarness(await SessionManager.open(store, sessionId));
	answerMessages(reopened);
	assert.equal((await reopened.session.startPendingRecovery()).replayed, 0, "consumed cards never replay on reopen");
	assert.equal(reopened.eventsOfType("agent_start").length, 0, "reopening consumed cards starts no model turn");
	if (retryCompletedBatch) {
		await reopened.session.sendCustomMessages(messages, sharedOptions);
		await reopened.session.prompt("verify the already completed delivery");
		assertCardsSavedOnce(reopened.sessionManager);
		assertConsumedOnce(reopened, []);
	}
}

test("a shared-key batch retries its third-card write without duplicating an earlier card or model input (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await childHarness(manager);
	const failure = failThirdCardOnce(manager);
	await assert.rejects(harness.session.sendCustomMessages(messages, sharedOptions), (error) => error === failure);
	await harness.session.sendCustomMessages(messages, sharedOptions);
	assertCardsSavedOnce(manager);
	answerMessages(harness);
	await harness.session.prompt("answer the admitted batch");
	assertConsumedOnce(harness);
	assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
	await assertNoReplayOnReopen(store, manager.getSessionId());
});

test("reopening a partially saved batch admits its missing card without replaying completed prefix cards (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const first = await childHarness(manager);
	const failure = failThirdCardOnce(manager);
	await assert.rejects(first.session.sendCustomMessages(messages, sharedOptions), (error) => error === failure);
	const reopened = await childHarness(await SessionManager.open(store, manager.getSessionId()));
	answerMessages(reopened);
	assert.equal((await reopened.session.startPendingRecovery()).replayed, 2, "the saved prefix remains recoverable");
	assertConsumedOnce(reopened, CONTENTS.slice(0, 2));
	await reopened.session.sendCustomMessages(messages, sharedOptions);
	assertCardsSavedOnce(reopened.sessionManager);
	await reopened.session.prompt("answer the missing tail of the batch");
	assertConsumedOnce(reopened);
	await assertNoReplayOnReopen(store, manager.getSessionId());
});

const detachedOptions = {
	triggerTurn: true,
	stageAdmissionKey: "detached-batch-retry",
	stageAdmissionKeys: ["detached-first-card", "detached-second-card", "detached-third-card"],
} satisfies SendMessagesOptions;

async function detachedHarness(manager: SessionManager): Promise<Harness> {
	const tool = waitTool();
	const harness = await createHarness({ sessionManager: manager, customTools: [tool.definition] });
	harnesses.push(harness);
	finishTools.push(() => tool.finish(0, "green"));
	harness.session.setToolDetachment({ afterMs: 0 });
	harness.setResponses([waitForCiTurn("ci-1")]);
	await harness.session.prompt("watch CI");
	assert.equal(harness.session.takeDetachedToolCalls().length, 1);
	assert.equal(harness.session.isWaitingOnDetachedResults(), true);
	return harness;
}

async function sendDetachedBatch(harness: Harness): Promise<unknown> {
	const settled = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "agent_settled") settled.resolve();
	});
	try {
		const failure = await harness.session.sendCustomMessages(messages, detachedOptions).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (harness.session.isStreaming) await settled.promise;
		await harness.session.agent.waitForIdle();
		return failure;
	} finally {
		unsubscribe();
	}
}

test("an unprotected batch waiting on detached results rejects a failed card admission instead of acknowledging it (#5318)", async () => {
	const manager = SessionManager.inMemory();
	const harness = await detachedHarness(manager);
	const failure = failThirdCardOnce(manager);
	assert.equal(await sendDetachedBatch(harness), failure, "the producer must see the rejected admission");
});

test("retrying a detached batch schedules one model-facing reconciliation per saved card (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await detachedHarness(manager);
	failThirdCardOnce(manager);
	await sendDetachedBatch(harness);
	assert.deepEqual(
		manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
			),
		CONTENTS.slice(0, 2),
	);
	assertConsumedOnce(harness, []);
	assert.equal(await sendDetachedBatch(harness), undefined);
	assertCardsSavedOnce(manager);
	answerMessages(harness);
	await harness.session.resumeDetachedTurn([detachedResult("ci-1", "green")]);
	assertConsumedOnce(harness);
	assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
	await assertNoReplayOnReopen(store, manager.getSessionId(), false);
});

test("a batch retries a committed card whose acknowledgement and first read-back failed without appending another entry (#5318)", async () => {
	const store = new MemorySessionStore();
	const failure = new StorageTransientError(store.descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
	});
	let armed = false;
	let lostAcknowledgement = false;
	let failReadBack = false;
	const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			const result = await store.append(...args);
			if (
				armed &&
				!lostAcknowledgement &&
				args[1].some((entry) => entry.type === "custom_message" && entry.content === CONTENTS[2])
			) {
				lostAcknowledgement = true;
				failReadBack = true;
				throw failure;
			}
			return result;
		},
		async readRange(...args: Parameters<MemorySessionStore["readRange"]>) {
			if (failReadBack) {
				failReadBack = false;
				throw failure;
			}
			return store.readRange(...args);
		},
	});
	const manager = await SessionManager.create(faulty, process.cwd());
	const harness = await childHarness(manager);
	const options = {
		...sharedOptions,
		stageAdmissionKeys: ["uncertain-first-card", "uncertain-second-card", "uncertain-third-card"],
	};
	armed = true;
	await assert.rejects(harness.session.sendCustomMessages(messages, options), (error) => error === failure);
	await harness.session.sendCustomMessages(messages, options);
	assertCardsSavedOnce(manager);
	assertCardsSavedOnce(await SessionManager.open(store, manager.getSessionId()));
	answerMessages(harness);
	await harness.session.prompt("answer the batch after storage recovers");
	assertConsumedOnce(harness);
	assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
	await assertNoReplayOnReopen(store, manager.getSessionId(), false);
});

test("concurrent retries of the same protected batch save and reconcile each card once without a stage boundary (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await detachedHarness(manager);
	const settled = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "agent_settled") settled.resolve();
	});
	try {
		await Promise.all([
			harness.session.sendCustomMessages(messages, sharedOptions),
			harness.session.sendCustomMessages(messages, sharedOptions),
		]);
		assertCardsSavedOnce(manager);
		await settled.promise;
		answerMessages(harness);
		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "green")]);
		assertConsumedOnce(harness);
		assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
		await assertNoReplayOnReopen(store, manager.getSessionId());
	} finally {
		unsubscribe();
	}
});

test.each(["single", "batch"] as const)(
	"retrying a completed protected %s while its pause is released starts no empty model turn (#5318)",
	async (mode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerRequests = 0;
		harness.setResponses(
			Array.from({ length: 5 }, () => () => {
				providerRequests += 1;
				return fauxAssistantMessage("completed protected delivery");
			}),
		);
		const initiallySettled = Promise.withResolvers<void>();
		const retrySettled = Promise.withResolvers<void>();
		let settledTurns = 0;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			settledTurns += 1;
			if (settledTurns === 1) initiallySettled.resolve();
			else retrySettled.resolve();
		});
		const send = () =>
			mode === "single"
				? harness.session.sendCustomMessage(messages[0]!, sharedOptions)
				: harness.session.sendCustomMessages(messages, sharedOptions);
		const expectedContents = mode === "single" ? CONTENTS.slice(0, 1) : CONTENTS;
		try {
			await send();
			await initiallySettled.promise;
			assert.equal(providerRequests, 1);
			assertConsumedOnce(harness, expectedContents);
			harness.session.pauseQueuedMessages();
			const retry = send();
			const released = await harness.session.resumeQueuedMessages();
			await retry;
			if (harness.session.isStreaming) await retrySettled.promise;
			await harness.session.agent.waitForIdle();
			assert.equal(released, false, "the completed retry released no input");
			assert.equal(harness.session.pendingMessageCount, 0);
			assert.deepEqual(
				harness.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
					),
				expectedContents,
			);
			assertConsumedOnce(harness, expectedContents);
			assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
			assert.equal(providerRequests, 1, "a completed retry starts no additional provider request");
		} finally {
			unsubscribe();
		}
	},
);

test.each(["held", "protected"] as const)(
	"reopening a saved %s batch refuses an ordinary retry and gives the model each message once (#5318)",
	async (mode) => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const first = mode === "held" ? await childHarness(manager) : await createHarness({ sessionManager: manager });
		if (mode === "protected") harnesses.push(first);
		answerMessages(first);
		const settled = Promise.withResolvers<void>();
		const unsubscribe = first.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		try {
			await first.session.sendCustomMessages(messages, sharedOptions);
			if (mode === "held") await first.session.prompt("answer the held batch");
			await settled.promise;
		} finally {
			unsubscribe();
		}
		assertCardsSavedOnce(manager);
		const reopened = await childHarness(await SessionManager.open(store, manager.getSessionId()));
		const contexts: string[] = [];
		reopened.setResponses([
			(context) => {
				contexts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("checked the saved delivery");
			},
		]);
		await reopened.session.sendCustomMessages(messages, {
			triggerTurn: true,
			stageAdmissionKey: sharedOptions.stageAdmissionKey,
		});
		await reopened.session.prompt("check the transcript");
		assertCardsSavedOnce(reopened.sessionManager);
		assert.equal(contexts.length, 1);
		for (const content of CONTENTS) assert.equal(contexts[0]!.split(content).length - 1, 1);
	},
);

test("an ordinary batch retry after reopening skips a saved prefix without losing its unsaved tail (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const first = await childHarness(manager);
	const failure = failThirdCardOnce(manager);
	await assert.rejects(first.session.sendCustomMessages(messages, sharedOptions), (error) => error === failure);
	const reopened = await childHarness(await SessionManager.open(store, manager.getSessionId()));
	const contexts: string[] = [];
	reopened.setResponses(
		Array.from({ length: 3 }, () => (context) => {
			contexts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("answered admitted input");
		}),
	);
	assert.equal((await reopened.session.startPendingRecovery()).replayed, 2);
	await reopened.session.sendCustomMessages(messages, {
		triggerTurn: true,
		stageAdmissionKey: sharedOptions.stageAdmissionKey,
	});
	await reopened.session.prompt("answer the remaining batch input");
	assertCardsSavedOnce(reopened.sessionManager);
	const last = contexts.at(-1)!;
	for (const content of CONTENTS) assert.equal(last.split(content).length - 1, 1);
});

test("a deleted child's store rejects one protected card then accepts later cards in memory (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await childHarness(manager);
	await store.delete(manager.getSessionId());
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), {
		name: "SessionDeletedError",
	});
	await harness.session.sendCustomMessage(messages[1]!, { ...sharedOptions, stageAdmissionKey: "after-delete-1" });
	await harness.session.sendCustomMessage(messages[2]!, { ...sharedOptions, stageAdmissionKey: "after-delete-2" });
	assert.deepEqual(
		manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
			),
		CONTENTS.slice(1),
	);
});

test("recovering a failed card write waits for an in-flight append acknowledgement and keeps one in-memory entry (#5318)", async () => {
	const store = new MemorySessionStore();
	const written = Promise.withResolvers<void>();
	const acknowledgement = Promise.withResolvers<void>();
	const delayed: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			const result = await store.append(...args);
			if (args[1].some((entry) => entry.type === "custom" && entry.customType === "in-flight")) {
				written.resolve();
				await acknowledgement.promise;
			}
			return result;
		},
	});
	const manager = await SessionManager.create(delayed, process.cwd());
	const harness = await childHarness(manager);
	const failure = new Error("card admission failed before append");
	vi.spyOn(manager, "appendCustomMessageEntry").mockRejectedValueOnce(failure);
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), (error) => error === failure);
	const pending = manager.appendCustomEntry("in-flight", { value: "committed before acknowledgement" });
	await written.promise;
	const retry = harness.session.sendCustomMessage(messages[0]!, sharedOptions);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		acknowledgement.resolve();
	}
	await Promise.all([pending, retry]);
	const entries = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "in-flight");
	assert.equal(entries.length, 1, "the acknowledged append is applied to memory once");
	const reopened = await SessionManager.open(store, manager.getSessionId());
	assert.equal(reopened.getEntries().filter((entry) => entry.id === entries[0]!.id).length, 1);
});

for (const mode of ["single", "batch"] as const) {
	test.each(["paused session", "running child"] as const)(
		`an excluded ${mode} received by a %s is saved immediately without queued model input (#5318)`,
		async (state) => {
			const harness =
				state === "running child" ? await childHarness(SessionManager.inMemory()) : await createHarness();
			if (state === "paused session") harnesses.push(harness);
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			let requests = 0;
			const contexts: string[] = [];
			harness.setResponses(
				Array.from({ length: 3 }, () => async (context) => {
					requests++;
					contexts.push(JSON.stringify(context.messages));
					started.resolve();
					await finish.promise;
					return fauxAssistantMessage("completed the existing work");
				}),
			);
			let task: Promise<void> | undefined;
			if (state === "paused session") harness.session.pauseQueuedMessages();
			else {
				task = harness.session.prompt("perform the original task");
				await started.promise;
			}
			try {
				const options = { triggerTurn: true, excludeFromContext: true };
				if (mode === "single") await harness.session.sendCustomMessage(messages[0]!, options);
				else await harness.session.sendCustomMessages(messages, options);
				assert.deepEqual(
					harness.sessionManager
						.getEntries()
						.flatMap((entry) =>
							entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
						),
					mode === "single" ? CONTENTS.slice(0, 1) : CONTENTS,
				);
				assert.equal(harness.session.pendingMessageCount, 0, "display-only input never waits for a model turn");
				if (state === "paused session") assert.equal(await harness.session.resumeQueuedMessages(), false);
			} finally {
				finish.resolve();
				await task;
			}
			assert.equal(requests, state === "paused session" ? 0 : 1);
			for (const context of contexts) for (const content of CONTENTS) assert.equal(context.includes(content), false);
		},
	);
}

test("an idle retry of a completed protected batch starts no second provider request (#5318)", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	let requests = 0;
	harness.setResponses(
		Array.from({ length: 3 }, () => () => {
			requests++;
			return fauxAssistantMessage("completed the protected batch");
		}),
	);
	const initialSettlement = Promise.withResolvers<void>();
	const retrySettlement = Promise.withResolvers<void>();
	let settlements = 0;
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type !== "agent_settled") return;
		if (++settlements === 1) initialSettlement.resolve();
		else retrySettlement.resolve();
	});
	try {
		await harness.session.sendCustomMessages(messages, sharedOptions);
		await initialSettlement.promise;
		assert.equal(requests, 1);
		await harness.session.sendCustomMessages(messages, sharedOptions);
		if (harness.session.isStreaming) await retrySettlement.promise;
		await harness.session.agent.waitForIdle();
		assert.equal(requests, 1, "a completed batch has no input for another provider request");
		assertCardsSavedOnce(harness.sessionManager);
		assertConsumedOnce(harness);
	} finally {
		unsubscribe();
	}
});

test("deletion after a failed card admission reports deletion once and releases later in-memory writes (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await childHarness(manager);
	const failure = new StorageTransientError(store.descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
	});
	vi.spyOn(manager, "appendCustomMessageEntry").mockRejectedValueOnce(failure);
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), (error) => error === failure);
	await store.delete(manager.getSessionId());
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), {
		name: "SessionDeletedError",
	});
	await harness.session.sendCustomMessage(messages[1]!, { ...sharedOptions, stageAdmissionKey: "later-memory-1" });
	await harness.session.sendCustomMessage(messages[2]!, { ...sharedOptions, stageAdmissionKey: "later-memory-2" });
	assert.deepEqual(
		manager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
			),
		CONTENTS.slice(1),
	);
});

test("reopening a partial excluded batch displays only its missing card on retry (#5318)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const first = await childHarness(manager);
	const failure = failThirdCardOnce(manager);
	const options = { ...sharedOptions, excludeFromContext: true };
	await assert.rejects(first.session.sendCustomMessages(messages, options), (error) => error === failure);
	const reopened = await childHarness(await SessionManager.open(store, manager.getSessionId()));
	assert.deepEqual(
		reopened.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
			),
		CONTENTS.slice(0, 2),
	);
	await reopened.session.sendCustomMessages(messages, options);
	assertCardsSavedOnce(reopened.sessionManager);
	for (const type of ["message_start", "message_end"] as const) {
		assert.deepEqual(
			reopened
				.eventsOfType(type)
				.flatMap((event) =>
					event.message.role === "custom" && event.message.customType === CARD_TYPE ? [event.message.content] : [],
				),
			CONTENTS.slice(2),
			"cards already present in the reopened transcript are not added again",
		);
	}
	assert.equal(reopened.session.pendingMessageCount, 0);
	assert.equal(reopened.eventsOfType("agent_start").length, 0);
});

for (const form of ["single", "batch"] as const) {
	test.each(["keyed single", "keyed batch", "unkeyed single"] as const)(
		`an uncertain excluded ${form} survives intervening %s input without duplicate storage or context (#5318)`,
		async (intervening) => {
			const store = new MemorySessionStore();
			const failure = new StorageTransientError(store.descriptor, {
				code: "connection-lost",
				outcome: "unknown",
				attempts: 1,
			});
			let lostAcknowledgement = false;
			let failReadBack = false;
			const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
				async append(...args: Parameters<SessionStore["append"]>) {
					const result = await store.append(...args);
					if (
						!lostAcknowledgement &&
						args[1].some((entry) => entry.type === "custom_message" && entry.content === CONTENTS[0])
					) {
						lostAcknowledgement = true;
						failReadBack = true;
						throw failure;
					}
					return result;
				},
				async readRange(...args: Parameters<SessionStore["readRange"]>) {
					if (failReadBack) {
						failReadBack = false;
						throw failure;
					}
					return store.readRange(...args);
				},
			});
			const manager = await SessionManager.create(faulty, process.cwd());
			const harness = await createHarness({
				sessionManager: manager,
			});
			harnesses.push(harness);
			const options = { stageAdmissionKey: sharedOptions.stageAdmissionKey, excludeFromContext: true };
			const intended = form === "batch" ? messages : [messages[0]!];
			const send = () =>
				form === "batch"
					? harness.session.sendCustomMessages(intended, options)
					: harness.session.sendCustomMessage(intended[0]!, options);
			await assert.rejects(send(), (error) => error === failure);
			const other = { customType: "intervening-card", content: "other keyed input", display: true };
			const otherOptions = intervening === "unkeyed single" ? {} : { stageAdmissionKey: "intervening-card-key" };
			if (intervening === "keyed batch") await harness.session.sendCustomMessages([other], otherOptions);
			else await harness.session.sendCustomMessage(other, otherOptions);
			await send();
			const reopened = await SessionManager.open(store, manager.getSessionId());
			for (const current of [manager, reopened]) {
				for (const entries of [current.getEntries(), current.getBranch()]) {
					assert.equal(
						entries.filter((entry) => entry.type === "custom_message" && entry.customType === CARD_TYPE).length,
						intended.length,
					);
				}
			}
			const contexts: string[] = [];
			harness.setResponses([
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("completed after recovery");
				},
			]);
			await harness.session.prompt("perform the task after the retried input");
			assert.equal(contexts.length, 1);
			for (const message of intended) assert.equal(contexts[0]!.split(message.content).length - 1, 0);
			for (const type of ["message_start", "message_end"] as const) {
				assert.equal(
					harness
						.eventsOfType(type)
						.filter((event) => event.message.role === "custom" && event.message.customType === CARD_TYPE).length,
					intended.length,
				);
			}
		},
	);
}

test.each(["ordinary", "protected", "excluded"] as const)(
	"later keyed %s cards succeed after conflicts with another writer (#5318, #4970)",
	async (mode) => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const harness =
			mode === "ordinary" ? await createHarness({ sessionManager: manager }) : await childHarness(manager);
		if (mode === "ordinary") harnesses.push(harness);
		const writer = await SessionManager.open(store, manager.getSessionId());
		const send = (key?: string) =>
			harness.session.sendCustomMessage(
				{ customType: CARD_TYPE, content: key ?? "unkeyed input", display: true },
				{
					...(mode === "ordinary" ? {} : { ...sharedOptions, excludeFromContext: mode === "excluded" }),
					stageAdmissionKey: key,
				},
			);
		await writer.appendCustomEntry("other-writer", { value: "before a" });
		await assert.rejects(send("a"), SessionConflictError);
		await writer.appendCustomEntry("other-writer", { value: "before b" });
		await assert.rejects(send("b"), SessionConflictError);
		await send("c");
		await send("d");
		await send();
		await send("e");
		assert.deepEqual(
			manager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
				),
			["c", "d", "unkeyed input", "e"],
		);
	},
);

test("an uncertain card refresh that cannot follow another writer falls through to normal append reconciliation (#5318, #4970)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, process.cwd());
	const harness = await childHarness(manager);
	const writer = await SessionManager.open(store, manager.getSessionId());
	await writer.appendCustomEntry("other-writer", { value: "foreign branch" });
	await assert.rejects(manager.appendCustomEntry("rejected", {}), SessionConflictError);
	const failure = new StorageTransientError(store.descriptor, {
		code: "connection-lost",
		outcome: "unknown",
		attempts: 1,
	});
	vi.spyOn(manager, "appendCustomMessageEntry").mockRejectedValueOnce(failure);
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), (error) => error === failure);
	await writer.appendCustomEntry("other-writer", { value: "another foreign entry" });
	await assert.rejects(harness.session.sendCustomMessage(messages[0]!, sharedOptions), SessionConflictError);
	await harness.session.sendCustomMessage(messages[0]!, sharedOptions);
	assert.deepEqual(
		manager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
			),
		CONTENTS.slice(0, 1),
	);
});

test.each(["not-applied", "write-lock-timeout", "writer-queue-unusable"] as const)(
	"a known %s failure does not require a recovery read before a later keyed card (#5318)",
	async (kind) => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const harness = await childHarness(manager);
		const failure =
			kind === "not-applied"
				? new StorageTransientError(store.descriptor, {
						code: "lock-conflict",
						outcome: "not-applied",
						attempts: 1,
					})
				: kind === "write-lock-timeout"
					? new StorageWriteLockTimeoutError(store.descriptor, { timeoutMs: 1, elapsedMs: 1, phase: "queued" })
					: new StorageWriterQueueUnusableError(store.descriptor, new Error("queue directory was unavailable"));
		vi.spyOn(store, "append").mockRejectedValueOnce(failure);
		const reads = vi.spyOn(store, "readRange").mockRejectedValue(new Error("recovery read is unavailable"));
		await assert.rejects(
			harness.session.sendCustomMessage(messages[0]!, sharedOptions),
			(error) => error === failure,
		);
		await harness.session.sendCustomMessage(messages[1]!, {
			...sharedOptions,
			stageAdmissionKey: "after-known-rejection",
		});
		assert.equal(reads.mock.calls.length, 0, "a definite non-write needs no recovery read");
		assert.deepEqual(
			manager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === CARD_TYPE ? [entry.content] : [],
				),
			CONTENTS.slice(1, 2),
		);
	},
);
