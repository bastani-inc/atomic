import { describe } from "vitest";
import { latestStageSessionCheckpoints } from "../../packages/workflows/src/durable/stage-primitive.js";
import type {
	StageLifecycleEvent,
	StageWaitSnapshot,
} from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

async function settleTicks(rounds = 20): Promise<void> {
	for (let round = 0; round < rounds; round++) await new Promise((resolve) => setImmediate(resolve));
}

interface Sample {
	readonly at: string;
	readonly live: number;
	readonly status: string | undefined;
}

describe("a release and a message that race (#4309)", () => {
	test("release() and sendUserMessage() called together while the session is still disposing end with one live, running session; never waiting with it, in memory or in the durable record (#4309)", async () => {
		const service = new FakeCiService();
		const seen = counters();
		const store = createStore();
		const backend = await createMemoryTestBackend();
		const samples: Sample[] = [];
		const disposal = { gate: Promise.resolve() };
		const stageNamed = (): StageSnapshot | undefined =>
			store.runs()[0]?.stages.find((stage) => stage.name === "implement");
		const sample = (at: string): void => {
			samples.push({ at, live: seen.created - seen.disposed, status: stageNamed()?.status });
		};
		let recordedWait: StageWaitSnapshot | undefined;
		let messageWaitedForRelease = false;
		const definition = workflow({
			name: "release-message-race",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("plan");
				const disposing = Promise.withResolvers<void>();
				disposal.gate = disposing.promise;
				const released = stage.release();
				const sent = stage.sendUserMessage("next");
				await settleTicks();
				messageWaitedForRelease = seen.created === 1 && seen.userPrompts.get("implement") === 1;
				disposal.gate = Promise.resolve();
				disposing.resolve();
				await Promise.all([released, sent]);
				sample("settled");
				const replayKey = stageNamed()?.replayKey ?? "";
				recordedWait = latestStageSessionCheckpoints(backend, store.runs()[0]?.id ?? "").get(replayKey)?.wait;
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store,
				durableBackend: backend,
				adapters: detachingAdapters(service, seen, { detach: false, beforeDispose: () => disposal.gate }),
				onStageLifecycleEvent: (_runId, event: StageLifecycleEvent) => sample(event.type),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.equal(messageWaitedForRelease, true);
		// Waiting only while no session is live; the message's reopening comes after the release, never before it, and
		// gives the stage back the status it had before the release (a ctx.stage stays completed after its prompt).
		assert.deepEqual(samples, [
			{ at: "stage_waiting", live: 0, status: "waiting" },
			{ at: "stage_rehydrated", live: 1, status: "completed" },
			{ at: "settled", live: 1, status: "completed" },
		]);
		assert.equal(recordedWait, undefined);
		assert.equal(seen.userPrompts.get("implement"), 2);
	});
});
