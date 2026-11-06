import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	STAGE_WAIT_RETRY_ATTEMPTS,
	STAGE_WAIT_RETRY_BUDGET_MS,
} from "../../packages/workflows/src/shared/stage-wait.js";
import {
	isStageRehydrationError,
	StageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageSessionRuntime } from "./stage-runner-helpers.js";
import {
	endsOnCalls,
	type FakeSessionFields,
	makeResumedRig,
	names,
	REPLAY_KEY,
	type Rig,
	RUN_ID,
	recordedResult,
	rejection,
	STAGE_ID,
	STAGE_NAME,
	storeUnavailable,
} from "./waiting-stage-controller-rig.js";

type Messages = StageSessionRuntime["messages"];

const T0 = new Date("2026-04-01T00:00:00.000Z").getTime();

/** A tool result message, as a session that saved the result of a call has in its transcript. */
function savedResult(toolCallId: string): Messages[number] {
	return { role: "toolResult", toolCallId, toolName: "wait_for_ci", content: [], isError: false, timestamp: 0 };
}

/**
 * A resumed stage whose previous process recorded the result of `c1` (and `c2` when `calls` says so), over sessions
 * whose transcript ends on those calls. `onResume` is the session's own `resumeDetachedTurn`: it is told which session
 * number runs it and may save the results into that session's transcript.
 */
async function resumedOnRecordedResults(
	calls: readonly string[],
	onResume: (sessionNumber: number, messages: Messages, results: readonly DetachedToolResult[]) => Promise<void>,
	extra: { readonly signal?: AbortSignal; readonly fields?: (sessionNumber: number) => FakeSessionFields } = {},
): Promise<Rig> {
	const rig = await makeResumedRig({
		pendingTurn: true,
		durableReplayKey: REPLAY_KEY,
		...(extra.signal === undefined ? {} : { signal: extra.signal }),
		customize: (number) => {
			const messages = endsOnCalls(...calls);
			return {
				messages,
				async resumeDetachedTurn(results: readonly DetachedToolResult[]) {
					await onResume(number, messages, results);
				},
				...extra.fields?.(number),
			};
		},
	});
	rig.dispatcher.keepResultsForResume(
		REPLAY_KEY,
		calls.map((call) => recordedResult(call, `${call} passed before the stop`)),
	);
	return rig;
}

