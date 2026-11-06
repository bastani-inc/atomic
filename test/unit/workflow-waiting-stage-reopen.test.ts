import { describe, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { latestStageSessionCheckpoints } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { rehydrateError } from "../../packages/workflows/src/shared/error-codec.js";
import { STAGE_WAIT_RETRY_ATTEMPTS } from "../../packages/workflows/src/shared/stage-wait.js";
import {
	deserializeStageWaitError,
	isStageRehydrationError,
	isStageWaitRecordError,
	type SerializedStageWaitError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The session store's own failure while it is unreachable, as its adapter reports it. */
function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

function stageNamed(stages: readonly StageSnapshot[] | undefined, name: string): StageSnapshot | undefined {
	return stages?.find((stage) => stage.name === name);
}

/** One task whose tool call detaches; the call finishes as soon as the stage waits on it. */
function watchCi(service: FakeCiService) {
	return {
		definition: workflow({
			name: "reopen-after-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.task("implement", { prompt: "watch ci" });
				return {};
			},
		}),
		onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
			if (event.type === "stage_waiting") service.finishAll();
		},
	};
}

describe("a waiting stage whose session store stays unreachable when it is woken (#4309)", () => {
	test("blocks the run resumably with the results recorded, and a resume continues the turn from them without running the tool again (#4309)", async () => {
		const service = new FakeCiService();
		const backend = await createMemoryTestBackend();
		const store = createStore();
		const { definition, onStageLifecycleEvent } = watchCi(service);
		const refusedReopens: Error[] = [];
		const first = detachingAdapters(service, counters(), {
			failCreationAfter: 1,
			creationFailure: () => {
				const failure = storeUnavailable();
				refusedReopens.push(failure);
				return failure;
			},
			resumable: true,
		});

		const blocked = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: first,
				onStageLifecycleEvent,
			},
		);

		// Blocked, not failed: a recoverable block keeps the run live, marked blocked, for a resume.
		assert.equal(blocked.status, "running", blocked.error);
		assert.equal(refusedReopens.length, STAGE_WAIT_RETRY_ATTEMPTS);
		assert.equal(service.dispatches, 1);
		const source = store.runs().find((candidate) => candidate.id === blocked.runId);
		assert.ok(source);
		assert.ok(source.blockedAt !== undefined);
		assert.equal(source.resumable, true);
		assert.equal(source.failureRecoverability, "recoverable");
		assert.equal(source.failureDisposition, "active_blocked");
		const stage = stageNamed(blocked.stages, "implement");
		assert.equal(stage?.failureRecoverability, "recoverable");
		assert.equal(stage?.failureDisposition, "active_blocked");
		const detail = stage?.failureDetail;
		assert.equal(detail?.family, "stage-wait");
		const rehydration = rehydrateError(detail);
		assert.ok(isStageRehydrationError(rehydration));
		assert.equal(rehydration.code, "session-unavailable");
		assert.equal(rehydration.fields.phase, "reopen");
		assert.equal(rehydration.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
		// The results the stage was woken with are in its durable record, ready for the resume.
		const record = latestStageSessionCheckpoints(backend, blocked.runId).get(stage?.replayKey ?? "");
		assert.deepEqual(
			record?.waitResults?.map((result) => [result.toolCallId, result.content]),
			[["call-implement", [{ type: "text", text: "ci passed" }]]],
		);

		const resumedCounters = counters();
		const resumed = await run(
			definition,
			{},
			{
				runId: blocked.runId,
				store,
				durableBackend: backend,
				releaseWhenWaiting: { afterMs: 0 },
				continuation: { source, resumeFromStageId: source.failedStageId },
				adapters: {
					...detachingAdapters(service, resumedCounters, { resumable: true }),
					sessionStore: first.sessionStore,
				},
				onStageLifecycleEvent,
			},
		);

		assert.equal(resumed.status, "completed", resumed.error);
		// The tool ran once in all: the resume continued the turn from the recorded result, without a prompt.
		assert.equal(service.dispatches, 1);
		assert.equal(resumedCounters.continued.get("implement"), 1);
		assert.equal(resumedCounters.userPrompts.get("implement"), undefined);
		const transcript = await first.sessionStore!.load(record?.sessionId ?? "");
		assert.deepEqual(
			transcript.entries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
			),
			["call-implement"],
		);
	});

	test("a failure that is not the store's keeps its own classification and is not tried again (#4309)", async () => {
		const service = new FakeCiService();
		const { definition, onStageLifecycleEvent } = watchCi(service);
		let refusedReopens = 0;

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters(), {
					failCreationAfter: 1,
					creationFailure: () => {
						refusedReopens += 1;
						return new Error("No API key found for provider faux");
					},
				}),
				onStageLifecycleEvent,
			},
		);

		const stage = stageNamed(result.stages, "implement");
		assert.equal(refusedReopens, 1);
		assert.equal(stage?.failureCode, "missing_api_key");
		assert.equal(stage?.failureDetail, undefined);
	});
});

describe("a waiting stage whose durable wait record cannot be written (#4309)", () => {
	test("carries on, shows the typed reason on its snapshot, and logs it once (#4309)", async () => {
		const backend = await createMemoryTestBackend();
		const commit = backend.commitCheckpoint.bind(backend);
		const journal = { down: false };
		vi.spyOn(backend, "commitCheckpoint").mockImplementation(async (checkpoint, options) => {
			if (journal.down && checkpoint.kind === "stage") throw new Error("journal unreachable");
			return commit(checkpoint, options);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const service = new FakeCiService();
		const store = createStore();
		const events: StageLifecycleEvent[] = [];
		let duringWait: SerializedStageWaitError | undefined;
		const definition = workflow({
			name: "wait-record-down",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				journal.down = true;
				await stage.release();
				duringWait = stageNamed(store.runs()[0]?.stages, "implement")?.waitRecordFailure;
				await stage.rehydrate();
				journal.down = false;
				return {};
			},
		});

		try {
			const result = await run(
				definition,
				{},
				{
					store,
					durableBackend: backend,
					adapters: detachingAdapters(service, counters(), { detach: false }),
					onStageLifecycleEvent: (_runId, event) => events.push(event),
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(
				events.map((event) => event.type),
				["stage_waiting", "stage_rehydrated"],
			);
			// The start of the wait and its end both failed every attempt; the stage logged one reason for both.
			const reasons = warn.mock.calls.filter((call) => String(call[0]).includes("wait-record-unavailable"));
			assert.equal(reasons.length, 1);
			assert.ok(duringWait !== undefined);
			assert.equal(duringWait.fields.phase, "wait-start");
			const failure = stageNamed(result.stages, "implement")?.waitRecordFailure;
			assert.ok(failure !== undefined);
			const error = deserializeStageWaitError(failure);
			assert.ok(isStageWaitRecordError(error));
			assert.equal(error.code, "wait-record-unavailable");
			assert.equal(error.retryable, false);
			assert.equal(error.fields.phase, "wait-end");
			assert.equal(error.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
			assert.equal(error.fields.stageName, "implement");
			assert.equal((error.cause as Error).message, "journal unreachable");
		} finally {
			warn.mockRestore();
		}
	});
});
