import assert from "node:assert/strict";
import type { DetachedToolResult } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import {
	type StageWaitEntry,
	StageWakeDispatcher,
	type StageWakeReport,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { isStageWakeError, registerStageWakeKind, type StageWake } from "../../packages/workflows/src/sdk-surface.js";

declare module "@bastani/atomic/workflows" {
	interface StageWakeKinds {
		/** Registered with a handler by the tests that need one. */
		"report-handled": { readonly note: string };
		/** Never registered. */
		"report-unregistered": { readonly note: string };
	}
}

const RUN = "run-dispatcher-reports";

function identity(stageId: string, runId = RUN): { runId: string; stageId: string; wakeKey: string } {
	return { runId, stageId, wakeKey: stageWakeKey(runId, stageId) };
}

function entry(stageId: string): StageWaitEntry {
	return { ...identity(stageId), reason: "tool" };
}

function handledWake(note: string): StageWake {
	return { kind: "report-handled", note };
}

function unregisteredWake(note: string): StageWake {
	return { kind: "report-unregistered", note };
}

function toolResult(toolCallId: string): DetachedToolResult {
	return {
		toolCallId,
		toolName: "wait_for_ci",
		result: { content: [{ type: "text", text: "ci passed" }], details: undefined },
		isError: false,
	};
}

function recording(
	runId = RUN,
	signal?: AbortSignal,
): { readonly dispatcher: StageWakeDispatcher; readonly reports: StageWakeReport[] } {
	const reports: StageWakeReport[] = [];
	return { dispatcher: new StageWakeDispatcher(runId, signal, { report: (report) => reports.push(report) }), reports };
}

async function settle(): Promise<void> {
	for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail("expected the wait to be rejected"),
		(reason: unknown) => reason,
	);
}

function stageWakeErrorFields(run: () => unknown): Record<string, unknown> {
	try {
		run();
	} catch (error) {
		assert.ok(isStageWakeError(error), `expected a StageWakeError, got ${String(error)}`);
		return { ...error.fields };
	}
	return assert.fail("expected the message to be refused");
}