describe("a resumed stage continuing its turn from the results it recorded (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(T0);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("a save that fails with the store while the transcript still lacks the results gives the session up, waits as for a tool, and hands the results over again from a reopened one (#4309)", async () => {
		const rig = await resumedOnRecordedResults(["c1", "c2"], async (number, messages) => {
			if (number === 1) throw storeUnavailable();
			messages.push(savedResult("c1"), savedResult("c2"));
		});

		const turn = rig.ctx.prompt("the original prompt");
		await vi.advanceTimersByTimeAsync(10_000);
		await turn;

		assert.equal(rig.created(), 2);
		assert.deepEqual(names(rig.log, "enter:"), ["enter:tool"]);
		assert.deepEqual(rig.waits[0]?.toolCalls, [
			{ toolCallId: "c1", toolName: "wait_for_ci" },
			{ toolCallId: "c2", toolName: "wait_for_ci" },
		]);
		assert.equal(rig.waits[0]?.since, T0);
		assert.deepEqual(names(rig.log, "dispose#"), ["dispose#1"]);
		assert.deepEqual(
			rig.log.filter((entry) => /^(enter|leave|rehydrated|resultsInTranscript)/.test(entry)),
			["enter:tool", "leave:tool", "rehydrated:tool", "resultsInTranscript"],
		);
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
	});

	test("a save that fails with the store after the transcript has the results is that failure, not a reason to hand them over again (#4309)", async () => {
		const failure = storeUnavailable();
		const rig = await resumedOnRecordedResults(["c1"], async (_number, messages) => {
			messages.push(savedResult("c1"));
			throw failure;
		});

		const turn = rig.ctx.prompt("the original prompt");
		turn.catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);

		assert.equal(await rejection(turn), failure);
		assert.equal(rig.created(), 1);
		assert.deepEqual(names(rig.log, "enter:"), []);
	});

	test("a failure that is not the store's is that failure at once, however the transcript stands (#4309)", async () => {
		const failure = new Error("tool result rejected by a hook");
		const rig = await resumedOnRecordedResults(["c1"], async () => {
			throw failure;
		});

		const turn = rig.ctx.prompt("the original prompt");
		turn.catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);

		assert.equal(await rejection(turn), failure);
		assert.equal(rig.created(), 1);
	});

	test("a store still failing on the last attempt blocks the stage with a typed error naming the session, the attempts and the time they took (#4309)", async () => {
		const failures: Error[] = [];
		const rig = await resumedOnRecordedResults(["c1"], async () => {
			const failure = storeUnavailable();
			failures.push(failure);
			throw failure;
		});

		const turn = rig.ctx.prompt("the original prompt");
		turn.catch(() => {});
		await vi.advanceTimersByTimeAsync(60_000);

		const error = await rejection(turn);
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "session-unavailable");
		assert.equal(error.retryable, true);
		assert.equal(failures.length, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.equal(error.cause, failures.at(-1));
		assert.deepEqual(error.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: rig.createOptions.at(-1)?.sessionManager?.getSessionId(),
			phase: "resume-turn",
			attempts: STAGE_WAIT_RETRY_ATTEMPTS,
			// Two backoffs between three attempts: 500 ms and 2 s with this jitter.
			elapsedMs: 2_500,
			timeoutMs: STAGE_WAIT_RETRY_BUDGET_MS,
		});
		assert.ok(error.message.includes("could not save the results the stage was woken with after 3 attempts"));
		assert.equal(rig.created(), STAGE_WAIT_RETRY_ATTEMPTS);
	});

	test("the run's abort during a failing save is the run's reason, and a stage given up on is not reopened (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = await resumedOnRecordedResults(
			["c1"],
			async () => {
				controller.abort(reason);
				throw storeUnavailable();
			},
			{ signal: controller.signal },
		);

		const turn = rig.ctx.prompt("the original prompt");
		turn.catch(() => {});
		await vi.advanceTimersByTimeAsync(10_000);

		assert.equal(await rejection(turn), reason);
		assert.equal(rig.created(), 1);
	});

	test("the run's abort while the stage waits to hand the results over again ends the wait at once with the run's reason (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const rig = await resumedOnRecordedResults(
			["c1"],
			async () => {
				throw storeUnavailable();
			},
			{ signal: controller.signal },
		);

		const turn = rig.ctx.prompt("the original prompt");
		const settled = turn.then(
			() => "resolved",
			(thrown: unknown) => thrown,
		);
		await vi.waitFor(() => assert.ok(rig.log.includes("enter:tool")));
		await vi.advanceTimersByTimeAsync(100);
		controller.abort(reason);
		await vi.advanceTimersByTimeAsync(0);

		assert.equal(await settled, reason);
		assert.equal(rig.created(), 1);
		assert.equal(rig.ctx.__isReleased?.(), false);
	});
});

