import { describe } from "vitest";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

function stageNamed(stages: readonly StageSnapshot[] | undefined, name: string): StageSnapshot | undefined {
	return stages?.find((stage) => stage.name === name);
}

function finishCiOnWait(service: FakeCiService, events: StageLifecycleEvent[]) {
	return (_runId: string, event: StageLifecycleEvent): void => {
		events.push(event);
		if (event.type === "stage_waiting") setTimeout(() => service.finishAll(), 5);
	};
}

describe("a finished stage whose follow-up turn waits released on a detachable tool (#4309)", () => {
	test("ends completed, not running, once the run completes (#4309)", async () => {
		const service = new FakeCiService();
		const events: StageLifecycleEvent[] = [];
		const definition = workflow({
			name: "follow-up-tool-wait",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				await stage.prompt("watch ci");
				await stage.sendUserMessage("address the review");
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters: detachingAdapters(service, counters(), { resumable: true }),
				onStageLifecycleEvent: finishCiOnWait(service, events),
			},
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			events.map((event) => [event.type, event.wait.kind]),
			[
				["stage_waiting", "tool"],
				["stage_rehydrated", "tool"],
				["stage_waiting", "tool"],
				["stage_rehydrated", "tool"],
			],
		);
		assert.equal(stageNamed(result.stages, "implement")?.status, "completed");
	});

	test("a stage whose tool-wait reopen failed ends failed, not running, after a rehydrated follow-up turn waits again (#4309)", async () => {
		const service = new FakeCiService();
		const events: StageLifecycleEvent[] = [];
		let promptFailure: Error | undefined;
		const adapters = detachingAdapters(service, counters(), { resumable: true });
		const create = adapters.agentSession!.create.bind(adapters.agentSession);
		let creations = 0;
		adapters.agentSession!.create = (options, meta) => {
			creations += 1;
			if (creations === 2) return Promise.reject(new Error("No API key found for provider faux"));
			return create(options, meta);
		};
		const definition = workflow({
			name: "follow-up-after-failed-reopen",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const stage = ctx.stage("implement");
				try {
					await stage.prompt("watch ci");
				} catch (error) {
					promptFailure = error as Error;
				}
				await stage.rehydrate();
				await stage.sendUserMessage("try again");
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{
				store: createStore(),
				releaseWhenWaiting: { afterMs: 0 },
				adapters,
				onStageLifecycleEvent: finishCiOnWait(service, events),
			},
		);

		assert.ok(promptFailure !== undefined, "the first reopen should have failed the prompt");
		assert.equal(creations, 4);
		assert.equal(events.filter((event) => event.type === "stage_waiting").length, 2);
		const stage = stageNamed(result.stages, "implement");
		assert.equal(stage?.failureCode, "missing_api_key");
		assert.equal(stage?.status, "failed");
	});
});