describe("what a run's wake dispatcher reports and refuses (#4309)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("without a report option each kind of report is one warning line naming its stage and run (#4309)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const remove = registerStageWakeKind("report-handled", () => {
			throw new Error("could not apply");
		});
		try {
			const ended = new StageWakeDispatcher("run-ended-warned", undefined);
			ended.open(identity("stage-1", "run-ended-warned"));
			ended.deliver(stageWakeKey("run-ended-warned", "stage-1"), handledWake("fails"));
			await settle();
			ended.dispose();

			const stageEnded = new StageWakeDispatcher("run-stage-warned", undefined);
			stageEnded.open(identity("stage-2", "run-stage-warned"));
			stageEnded.deliver(stageWakeKey("run-stage-warned", "stage-2"), { kind: "tool-results", results: [] });
			stageEnded.deliver(stageWakeKey("run-stage-warned", "stage-2"), { kind: "tool-results", results: [] });
			stageEnded.close(stageWakeKey("run-stage-warned", "stage-2"));
			stageEnded.dispose();

			const runEnded = new StageWakeDispatcher("run-disposed-warned", undefined);
			runEnded.open(identity("stage-3", "run-disposed-warned"));
			runEnded.deliver(stageWakeKey("run-disposed-warned", "stage-3"), { kind: "tool-results", results: [] });
			runEnded.dispose();
		} finally {
			remove();
		}

		assert.deepEqual(
			warn.mock.calls.map((call) => call.join(" ")),
			[
				'atomic-workflows: the "report-handled" wake handler failed for stage stage-1 of run run-ended-warned: could not apply',
				"atomic-workflows: stage stage-2 of run run-stage-warned ended with 2 unread wake message(s): tool-results, tool-results",
				"atomic-workflows: stage stage-3 of run run-disposed-warned ended with its run with 1 unread wake message(s): tool-results",
			],
		);
	});

	test("a handler that throws something that is not an error is reported as an error that says what was thrown and keeps it as its cause (#4309)", async () => {
		const thrown: unknown[] = ["a plain string", { code: 7 }, undefined];
		let next = 0;
		const remove = registerStageWakeKind("report-handled", () => {
			throw thrown[next++];
		});
		try {
			const { dispatcher, reports } = recording();
			const stage = identity("stage-1");
			dispatcher.open(stage);
			for (const note of ["a", "b", "c"]) dispatcher.deliver(stage.wakeKey, handledWake(note));
			await settle();

			assert.deepEqual(
				reports.map((report) => (report.reason === "handler-failed" ? report.error.message : undefined)),
				["a plain string", "[object Object]", "undefined"],
			);
			assert.deepEqual(
				reports.map((report) => (report.reason === "handler-failed" ? report.error.cause : "none")),
				thrown,
			);
			assert.ok(reports.every((report) => report.reason === "handler-failed" && report.error instanceof Error));
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("every refusal says which stage it concerns and why: not open, already waiting, ended while waiting (#4309)", async () => {
		const { dispatcher } = recording();
		const key = stageWakeKey(RUN, "stage-9");
		const notOpen = await rejection(dispatcher.park(key, "tool-results"));
		assert.ok(notOpen instanceof DOMException);
		assert.deepEqual([notOpen.name, notOpen.message], ["AbortError", `atomic-workflows: stage ${key} is not open`]);
		assert.throws(
			() => dispatcher.watchToolResults(key, []),
			(error: unknown) =>
				error instanceof DOMException &&
				error.name === "InvalidStateError" &&
				error.message === `atomic-workflows: stage ${key} is not open`,
		);

		const stage = identity("stage-1");
		dispatcher.open(stage);
		const first = dispatcher.park(stage.wakeKey, "tool-results");
		const second = await rejection(dispatcher.park(stage.wakeKey, "tool-results"));
		assert.ok(second instanceof DOMException);
		assert.deepEqual(
			[second.name, second.message],
			["InvalidStateError", `atomic-workflows: stage ${stage.wakeKey} is already waiting for a message`],
		);

		dispatcher.close(stage.wakeKey);
		const ended = await rejection(first);
		assert.ok(ended instanceof DOMException);
		assert.deepEqual(
			[ended.name, ended.message],
			["AbortError", `atomic-workflows: stage ${stage.wakeKey} ended while it waited`],
		);
		dispatcher.dispose();
	});

	test("an abort without a reason fails a parked stage with a workflow-killed abort (#4309)", async () => {
		const controller = new AbortController();
		const { dispatcher } = recording(RUN, controller.signal);
		const stage = identity("stage-1");
		dispatcher.open(stage);
		const parked = dispatcher.park(stage.wakeKey, "tool-results");
		controller.abort({ not: "an error" });
		const reason = await rejection(parked);
		assert.ok(reason instanceof DOMException);
		assert.deepEqual([reason.name, reason.message], ["AbortError", "workflow killed"]);
		dispatcher.dispose();
	});

	test("a message to a stage that was never opened names the stage by its key, and a message to an open one by its own identity (#4309)", () => {
		const { dispatcher } = recording();
		// The stage id is what follows the first slash of the key; a key without one is the stage id itself.
		assert.deepEqual(
			stageWakeErrorFields(() => dispatcher.deliver("run/stage-9", unregisteredWake("lost"))),
			{
				runId: RUN,
				stageId: "stage-9",
				kind: "report-unregistered",
			},
		);
		assert.equal(
			stageWakeErrorFields(() => dispatcher.deliver("no-slash", unregisteredWake("lost"))).stageId,
			"no-slash",
		);
		assert.equal(
			stageWakeErrorFields(() => dispatcher.deliver("/leading", unregisteredWake("lost"))).stageId,
			"leading",
		);
		assert.equal(stageWakeErrorFields(() => dispatcher.deliver("run/a/b", unregisteredWake("lost"))).stageId, "a/b");

		dispatcher.open({ runId: "run-of-the-stage", stageId: "id-of-the-stage", wakeKey: "some-key" });
		assert.deepEqual(
			stageWakeErrorFields(() => dispatcher.deliver("some-key", unregisteredWake("lost"))),
			{
				runId: "run-of-the-stage",
				stageId: "id-of-the-stage",
				kind: "report-unregistered",
			},
		);
		dispatcher.dispose();
	});

	test("a detached call's result is ignored when its stage is gone or a newer watch replaced its own, and is never an error (#4309)", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const parked = dispatcher.park(waiting.wakeKey, "tool-results");
		dispatcher.watchToolResults(waiting.wakeKey, [
			{ toolCallId: "call-1", toolName: "wait_for_ci", result: new Promise(() => {}), abort() {} },
		]);

		assert.doesNotThrow(() => dispatcher.toolResultSettled("run/unknown", 1, "call-1", toolResult("call-1")));
		assert.doesNotThrow(() => dispatcher.toolResultFailed("run/unknown", 1, new Error("late")));
		// A result of another watch than the current one changes nothing.
		dispatcher.toolResultSettled(waiting.wakeKey, 99, "call-1", toolResult("call-1"));
		dispatcher.toolResultFailed(waiting.wakeKey, 99, new Error("stale"));
		await settle();
		// An open stage with no watch at all ignores both too.
		const idle = identity("stage-2");
		dispatcher.open(idle);
		assert.doesNotThrow(() => dispatcher.toolResultSettled(idle.wakeKey, 1, "call-1", toolResult("call-1")));
		assert.doesNotThrow(() => dispatcher.toolResultFailed(idle.wakeKey, 1, new Error("late")));
		dispatcher.close(waiting.wakeKey);
		await rejection(parked);
		dispatcher.dispose();
	});

	test("a watched call that rejects fails the wait with that error or text as it is, and with the text of anything else (#4309)", async () => {
		const failures: readonly [unknown, unknown][] = [
			[new Error("host broke"), undefined],
			["host broke as text", "host broke as text"],
			[42, "42"],
			[{ code: 7 }, "[object Object]"],
		];
		for (const [thrown, expected] of failures) {
			const { dispatcher } = recording();
			const waiting = entry("stage-1");
			dispatcher.register(waiting);
			const parked = dispatcher.park(waiting.wakeKey, "tool-results");
			const result = Promise.withResolvers<DetachedToolResult>();
			dispatcher.watchToolResults(waiting.wakeKey, [
				{ toolCallId: "call-1", toolName: "wait_for_ci", result: result.promise, abort() {} },
			]);
			result.reject(thrown);
			const reason = await rejection(parked);
			assert.equal(reason, expected === undefined ? thrown : expected);
			dispatcher.dispose();
		}
	});

	test("the later results of a stage whose wait failed on a rejected call do not reach it (#4309)", async () => {
		const { dispatcher } = recording();
		const waiting = entry("stage-1");
		dispatcher.register(waiting);
		const broken = Promise.withResolvers<DetachedToolResult>();
		const fine = Promise.withResolvers<DetachedToolResult>();
		dispatcher.watchToolResults(waiting.wakeKey, [
			{ toolCallId: "call-1", toolName: "wait_for_ci", result: broken.promise, abort() {} },
			{ toolCallId: "call-2", toolName: "wait_for_ci", result: fine.promise, abort() {} },
		]);
		broken.reject(new Error("host broke"));
		await settle();
		fine.resolve(toolResult("call-2"));
		await settle();
		const reason = await rejection(dispatcher.park(waiting.wakeKey, "tool-results"));
		assert.equal((reason as Error).message, "host broke");
		dispatcher.dispose();
	});

	test("a stage opened after the run was aborted takes no message: a handler never runs and the message stays queued (#4309)", async () => {
		const handled: string[] = [];
		const remove = registerStageWakeKind("report-handled", (wake) => {
			handled.push(wake.note);
		});
		try {
			const controller = new AbortController();
			controller.abort(new Error("killed"));
			const { dispatcher } = recording(RUN, controller.signal);
			const stage = identity("stage-1");
			dispatcher.open(stage);
			assert.deepEqual(dispatcher.deliver(stage.wakeKey, handledWake("after the abort")), { status: "queued" });
			await settle();
			assert.deepEqual(handled, []);
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("a cancelled stage takes no message either: handlers do not run for it and its messages stay queued (#4309)", async () => {
		const handled: string[] = [];
		const remove = registerStageWakeKind("report-handled", (wake) => {
			handled.push(wake.note);
		});
		try {
			const { dispatcher, reports } = recording();
			const stage = identity("stage-1");
			dispatcher.open(stage);
			dispatcher.cancel(stage.wakeKey, new Error("stage aborted"));
			assert.deepEqual(dispatcher.deliver(stage.wakeKey, handledWake("late")), { status: "queued" });
			await settle();
			assert.deepEqual(handled, []);
			dispatcher.close(stage.wakeKey);
			assert.deepEqual(reports, [
				{ reason: "stage-ended", runId: RUN, stageId: "stage-1", kinds: ["report-handled"] },
			]);
			dispatcher.dispose();
		} finally {
			remove();
		}
	});

	test("closing a stage that is not waiting leaves the count of waiting stages alone, and closing one that is takes it off (#4309)", () => {
		const { dispatcher } = recording();
		dispatcher.register(entry("waiting"));
		dispatcher.open(identity("resident"));
		assert.equal(dispatcher.size, 1);
		dispatcher.close(stageWakeKey(RUN, "resident"));
		assert.equal(dispatcher.size, 1);
		dispatcher.close(stageWakeKey(RUN, "waiting"));
		assert.equal(dispatcher.size, 0);
		dispatcher.close(stageWakeKey(RUN, "waiting"));
		assert.equal(dispatcher.size, 0);
		dispatcher.dispose();
	});

	test("results kept for a resumed stage are handed out once to the stage that takes them, and stay visible until then (#4309)", () => {
		const { dispatcher } = recording();
		const results = [toolResult("call-1")];
		assert.equal(dispatcher.resultsKeptForResume("stage:alpha:1"), undefined);
		dispatcher.keepResultsForResume("stage:alpha:1", results);
		dispatcher.keepResultsForResume("stage:beta:1", [toolResult("call-2")]);
		assert.equal(dispatcher.resultsKeptForResume("stage:alpha:1"), results);
		assert.equal(dispatcher.resultsKeptForResume("stage:alpha:1"), results);
		assert.equal(dispatcher.takeResultsForResume("stage:alpha:1"), results);
		assert.equal(dispatcher.takeResultsForResume("stage:alpha:1"), undefined);
		assert.equal(dispatcher.resultsKeptForResume("stage:alpha:1"), undefined);
		assert.equal(dispatcher.resultsKeptForResume("stage:beta:1")?.[0]?.toolCallId, "call-2");
		dispatcher.dispose();
		assert.equal(dispatcher.resultsKeptForResume("stage:beta:1"), undefined);
		assert.equal(dispatcher.takeResultsForResume("stage:beta:1"), undefined);
	});

	test("a message queued before its kind had a handler runs once one is registered, and a delivery that triggers it says only what became of its own message (#4309)", async () => {
		const handled: string[] = [];
		const removeFirst = registerStageWakeKind("report-handled");
		let removeSecond = () => {};
		try {
			const { dispatcher } = recording();
			const stage = identity("stage-1");
			dispatcher.open(stage);
			assert.deepEqual(dispatcher.deliver(stage.wakeKey, handledWake("queued first")), { status: "queued" });
			removeSecond = registerStageWakeKind("report-handled", (wake) => {
				handled.push(wake.note);
			});
			// The new handler takes the queued message now; the message just delivered is of another kind, nobody waits for it.
			assert.deepEqual(dispatcher.deliver(stage.wakeKey, { kind: "tool-results", results: [] }), {
				status: "queued",
			});
			await settle();
			assert.deepEqual(handled, ["queued first"]);
			dispatcher.dispose();
		} finally {
			removeSecond();
			removeFirst();
		}
	});
});
