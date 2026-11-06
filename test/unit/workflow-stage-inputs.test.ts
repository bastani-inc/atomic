import assert from "node:assert/strict";
import { test } from "vitest";
import { serializeError } from "../../packages/workflows/src/shared/error-codec.js";
import type {
	PendingStageMessage,
	RunSnapshot,
	StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { WorkerLostError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { EndedWatches } from "../../packages/workflows/src/workers/ended-watches.js";
import {
	isRemoteStageCommandUnsupportedError,
	isRetryableWorkerPlacementError,
	isStageInputInvalidError,
	isStageInputRefusedError,
	isStageInputTimeoutError,
	isWorkerPlacementError,
	RemoteStageCommandUnsupportedError,
	rehydrateWorkerPlacementError,
	type StageInputIdentity,
	StageInputInvalidError,
	StageInputRefusedError,
	StageInputTimeoutError,
	StaleStageLeaseError,
	serializeWorkerPlacementError,
	stageInputRefusedReason,
	type WorkerPlacementError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import type { WorkerDeliver } from "../../packages/workflows/src/workers/protocol.js";
import {
	RemoteStageDrains,
	remoteStageDrainTargets,
	runsOnOtherHost,
} from "../../packages/workflows/src/workers/remote-stage-drains.js";
import { RemoteStageInbox } from "../../packages/workflows/src/workers/remote-stage-inbox.js";
import { RemoteStageWatches } from "../../packages/workflows/src/workers/remote-stage-watches.js";
import {
	earlierSessionReceipt,
	endedIntercomReason,
	endedUserMessage,
	intercomMessageOutcome,
	intercomMessageResult,
	questionReadOutcome,
	questionReadResult,
	userMessageOutcome,
	userMessageResult,
} from "../../packages/workflows/src/workers/stage-input-receipts.js";
import {
	awaitStageInputReceipt,
	isAttempt,
	type PolledStageInput,
	StageInputRetries,
	StageInputScheduler,
	TEXT_STAGE_INPUT_KINDS,
	workEnded,
	workHeld,
} from "../../packages/workflows/src/workers/stage-input-wait.js";
import type { PooledStageQuestion, WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const input: StageInputIdentity = { root: "root", runId: "run", stageId: "stage", seq: 3, kind: "intercom-message" };
const question: PooledStageQuestion = {
	promptId: "q1",
	kind: "ask_user_question",
	params: {
		questions: [
			{
				question: "Ship?",
				header: "Ship",
				multiSelect: false,
				options: [
					{ label: "yes", description: "Ship it" },
					{ label: "no", description: "Hold it" },
				],
			},
		],
	},
};

function acrossProcesses(error: WorkerPlacementError): WorkerPlacementError {
	return rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(error))));
}

async function settled(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

test("a stage input timeout says how far the input got and that the input stays queued (#4391)", () => {
	const unclaimed = new StageInputTimeoutError(input, { timeoutMs: 60_000, elapsedMs: 60_012, phase: "unclaimed" });
	assert.equal(
		unclaimed.message,
		"Stage input timed out: intercom-message input 3 of stage stage in run run (stage-input-timeout): no worker host took it within 60000 ms. It stays queued: the worker host that holds the stage takes it once one runs, so check that a worker host serving this root is running.",
	);
	assert.deepEqual(
		[unclaimed.name, unclaimed.code, unclaimed.retryable, unclaimed.phase, unclaimed.timeoutMs, unclaimed.elapsedMs],
		["StageInputTimeoutError", "stage-input-timeout", true, "unclaimed", 60_000, 60_012],
	);
	const applying = new StageInputTimeoutError(input, { timeoutMs: 5, elapsedMs: 6, phase: "applying" });
	assert.match(applying.message, /the host that took it did not acknowledge it within 5 ms/);
	assert.equal(
		applying.hint,
		"It stays queued under its stage lease: if the host applying it stopped, the host that takes the stage over applies it once.",
	);
	assert.deepEqual(applying.fields(), {
		root: "root",
		runId: "run",
		stageId: "stage",
		seq: 3,
		kind: "intercom-message",
		timeoutMs: 5,
		elapsedMs: 6,
		phase: "applying",
	});
	const deferred = new StageInputTimeoutError(input, { timeoutMs: 7, elapsedMs: 8, phase: "deferred" });
	assert.equal(
		deferred.message,
		"Stage input timed out: intercom-message input 3 of stage stage in run run (stage-input-timeout): the host running the stage has not had the stage take it within 7 ms. It stays queued: the stage cannot take it yet, as while it waits for an answer or before its session starts, and its host offers it again until it does.",
	);
	assert.ok(isStageInputTimeoutError(applying) && isRetryableWorkerPlacementError(applying));
	assert.ok(isRetryableWorkerPlacementError(new Error("wrapped", { cause: applying })), "the chain is walked");
});

test("a refused stage input names why, with the stage's own detail only when it gave one (#4391)", () => {
	const failed = new StageInputRefusedError("stage-failed", { ...input, kind: "user-message" }, { detail: "busy" });
	assert.equal(
		failed.message,
		"Stage input refused: user-message input 3 of stage stage in run run (stage-input-refused): the stage could not take it: busy. Check the stage on its worker host, then send it again.",
	);
	assert.deepEqual(failed.fields(), {
		reason: "stage-failed",
		root: "root",
		runId: "run",
		stageId: "stage",
		seq: 3,
		kind: "user-message",
		detail: "busy",
	});
	const reasons = {
		"stage-not-live": [
			"the stage finished before it took it.",
			"Send it to a stage that is still running, or continue in the stage's post-mortem chat.",
		],
		"session-replaced": [
			"the stage session it was meant for was replaced.",
			"It stays queued for the stage's current session.",
		],
		"pool-closed": [
			"the root's worker pool closed before a host took it.",
			"It stays queued and is delivered once the root resumes.",
		],
	} as const;
	for (const [reason, [what, hint]] of Object.entries(reasons)) {
		const refused = new StageInputRefusedError(reason as keyof typeof reasons, input);
		assert.ok(refused.message.endsWith(`(stage-input-refused): ${what} ${hint}`), refused.message);
		assert.deepEqual(
			[refused.code, refused.reason, refused.hint, refused.retryable, refused.detail, "detail" in refused.fields()],
			["stage-input-refused", reason, hint, false, undefined, false],
		);
		assert.ok(isStageInputRefusedError(refused) && !isRetryableWorkerPlacementError(refused));
	}
});

test("an invalid stage input and an unsupported stage command name their subject (#4391)", () => {
	const unknown = new StageInputInvalidError("unknown-kind", {
		kind: "steer",
		runId: "r",
		stageId: "s",
		field: "kind",
	});
	assert.equal(
		unknown.message,
		"Invalid stage input: kind steer for stage s in run r (stage-input-invalid). Nothing was written. Queue the input with a stage input kind and the payload that kind takes.",
	);
	assert.match(
		new StageInputInvalidError("malformed-payload", { kind: "user-message", runId: "r", stageId: "s", field: "text" })
			.message,
		/^Invalid stage input: field text of a user-message input for stage s in run r \(stage-input-invalid\)\./,
	);
	const pause = new RemoteStageCommandUnsupportedError("pause", { runId: "r", stageId: "s" });
	assert.equal(
		pause.message,
		"Stage command unsupported: pause for stage s in run r (remote-stage-command-unsupported): the stage runs on another worker host. Send the stage a message, a steer or a follow-up instead: pause, resume, /compact and ! commands reach only stages on the root's host.",
	);
	assert.deepEqual(
		[pause.code, pause.command, pause.retryable, pause.fields()],
		["remote-stage-command-unsupported", "pause", false, { command: "pause", runId: "r", stageId: "s" }],
	);
	assert.match(
		new RemoteStageCommandUnsupportedError("session", { runId: "r", stageId: "s" }).message,
		/^Stage command unsupported: a session command for stage s/,
	);
	assert.match(
		new RemoteStageCommandUnsupportedError("resume", { runId: "r", stageId: "s" }).message,
		/^Stage command unsupported: resume for stage s/,
	);
});

test("stage input errors cross a process boundary as the same class, with their fields and causes (#4391)", () => {
	const cause = new StaleStageLeaseError("attempt-replaced", { root: "root", runId: "run", stageId: "stage", seq: 1 });
	const errors: readonly WorkerPlacementError[] = [
		new StageInputInvalidError(
			"malformed-payload",
			{ kind: "intercom-message", runId: "r", stageId: "s", field: "from" },
			{ cause },
		),
		new StageInputTimeoutError(input, { timeoutMs: 10, elapsedMs: 11, phase: "applying" }, { cause }),
		new StageInputRefusedError("stage-failed", input, { detail: "no session", cause }),
		new StageInputRefusedError("session-replaced", input),
		new RemoteStageCommandUnsupportedError("resume", { runId: "r", stageId: "s" }, { cause }),
	];
	const guards = [
		isStageInputInvalidError,
		isStageInputTimeoutError,
		isStageInputRefusedError,
		isStageInputRefusedError,
		isRemoteStageCommandUnsupportedError,
	];
	errors.forEach((error, index) => {
		const copy = acrossProcesses(error);
		assert.equal(copy.constructor, error.constructor, error.name);
		assert.ok(guards[index]!(copy) && isWorkerPlacementError(copy));
		assert.deepEqual(
			[copy.name, copy.code, copy.message, copy.hint, copy.retryable, copy.fields()],
			[error.name, error.code, error.message, error.hint, error.retryable, error.fields()],
		);
		if (error.cause === undefined) assert.equal(copy.cause, undefined);
		else assert.ok(copy.cause instanceof StaleStageLeaseError);
	});
});

test("each stage input guard matches its own class structurally and nothing else (#4391)", () => {
	const shapes = {
		StageInputInvalidError: isStageInputInvalidError,
		StageInputTimeoutError: isStageInputTimeoutError,
		StageInputRefusedError: isStageInputRefusedError,
		RemoteStageCommandUnsupportedError: isRemoteStageCommandUnsupportedError,
	};
	for (const [name, guard] of Object.entries(shapes)) {
		const shape = { name, code: "c", retryable: false };
		assert.equal(guard(shape), true, `${name} matches structurally`);
		assert.equal(isWorkerPlacementError(shape), true, `${name} is of the family`);
		assert.equal(guard(new Error("wrapped", { cause: shape })), true, `${name} is found in the cause chain`);
		for (const [other, otherGuard] of Object.entries(shapes))
			if (other !== name) assert.equal(otherGuard(shape), false, `${other} does not match ${name}`);
	}
	assert.equal(isRetryableWorkerPlacementError({ name: "StageInputTimeoutError", code: "c", retryable: true }), true);
	assert.equal(
		isRetryableWorkerPlacementError({ name: "StageInputTimeoutError", code: "c", retryable: false }),
		false,
	);
	assert.equal(isRetryableWorkerPlacementError({ name: "Other", code: "c", retryable: true }), false);
	assert.equal(isRetryableWorkerPlacementError(new Error("plain")), false);
	// Why a stage refused an input is read from the refusal itself, or from the one a drain's failure wraps.
	const replaced = new StageInputRefusedError("session-replaced", input);
	assert.equal(stageInputRefusedReason(replaced), "session-replaced");
	assert.equal(stageInputRefusedReason(new Error("drain failed", { cause: replaced })), "session-replaced");
	assert.equal(
		stageInputRefusedReason({ name: "StageInputRefusedError", code: "c", retryable: false, reason: "pool-closed" }),
		"pool-closed",
	);
	assert.equal(
		stageInputRefusedReason(new StageInputTimeoutError(input, { timeoutMs: 1, elapsedMs: 1, phase: "unclaimed" })),
		undefined,
	);
	assert.equal(stageInputRefusedReason(new Error("plain")), undefined);
});

test("a question read settles with the question, or why the stage has none, and retries what it cannot take yet (#4391)", () => {
	assert.equal(questionReadOutcome(undefined, "q1"), "retry", "a worker that exited leaves it for the replacement");
	assert.equal(questionReadOutcome({ refusal: "StaleAttempt" }, "q1"), "retry");
	assert.equal(questionReadOutcome({ refusal: "Unconfirmed" }, "q1"), "retry");
	assert.deepEqual(questionReadOutcome({ question }, "q1"), { ok: true, question });
	assert.deepEqual(questionReadOutcome({ refusal: "PromptNotPending" }, "q1"), {
		ok: false,
		refusal: "PromptNotPending",
	});
	assert.deepEqual(questionReadOutcome({ refusal: "StageNotLive" }, "q1"), { ok: false, refusal: "StageNotLive" });
	assert.equal(questionReadOutcome({}, "q1"), "retry", "an answer with nothing in it settles nothing");
	assert.deepEqual(
		questionReadOutcome({ question }, "q-other"),
		{ ok: false, refusal: "PromptNotPending" },
		"a stage that waits on another question has none for this read",
	);
	assert.equal(questionReadResult({ ok: true, question }), question);
	assert.equal(questionReadResult({ ok: false, refusal: "PromptNotPending" }), undefined);
});

test("a user message settles with how it was admitted, typed when the stage failed it (#4391)", () => {
	assert.equal(userMessageOutcome(undefined), "retry");
	assert.equal(userMessageOutcome({ refusal: "StaleAttempt" }), "retry", "a stage that cannot take it yet");
	assert.equal(userMessageOutcome({ refusal: "Unconfirmed" }), "retry");
	assert.equal(
		userMessageOutcome({ refusal: "AwaitingInput" }),
		"defer",
		"a stage that waits for an answer defers it",
	);
	for (const action of ["steer", "followUp", "prompt", "handled"] as const)
		assert.deepEqual(userMessageOutcome({ action }), { ok: true, action });
	assert.deepEqual(userMessageOutcome({ refusal: "StageNotLive" }), { ok: false, refusal: "StageNotLive" });
	const closing = serializeError(new WorkerLostError({ phase: "delivery", pid: 7 }));
	assert.deepEqual(userMessageOutcome({ error: closing }), { ok: false, error: closing });
	assert.equal(userMessageOutcome({}), "retry");
	const message = { ...input, kind: "user-message" as const };
	assert.deepEqual(userMessageResult({ ok: true, action: "steer" }, message), { ok: true, action: "steer" });
	assert.deepEqual(userMessageResult({ ok: false, refusal: "StageNotLive" }, message), {
		ok: false,
		refusal: "StageNotLive",
	});
	assert.throws(
		() => userMessageResult({ ok: false, error: closing }, message),
		(error: unknown) =>
			error instanceof StageInputRefusedError &&
			error.reason === "stage-failed" &&
			error.detail === closing.message &&
			error.cause instanceof WorkerLostError &&
			error.kind === "user-message" &&
			error.seq === 3,
	);
});

test("an Intercom message settles once its session took it; one it could not take stays queued (#4391)", () => {
	assert.equal(intercomMessageOutcome(undefined), "retry");
	assert.equal(intercomMessageOutcome({ refusal: "StaleAttempt" }), "retry", "no sink handed over yet");
	assert.equal(intercomMessageOutcome({ refusal: "Unconfirmed" }), "retry");
	for (const refusal of ["StaleAttempt", "Unconfirmed"] as const)
		assert.deepEqual(
			[
				questionReadOutcome({ refusal, question }, "q1"),
				userMessageOutcome({ refusal, action: "steer" }),
				intercomMessageOutcome({ refusal, error: serializeError(new Error("x")) }),
			],
			["retry", "retry", "retry"],
			`${refusal} leaves the input for later whatever else the answer holds`,
		);
	assert.equal(intercomMessageOutcome({ refusal: "AwaitingInput" }), "defer");
	const ended = serializeError(
		Object.assign(new Error("Intercom runtime no longer active"), {
			name: "IntercomRuntimeInactiveError",
			code: "intercom_unavailable",
		}),
	);
	assert.equal(
		intercomMessageOutcome({ error: ended }),
		"defer",
		"a session whose Intercom runtime ended keeps it queued, behind the inputs that are not text, such as the answer that wakes it",
	);
	const broken = serializeError(new Error("card rejected"));
	assert.deepEqual(
		intercomMessageOutcome({ error: broken }),
		{ ok: false, error: broken },
		"any other failure of the session settles it, so later text is not held behind it",
	);
	assert.equal(intercomMessageOutcome({ refusal: "PromptNotPending" }), "retry");
	assert.deepEqual(intercomMessageOutcome({}), { ok: true });
	assert.deepEqual(intercomMessageOutcome({ refusal: "StageNotLive" }), { ok: false, refusal: "StageNotLive" });
	assert.deepEqual(intercomMessageOutcome({ refusal: "SessionReplaced" }), { ok: false, refusal: "SessionReplaced" });
	assert.equal(intercomMessageResult({ ok: true }, input), undefined);
	// After a failover, a message for the session of an earlier attempt is refused as replaced: the replacement runs
	// another session, which reads the message from the root's queue itself.
	assert.deepEqual(earlierSessionReceipt({ generation: 1 }, { generation: 2 }), {
		ok: false,
		refusal: "SessionReplaced",
	});
	assert.equal(earlierSessionReceipt({ generation: 2 }, { generation: 2 }), undefined);
	assert.equal(earlierSessionReceipt({ generation: 3 }, { generation: 2 }), undefined);
	for (const [refusal, reason] of [
		["StageNotLive", "stage-not-live"],
		["SessionReplaced", "session-replaced"],
	] as const)
		assert.throws(
			() => intercomMessageResult({ ok: false, refusal }, input),
			(error: unknown) => error instanceof StageInputRefusedError && error.reason === reason && error.seq === 3,
		);
	assert.throws(
		() => intercomMessageResult({ ok: false, error: broken }, input),
		(error: unknown) =>
			error instanceof StageInputRefusedError &&
			error.reason === "stage-failed" &&
			error.detail === "card rejected" &&
			error.cause instanceof Error &&
			error.cause.message === "card rejected" &&
			error.kind === "intercom-message",
	);
});

/** A wait whose reads and clock the test scripts: each poll advances the clock by its interval. */
function scripted(
	reads: readonly (PolledStageInput | undefined)[],
	endedAfter = Number.POSITIVE_INFINITY,
	workHeld = false,
) {
	let clock = 1_000;
	let polls = 0;
	let sleeps = 0;
	return {
		get polls() {
			return polls;
		},
		get sleeps() {
			return sleeps;
		},
		wait: {
			read: async () => reads[Math.min(polls++, reads.length - 1)],
			ended: async () => (polls > endedAfter ? ("work-ended" as const) : undefined),
			workHeld: async () => workHeld,
			pollMs: 500,
			now: () => clock,
			sleep: async (ms: number) => {
				sleeps++;
				clock += ms;
			},
		},
	};
}

test("the root waits for an input's receipt, polling once per interval (#4391)", async () => {
	const pending = { done: false, receipt: null, held: false };
	const s = scripted([pending, { ...pending, held: true }, { done: true, receipt: '{"ok":true}', held: false }]);
	assert.deepEqual(await awaitStageInputReceipt(input, s.wait), { receipt: '{"ok":true}' });
	assert.deepEqual([s.polls, s.sleeps], [3, 2]);
	const gone = scripted([pending], 2);
	assert.deepEqual(await awaitStageInputReceipt(input, gone.wait), { ended: "work-ended" });
	assert.deepEqual([gone.polls, gone.sleeps], [3, 2], "the end is checked on each poll, after the read");
	const nullReceipt = scripted([{ done: true, receipt: null, held: false }]);
	assert.deepEqual(await awaitStageInputReceipt(input, nullReceipt.wait), { receipt: "null" });
	const closed = scripted([undefined]);
	assert.deepEqual(
		await awaitStageInputReceipt(input, { ...closed.wait, ended: async () => "pool-closed" as const }),
		{ ended: "pool-closed" },
	);
});

test("past its bound the wait fails typed with the phase the input was in, and without one it keeps waiting (#4391)", async () => {
	const pending = { done: false, receipt: null, held: false };
	const unclaimed = scripted([pending]);
	const timedOut = await awaitStageInputReceipt(input, { ...unclaimed.wait, timeoutMs: 1_500 }).catch(
		(error: Error) => error,
	);
	assert.ok(timedOut instanceof StageInputTimeoutError);
	assert.deepEqual(
		[timedOut.phase, timedOut.timeoutMs, timedOut.elapsedMs, timedOut.seq, unclaimed.sleeps],
		["unclaimed", 1_500, 1_500, 3, 3],
	);
	const applying = scripted([pending, { ...pending, held: true }]);
	const held = await awaitStageInputReceipt(input, { ...applying.wait, timeoutMs: 400 }).catch(
		(error: Error) => error,
	);
	assert.ok(held instanceof StageInputTimeoutError);
	assert.deepEqual([held.phase, held.elapsedMs], ["applying", 500]);
	const gone = scripted([undefined]);
	const vanished = await awaitStageInputReceipt(input, { ...gone.wait, timeoutMs: 0 }).catch((error: Error) => error);
	assert.ok(vanished instanceof StageInputTimeoutError && vanished.phase === "unclaimed");
	// A host runs the stage's work but keeps giving the input back: the input is deferred, not unclaimed.
	const givenBack = scripted([pending], Number.POSITIVE_INFINITY, true);
	const deferred = await awaitStageInputReceipt(input, { ...givenBack.wait, timeoutMs: 1_000 }).catch(
		(error: Error) => error,
	);
	assert.ok(deferred instanceof StageInputTimeoutError);
	assert.equal(deferred.phase, "deferred");
	const heldAndApplying = scripted([{ ...pending, held: true }], Number.POSITIVE_INFINITY, true);
	const applied = await awaitStageInputReceipt(input, { ...heldAndApplying.wait, timeoutMs: 0 }).catch(
		(error: Error) => error,
	);
	assert.ok(applied instanceof StageInputTimeoutError && applied.phase === "applying");
	const patient = scripted([...Array(30).fill(pending), { done: true, receipt: "{}", held: false }]);
	assert.deepEqual(await awaitStageInputReceipt(input, patient.wait), { receipt: "{}" });
	assert.equal(patient.polls, 31, "an unbounded wait polls until the receipt");
});

test("the wait uses the real clock and timers by default (#4391)", async () => {
	let reads = 0;
	const outcome = await awaitStageInputReceipt(input, {
		read: async () =>
			++reads < 3 ? { done: false, receipt: null, held: false } : { done: true, receipt: "1", held: false },
		ended: async () => undefined,
		workHeld: async () => false,
		pollMs: 1,
	});
	assert.deepEqual([outcome, reads], [{ receipt: "1" }, 3]);
	const bounded = await awaitStageInputReceipt(input, {
		read: async () => ({ done: false, receipt: null, held: true }),
		ended: async () => undefined,
		workHeld: async () => false,
		pollMs: 1,
		timeoutMs: 5,
	}).catch((error: Error) => error);
	assert.ok(bounded instanceof StageInputTimeoutError && bounded.elapsedMs >= 5 && bounded.phase === "applying");
});

test("an input its stage cannot take yet is taken again after a doubling wait, so retries cost few writes (#4391)", () => {
	const retries = new StageInputRetries(500, 4_000);
	assert.deepEqual(retries.take("a", 0), [], "a stage with no refusal has its next input taken at once");
	// Count takes over a minute in which the stage refuses every input: each due take is one take and one release.
	let takes = 0;
	for (let now = 0; now <= 60_000; now += 500)
		if (retries.take("a", now) !== undefined) {
			takes++;
			retries.refused("a", now);
		}
	// 0, 500, 1500, 3500, 7500, then every 4000 ms: 18 takes, where a take on every 500 ms pass would be 121.
	assert.equal(takes, 18);
	retries.refused("b", 0);
	assert.deepEqual([retries.take("b", 499), retries.take("b", 500)], [undefined, []]);
	retries.settled("b");
	assert.deepEqual(retries.take("b", 1), [], "a settled stage's next input is taken at once");
	retries.refused("c", 0);
	retries.retain(new Set(["a"]));
	assert.deepEqual([retries.take("a", 60_001), retries.take("c", 1)], [undefined, []], "only waiting stages are kept");
});

test("a stage that defers its text while it waits for an answer has its other inputs taken meanwhile (#4391)", () => {
	const retries = new StageInputRetries(500, 4_000);
	retries.deferred("s", 0);
	assert.deepEqual(TEXT_STAGE_INPUT_KINDS, ["user-message", "intercom-message"]);
	assert.deepEqual(
		retries.take("s", 1),
		TEXT_STAGE_INPUT_KINDS,
		"until its wait is over, only inputs that are not text",
	);
	assert.deepEqual(retries.take("s", 500), [], "then its next input again, text included");
	retries.deferred("s", 500);
	assert.deepEqual(
		[retries.take("s", 1_499), retries.take("s", 1_500)],
		[TEXT_STAGE_INPUT_KINDS, []],
		"the wait doubles",
	);
	retries.refused("s", 1_500);
	assert.deepEqual(retries.take("s", 1_501), TEXT_STAGE_INPUT_KINDS, "a refusal keeps the deferral");
	retries.settled("s");
	assert.deepEqual(retries.take("s", 1_502), [], "a settled input ends the deferral and the wait");
	retries.refused("s", 1_502);
	assert.equal(retries.take("s", 1_503), undefined, "a refusal after it defers nothing");
	retries.deferred("t", 0);
	retries.retain(new Set());
	retries.refused("t", 0);
	assert.equal(retries.take("t", 1), undefined, "a stage forgotten while deferring defers nothing afterwards");
});

test("a remote stage's inbox hands a message to the sink of the session it was meant for (#4391)", async () => {
	const inbox = new RemoteStageInbox();
	const stage = { runId: "run", stageId: "stage" };
	const from = { id: "sender" } as Parameters<WorkerDeliver>[0];
	const message = { id: "m1" } as Parameters<WorkerDeliver>[1];
	assert.deepEqual(await inbox.deliver(stage, "s1", from, message), { refusal: "StaleAttempt" });
	const delivered: string[] = [];
	inbox.register(stage, "s1", async (_from, received) => {
		delivered.push(`s1:${received.id}`);
	});
	assert.deepEqual(await inbox.deliver(stage, "s1", from, message), {});
	assert.deepEqual(await inbox.deliver({ ...stage, stageId: "other" }, "s1", from, message), {
		refusal: "StaleAttempt",
	});
	inbox.register(stage, "s1", async (_from, received) => {
		delivered.push(`s1-again:${received.id}`);
	});
	assert.deepEqual(await inbox.deliver(stage, "s1", from, message), {}, "the session's latest sink is used");
	assert.deepEqual(
		await inbox.deliver(stage, "s2", from, message),
		{ refusal: "StaleAttempt" },
		"a session not handed over yet waits",
	);
	inbox.register(stage, "s2", async () => {
		throw new Error("Intercom session retired");
	});
	assert.deepEqual(await inbox.deliver(stage, "s1", from, message), { refusal: "SessionReplaced" });
	const retired = await inbox.deliver(stage, "s2", from, message);
	assert.deepEqual(
		[retired.refusal, retired.error?.name, retired.error?.message],
		[undefined, "Error", "Intercom session retired"],
	);
	inbox.register(stage, "s3", () => {
		throw "not an error";
	});
	assert.equal((await inbox.deliver(stage, "s3", from, message)).error?.message, "not an error");
	assert.deepEqual(await inbox.deliver(stage, "s2", from, message), { refusal: "SessionReplaced" });
	assert.deepEqual(delivered, ["s1:m1", "s1-again:m1"]);
});

test("the root drains a remote stage once per state, one drain at a time, and again after a failure or a change (#4391)", async () => {
	const drains = new RemoteStageDrains();
	const queue: readonly PendingStageMessage[] = [];
	const target = { runId: "run", stageId: "stage", sessionId: "s1", generation: 1, queues: [queue, undefined] };
	let runs = 0;
	let finish = () => {};
	const drain = () => {
		runs++;
		return new Promise<void>((resolve) => {
			finish = resolve;
		});
	};
	drains.offer(target, drain);
	drains.offer(target, drain);
	assert.equal(runs, 1, "one drain runs per stage at a time");
	finish();
	await settled();
	drains.offer({ ...target, queues: [queue, undefined] }, drain);
	assert.equal(runs, 1, "nothing changed since the last drain finished");
	for (const changed of [
		{ ...target, queues: [[...queue], undefined] },
		{ ...target, sessionId: "s2" },
		{ ...target, generation: 2 },
		{ ...target, queues: [queue] },
	]) {
		drains.offer(changed, drain);
		finish();
		await settled();
		drains.offer(target, drain);
		finish();
		await settled();
	}
	assert.equal(runs, 9, "each change, and the change back, drains again");
	drains.offer({ ...target, generation: 3 }, () => {
		runs++;
		return Promise.reject(new Error("timed out"));
	});
	await settled();
	drains.offer({ ...target, generation: 3 }, drain);
	assert.equal(runs, 11, "a failed drain runs again");
	finish();
	await settled();
	drains.forget(target);
	drains.offer({ ...target, generation: 3 }, drain);
	assert.equal(runs, 12, "a forgotten stage is drained afresh");
	finish();
	await settled();
	drains.offer({ ...target, stageId: "other", generation: 3 }, drain);
	assert.equal(runs, 13, "each stage has its own drains");
});

test("a drain offered while its stage's drain runs, such as one into the session that replaced it, runs once that one ends (#4391)", async () => {
	const drains = new RemoteStageDrains();
	const queues = [[], undefined];
	const ran: string[] = [];
	const endings: (() => void)[] = [];
	const drain =
		(label: string, fails = false) =>
		() => {
			ran.push(label);
			return new Promise<void>((resolve, reject) => {
				endings.push(() => (fails ? reject(new Error("session replaced")) : resolve()));
			});
		};
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s1", generation: 1, queues }, drain("s1", true));
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s2", generation: 2, queues }, drain("s2 first"));
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s2", generation: 2, queues }, drain("s2"));
	assert.deepEqual(ran, ["s1"], "one drain runs per stage at a time");
	endings.shift()?.();
	await settled();
	assert.deepEqual(ran, ["s1", "s2"], "once it fails, the latest drain offered meanwhile runs");
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s2", generation: 2, queues }, drain("s2 again"));
	endings.shift()?.();
	await settled();
	assert.deepEqual(ran, ["s1", "s2"], "the drain offered meanwhile saw what the finished one saw");
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s3", generation: 3, queues }, drain("s3"));
	drains.offer({ runId: "run", stageId: "stage", sessionId: "s4", generation: 4, queues }, drain("s4"));
	drains.forget({ runId: "run", stageId: "stage" });
	endings.shift()?.();
	await settled();
	assert.deepEqual(ran, ["s1", "s2", "s3"], "a stage forgotten while its drain ran drops the drain offered meanwhile");
});

/** A stage as the root's copy of a stage on another host's worker shows it. */
function remoteStage(id: string, fields: Partial<StageSnapshot>): StageSnapshot {
	return {
		id,
		name: `${id} name`,
		status: "running",
		parentIds: [],
		toolEvents: [],
		sessionId: `session-${id}`,
		pendingStageDeliveryAvailable: true,
		...fields,
	};
}

test("the root drains only the stages on another host whose sessions take Intercom messages now (#4391)", () => {
	const runQueue: readonly PendingStageMessage[] = [];
	const rootQueue: readonly PendingStageMessage[] = [];
	const { drain, forget } = remoteStageDrainTargets(
		2,
		[
			{
				id: "run",
				stages: [
					remoteStage("live", {}),
					remoteStage("starting", { sessionId: undefined }),
					remoteStage("released", { status: "waiting" }),
					remoteStage("no-intercom", { pendingStageDeliveryAvailable: false }),
					remoteStage("unknown-intercom", { pendingStageDeliveryAvailable: undefined }),
					remoteStage("done", { status: "completed" }),
					remoteStage("asking", { status: "awaiting_input" }),
				],
			},
			{ id: "other", stages: [remoteStage("live", { sessionId: "other-session" })] },
		],
		(runId) => (runId === "run" ? runQueue : undefined),
		rootQueue,
	);
	assert.deepEqual(drain, [
		{
			target: {
				runId: "run",
				stageId: "live",
				sessionId: "session-live",
				generation: 2,
				queues: [runQueue, rootQueue],
			},
			stageName: "live name",
		},
		{
			target: {
				runId: "run",
				stageId: "asking",
				sessionId: "session-asking",
				generation: 2,
				queues: [runQueue, rootQueue],
			},
			stageName: "asking name",
		},
		{
			target: {
				runId: "other",
				stageId: "live",
				sessionId: "other-session",
				generation: 2,
				queues: [undefined, rootQueue],
			},
			stageName: "live name",
		},
	]);
	assert.deepEqual(
		forget.map((stage) => stage.stageId),
		["starting", "released", "no-intercom", "unknown-intercom", "done"],
	);
	assert.deepEqual(
		[
			runsOnOtherHost("root-host", "host-b/1"),
			runsOnOtherHost("root-host", "root-host/1"),
			runsOnOtherHost(undefined, "host-b/1"),
			runsOnOtherHost("root-host", null),
			runsOnOtherHost("root-host", undefined),
		],
		[true, false, false, false, false],
	);
});

test("the root's views of stages on other hosts end when their attempt is replaced, their stage finishes, or the root's own worker takes their work (#4391)", () => {
	const watches = new RemoteStageWatches((stage) => stage.status === "running");
	const first = { id: "work", generation: 1, worker: "host-b/1", epoch: 1, renewedAt: 0, expiresAt: 10 };
	const run = (status: StageSnapshot["status"]): RunSnapshot => ({
		id: "run",
		name: "child",
		status: "running",
		startedAt: 0,
		inputs: {},
		stages: [remoteStage("stage", { status })],
		toolNodes: [],
	});
	assert.equal(
		watches.open("w0" as WatchId, "run", "stage", remoteStage("stage", {})),
		undefined,
		"nothing relayed it",
	);
	assert.deepEqual(watches.relayed(first, [run("running")]), []);
	assert.equal(watches.attemptOf("run"), first);
	assert.equal(watches.attemptOf("other"), undefined);
	assert.equal(
		watches.open("w0" as WatchId, "run", "stage", remoteStage("stage", { status: "completed" })),
		undefined,
		"a stage that finished opens no view",
	);
	assert.equal(watches.open("w1" as WatchId, "run", "stage", remoteStage("stage", {})), first);
	assert.equal(watches.open("w2" as WatchId, "run", "stage", remoteStage("stage", {})), first);
	assert.deepEqual(watches.get("w1" as WatchId), { work: first, runId: "run", stageId: "stage" });
	assert.equal(watches.close("w2" as WatchId), true);
	assert.equal(watches.close("w2" as WatchId), false);
	const otherWork = { ...first, id: "other-work", generation: 7 };
	assert.deepEqual(
		watches.relayed(otherWork, [{ ...run("completed"), id: "other-run" }]),
		[],
		"another work's activity ends none of them",
	);
	const second = { ...first, generation: 2, worker: "host-c/1" };
	assert.deepEqual(watches.relayed(second, [run("running")]), [["w1", "attempt_fenced"]]);
	assert.equal(watches.get("w1" as WatchId), undefined);
	assert.equal(watches.attemptOf("run"), second);
	assert.equal(watches.open("w3" as WatchId, "run", "stage", remoteStage("stage", {})), second);
	assert.deepEqual(watches.relayed(second, [{ ...run("running"), stages: [] }]), [], "a run without the stage");
	assert.deepEqual(watches.relayed(second, []), [], "activity without the view's run");
	assert.deepEqual(
		watches.relayed(second, [
			{ ...run("completed"), id: "unrelated-run" },
			{ ...run("running"), stages: [remoteStage("other-stage", { status: "completed" }), remoteStage("stage", {})] },
		]),
		[],
		"only the view's own run and stage decide",
	);
	assert.deepEqual(watches.relayed(second, [run("completed")]), [["w3", "stage_finished"]]);
	assert.equal(watches.open("w4" as WatchId, "run", "stage", remoteStage("stage", {})), second);
	assert.equal(watches.open("w5" as WatchId, "other-run", "stage", remoteStage("stage", {})), otherWork);
	assert.deepEqual(watches.takenOver("work"), ["w4"]);
	assert.equal(watches.attemptOf("run"), undefined, "a run the root's own worker took runs there");
	assert.equal(watches.attemptOf("other-run"), otherWork, "another work's run still runs elsewhere");
	assert.deepEqual(watches.get("w5" as WatchId), { work: otherWork, runId: "other-run", stageId: "stage" });
	assert.deepEqual(watches.takenOver("work"), []);
});

test("the coordinator remembers why each watch ended, forgetting the oldest past its capacity (#4391)", () => {
	const ended = new EndedWatches(2);
	ended.remember("w1" as WatchId, "attempt_fenced");
	ended.remember("w2" as WatchId, "stage_finished");
	assert.deepEqual(
		[...ended],
		[
			["w1", "attempt_fenced"],
			["w2", "stage_finished"],
		],
	);
	ended.remember("w3" as WatchId, "resync");
	assert.deepEqual([...ended.keys()], ["w2", "w3"], "the oldest is forgotten once a third is remembered");
	ended.remember("w2" as WatchId, "attempt_fenced");
	assert.deepEqual(
		[...ended],
		[
			["w2", "attempt_fenced"],
			["w3", "resync"],
		],
	);
});

test("a host takes one input per stage at a time, again only after the wait its stage set, and forgets stages with none (#4391)", () => {
	const scheduler = new StageInputScheduler(500, 4_000);
	// Two stages of one run, and a stage of another run with the same id: each is its own stage.
	const a = { runId: "run", stageId: "a", work: "w1" };
	const b = { runId: "run", stageId: "b", work: "w1" };
	const other = { runId: "other", stageId: "a", work: "w2" };
	assert.deepEqual(scheduler.start([a, b, other], 0), [
		{ stage: a, deferred: [] },
		{ stage: b, deferred: [] },
		{ stage: other, deferred: [] },
	]);
	assert.deepEqual(scheduler.start([a, b], 1), [], "each stage's input is still in flight");
	scheduler.finish(a, 10, "retry");
	scheduler.finish({ runId: "run", stageId: "b" }, 10, "settled");
	assert.deepEqual(scheduler.start([a, b], 11), [{ stage: b, deferred: [] }], "a waits, b goes on");
	assert.deepEqual(scheduler.start([a], 510), [{ stage: a, deferred: [] }]);
	scheduler.finish(a, 520, "defer");
	assert.deepEqual(scheduler.start([a], 521), [{ stage: a, deferred: TEXT_STAGE_INPUT_KINDS }], "its other inputs");
	scheduler.finish(a, 522, "idle");
	assert.deepEqual(scheduler.start([a], 523), [{ stage: a, deferred: TEXT_STAGE_INPUT_KINDS }], "still deferring");
	scheduler.finish(a, 524, "settled");
	assert.deepEqual(scheduler.start([a], 525), [{ stage: a, deferred: [] }], "a settled input ends the wait");
	scheduler.finish(a, 526, "retry");
	scheduler.finish(a, 527);
	assert.deepEqual(scheduler.start([a], 528), [], "a failed take keeps the wait set before it");
	assert.deepEqual(scheduler.start([], 529), []);
	assert.deepEqual(scheduler.start([a], 530), [{ stage: a, deferred: [] }], "a stage that had none is forgotten");
});

test("a taken input goes to the slot whose attempt holds it, and the root reads its work's state from its queue (#4391)", () => {
	const attempt = { id: "work", generation: 2 };
	assert.deepEqual(
		[
			isAttempt({ id: "work", generation: 2 }, attempt),
			isAttempt({ id: "work", generation: 1 }, attempt),
			isAttempt({ id: "other", generation: 2 }, attempt),
			isAttempt(undefined, attempt),
		],
		[true, false, false, false],
	);
	const queue = [
		{ id: "other", state: "leased" },
		{ id: "done", state: "completed" },
		{ id: "lost", state: "failed" },
		{ id: "ready", state: "ready" },
		{ id: "running", state: "leased" },
	];
	assert.deepEqual(
		["done", "lost", "gone", "ready", "running"].map((id) => workEnded(queue, id)),
		[true, true, true, false, false],
	);
	assert.deepEqual(
		["running", "ready", "done", "gone"].map((id) => workHeld(queue, id)),
		[true, false, false, false],
		"only the work's own lease counts, not another work's",
	);
	assert.equal(
		workHeld(
			[
				{ id: "ready", state: "ready" },
				{ id: "running", state: "leased" },
			],
			"ready",
		),
		false,
	);
	// Text or a message no stage will take any more: its child ended, or the root's pool closed.
	assert.deepEqual(
		[endedUserMessage("work-ended"), endedUserMessage("pool-closed")],
		[
			{ ok: false, refusal: "StageNotLive" },
			{ ok: false, refusal: "StaleAttempt" },
		],
	);
	assert.deepEqual(
		[endedIntercomReason("work-ended"), endedIntercomReason("pool-closed")],
		["stage-not-live", "pool-closed"],
	);
});