describe("a resumed session that returns without the results in its transcript (#4309)", () => {
	function agentLike(stored: Messages): FakeSessionFields {
		return {
			state: {},
			modelRuntime: {},
			getContextUsage: () => undefined,
			sessionManager: { isPersisted: () => true, buildSessionProjection: () => ({ messages: stored }) },
		} as unknown as FakeSessionFields;
	}

	test("fails the turn with a typed error naming the session and every call still waiting on its result, and keeps the stage from completing (#4309)", async () => {
		const stored = endsOnCalls("c1", "c2");
		const rig = await resumedOnRecordedResults(["c1", "c2"], async () => {}, {
			fields: (number) => (number === 1 ? agentLike(stored) : {}),
		});

		const error = await rejection(rig.ctx.prompt("the original prompt"));

		assert.ok(error instanceof StageRehydrationError);
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "results-not-saved");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: rig.createOptions[0]?.sessionManager?.getSessionId(),
			toolCallIds: ["c1", "c2"],
			phase: "resume-turn",
		});
		assert.ok(error.hint.includes(`/workflow resume ${RUN_ID}`), error.hint);
		assert.ok(!rig.log.includes("resultsInTranscript"));
	});

	test("a call the transcript has the result of is not named, and a session that saved everything is left alone (#4309)", async () => {
		const stored = endsOnCalls("c1", "c2");
		const partial = await resumedOnRecordedResults(
			["c1", "c2"],
			async (_number, messages) => {
				messages.push(savedResult("c1"));
				stored.push(savedResult("c1"));
			},
			{ fields: (number) => (number === 1 ? agentLike(stored) : {}) },
		);
		const error = await rejection(partial.ctx.prompt("the original prompt"));
		assert.ok(isStageRehydrationError(error));
		assert.equal(error.code, "results-not-saved");
		assert.deepEqual(error.fields.toolCallIds, ["c2"]);

		const savedAll = endsOnCalls("c1");
		const complete = await resumedOnRecordedResults(
			["c1"],
			async (_number, _messages) => {
				savedAll.push(savedResult("c1"));
			},
			{ fields: (number) => (number === 1 ? agentLike(savedAll) : {}) },
		);
		await complete.ctx.prompt("the original prompt");
		assert.deepEqual(
			complete.log.filter((entry) => entry === "resultsInTranscript"),
			["resultsInTranscript"],
		);
	});

	test("results that answer no call the transcript waits on are dropped from the stage's record, and its calls start again (#4309)", async () => {
		const rig = await makeResumedRig({
			policy: undefined,
			pendingTurn: true,
			durableReplayKey: REPLAY_KEY,
			redispatch: (ci) => [ci.call("c2", { settled: true })],
			customize: (number) => (number === 1 ? { messages: endsOnCalls("c2") } : {}),
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("c1", "an earlier wait's result")]);

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(names(rig.log, "redispatch#"), ["redispatch#1"]);
		assert.ok(rig.log.includes("resultsInTranscript"));
	});

	test("results recorded for a transcript that waits on no turn are spent: the stage drops them and takes no call again (#4309)", async () => {
		const rig = await makeResumedRig({
			policy: undefined,
			pendingTurn: false,
			durableReplayKey: REPLAY_KEY,
		});
		rig.dispatcher.keepResultsForResume(REPLAY_KEY, [recordedResult("c1", "recorded")]);

		await rig.ctx.prompt("the original prompt");

		assert.deepEqual(
			rig.log.filter((entry) => entry === "resultsInTranscript"),
			["resultsInTranscript"],
		);
		assert.deepEqual(names(rig.log, "redispatch#"), []);
		assert.equal(rig.dispatcher.takeResultsForResume(REPLAY_KEY), undefined);
	});
});

describe("a resumed turn with nothing recorded and nothing to start again (#4309)", () => {
	test("continues at once with no results, and a stage without wait hooks resumes the same way (#4309)", async () => {
		for (const hooks of [{}, { noHooks: true }] as const) {
			const rig = await makeResumedRig({
				...hooks,
				policy: undefined,
				pendingTurn: true,
				durableReplayKey: REPLAY_KEY,
				redispatch: () => [],
				customize: (number) => (number === 1 ? { messages: endsOnCalls("c1") } : {}),
			});

			await rig.ctx.prompt("the original prompt");

			assert.deepEqual(names(rig.log, "resume#"), ["resume#1:"], JSON.stringify(hooks));
			assert.deepEqual(names(rig.log, "prompt#"), [], JSON.stringify(hooks));
		}
	});
});
