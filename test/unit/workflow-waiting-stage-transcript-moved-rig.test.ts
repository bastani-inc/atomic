import assert from "node:assert/strict";
import { ToolDetachmentError } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { WorkflowPromptEmptyCompletionFailure } from "../../packages/workflows/src/runs/foreground/stage-runner-messages.js";
import type { StageSessionEvent } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { withDebugLog } from "../helpers/debug-mode.js";
import { detachingOne, makeRig, names, RUN_ID, STAGE_ID, STAGE_NAME, until } from "./waiting-stage-controller-rig.js";

/** Longer than the backoff before a retry of the same prompt, whatever its jitter. */
const RETRY_BACKOFF_BOUND_MS = 10_000;

/** A session whose stage retries a failed attempt of the same model. */
const RETRYING = {
	settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: 1_000 }) },
};

describe("a stage's session that waits on a detached call's result (#4580)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("no prompt is sent to it: the hand-back continues the turn, and the skipped prompt is recorded (#4580)", async () => {
		await withDebugLog("ATOMIC_DEBUG", async (log) => {
			const rig = makeRig({
				customize: (number, log, ci) => {
					if (number !== 1) return {};
					const calls = [ci.call("c1")];
					return {
						isWaitingOnDetachedResults: () => true,
						takeDetachedToolCalls: () => calls.splice(0),
						async prompt(text: string) {
							log.push(`prompt:${text}`);
						},
					};
				},
			});

			const turn = rig.ctx.prompt("go");
			await until(() => rig.log.includes("enter:tool"));
			rig.ci.finish("c1");
			await turn;

			assert.deepEqual(names(rig.log, "prompt:"), []);
			assert.deepEqual(names(rig.log, "steer#"), [], "the stage's own prompt is not steered in either");
			assert.ok(rig.log.includes("resume#2:c1"));
			const [record, ...rest] = log
				.records()
				.filter((entry) => entry.event === "stage-input-held-for-detached-results");
			assert.equal(rest.length, 0);
			assert.equal(record?.area, "workflow");
			assert.equal(record?.data.held, "prompt");
			assert.equal(record?.data.runId, RUN_ID);
			assert.equal(record?.data.stageId, STAGE_ID);
			assert.equal(record?.data.stageName, STAGE_NAME);
			assert.equal(record?.data.errorName, undefined);
		});
	});

	test("a held prompt with the stage's own options is not steered in either; only an operator's message is (#4580)", async () => {
		const rig = makeRig({
			customize: (number, log, ci) => {
				if (number !== 1) return {};
				const calls = [ci.call("c1")];
				return {
					isWaitingOnDetachedResults: () => true,
					takeDetachedToolCalls: () => calls.splice(0),
					async prompt(text: string) {
						log.push(`prompt:${text}`);
					},
				};
			},
		});

		const turn = rig.ctx.prompt("go", { expandPromptTemplates: false });
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(names(rig.log, "prompt:"), []);
		assert.deepEqual(names(rig.log, "steer#"), []);
		assert.ok(rig.log.includes("resume#2:c1"));
	});

	test("a failed attempt that ended on a detached call is not retried with a prompt, and the error is recorded (#4580)", async () => {
		await withDebugLog("ATOMIC_DEBUG", async (log) => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const rig = makeRig({
				customize: (number, log, ci) => {
					if (number !== 1) return {};
					const calls = [ci.call("c1")];
					let prompted = false;
					return {
						...RETRYING,
						isWaitingOnDetachedResults: () => prompted,
						takeDetachedToolCalls: () => calls.splice(0),
						async prompt(text: string) {
							log.push(`prompt:${text}`);
							prompted = true;
							throw new WorkflowPromptEmptyCompletionFailure();
						},
					};
				},
			});

			const turn = rig.ctx.prompt("go");
			await until(() => rig.log.includes("enter:tool"));
			rig.ci.finish("c1");
			await until(() => rig.created() === 2);
			await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BOUND_MS);
			await turn;

			assert.deepEqual(names(rig.log, "prompt:"), ["prompt:go"]);
			assert.ok(rig.log.includes("resume#2:c1"));
			const [record, ...rest] = log
				.records()
				.filter((entry) => entry.event === "stage-input-held-for-detached-results");
			assert.equal(rest.length, 0);
			assert.equal(record?.data.held, "retry");
			assert.equal(record?.data.errorName, "WorkflowPromptEmptyCompletionFailure");
			assert.equal(record?.data.errorCode, "provider_error");
			assert.equal(record?.data.stageId, STAGE_ID);
		});
	});

	test("a message the operator resumes a paused stage with joins the turn the result continues, not dropped (#4580)", async () => {
		const rig = makeRig({
			customize: (number, log, ci) => {
				if (number !== 1) return {};
				const calls = [ci.call("c1")];
				let prompted = false;
				return {
					isWaitingOnDetachedResults: () => prompted,
					takeDetachedToolCalls: () => calls.splice(0),
					async prompt(text: string) {
						log.push(`prompt:${text}`);
						prompted = true;
						void rig.ctx.__requestPause();
					},
				};
			},
		});

		const turn = rig.ctx.prompt("go");
		await until(() => rig.log.includes("prompt:go"));
		await rig.ctx.__resume("operator note: skip the migration");
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");
		await turn;

		assert.deepEqual(names(rig.log, "prompt:"), ["prompt:go"], "the note was not prompted");
		assert.deepEqual(names(rig.log, "steer#1:"), [
			'steer#1:operator note: skip the migration:{"expandPromptTemplates":false}',
		]);
		assert.ok(rig.log.includes("resume#2:c1"));
	});

	test("a failed attempt on a session that waits on nothing is retried with its prompt (#4580)", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		let prompts = 0;
		const rig = makeRig({
			customize: (_number, log) => ({
				...RETRYING,
				isWaitingOnDetachedResults: () => false,
				async prompt(text: string) {
					log.push(`prompt:${text}`);
					prompts += 1;
					if (prompts === 1) throw new WorkflowPromptEmptyCompletionFailure();
				},
			}),
		});

		const turn = rig.ctx.prompt("go");
		await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_BOUND_MS);
		await turn;

		assert.deepEqual(names(rig.log, "prompt:"), ["prompt:go", "prompt:go"]);
	});

	/** A stage whose reopened session is busy at the first hand-back, with the listeners the stage binds to it. */
	function busyOnFirstHandBack(options: { readonly signal?: AbortSignal } = {}) {
		const listeners = new Set<(event: StageSessionEvent) => void>();
		const state = { handBacks: 0, listenersWhenBusy: 0 };
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			customize: (number, log) =>
				number === 1
					? {}
					: {
							subscribe(listener: (event: StageSessionEvent) => void) {
								listeners.add(listener);
								return () => {
									listeners.delete(listener);
								};
							},
							async resumeDetachedTurn() {
								state.handBacks += 1;
								log.push(`handBack#${state.handBacks}`);
								if (state.handBacks > 1) return;
								state.listenersWhenBusy = listeners.size;
								throw new ToolDetachmentError("session-busy", { sessionId: "session-2" });
							},
						},
		});
		const waitingForTheRun = async (): Promise<void> => {
			await until(() => rig.log.includes("enter:tool"));
			rig.ci.finish("c1");
			await until(() => listeners.size > state.listenersWhenBusy && state.handBacks === 1);
		};
		return { rig, listeners, state, waitingForTheRun };
	}

	test("a hand-back that finds it running is tried again as soon as the run has settled (#4580)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { rig, listeners, state, waitingForTheRun } = busyOnFirstHandBack();

		const turn = rig.ctx.prompt("go");
		await waitingForTheRun();
		const listenersWhileWaiting = listeners.size;
		assert.equal(state.handBacks, 1, "the hand-back waits for the run");
		for (const listener of [...listeners]) listener({ type: "agent_start" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(state.handBacks, 1, "only the run's settling ends the wait");
		for (const listener of [...listeners]) listener({ type: "agent_settled", aborted: false });
		await turn;

		assert.equal(state.handBacks, 2);
		assert.equal(vi.getTimerCount(), 0, "the moment's timer is not left behind");
		assert.equal(listeners.size, listenersWhileWaiting - 1, "the stage stopped listening for the run");
		assert.deepEqual(names(rig.log, "prompt#2"), [], "the stage did not prompt the session it handed the results to");
	});

	test("a hand-back that finds it running looks again after a moment even when no settling is heard (#4580)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { rig, state, waitingForTheRun } = busyOnFirstHandBack();

		const turn = rig.ctx.prompt("go");
		await waitingForTheRun();
		assert.equal(state.handBacks, 1);
		await vi.advanceTimersByTimeAsync(1_000);
		await turn;

		assert.equal(state.handBacks, 2);
		assert.equal(vi.getTimerCount(), 0, "no timer is left behind");
	});

	test("an abort of the run ends the wait for a running session with its reason (#4580)", async () => {
		const abort = new AbortController();
		const { rig, listeners, state, waitingForTheRun } = busyOnFirstHandBack({ signal: abort.signal });
		const reason = new Error("the run was cancelled");

		const turn = rig.ctx.prompt("go");
		const failed = turn.then(
			() => undefined,
			(error: unknown) => error,
		);
		await waitingForTheRun();
		const listenersWhileWaiting = listeners.size;
		abort.abort(reason);

		assert.equal(await failed, reason);
		assert.equal(state.handBacks, 1, "the hand-back was not tried again");
		assert.equal(listeners.size, listenersWhileWaiting - 1, "the stage stopped listening for the run");
	});

	test("a hand-back refused for another reason still fails the turn (#4580)", async () => {
		const refusal = new ToolDetachmentError("session-closed", { sessionId: "session-2" });
		const rig = makeRig({
			detachOnPrompt: detachingOne(),
			customize: (number) =>
				number === 1
					? {}
					: {
							async resumeDetachedTurn() {
								throw refusal;
							},
						},
		});

		const turn = rig.ctx.prompt("go");
		const failed = turn.then(
			() => undefined,
			(error: unknown) => error,
		);
		await until(() => rig.log.includes("enter:tool"));
		rig.ci.finish("c1");

		assert.equal(await failed, refusal);
	});
});
