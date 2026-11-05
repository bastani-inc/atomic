import { afterEach, describe, vi } from "vitest";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	isStageReleasedError,
	type StageReleasedError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

/** The stage's `releaseWhenWaiting` threshold in this run. */
const AFTER_MS = 50;
/** Fake time is advanced in steps this long, so the run's idle scan runs close to when it is due. */
const STEP_MS = 10;
/** The most fake time the run is given: its prompt, the threshold and the scan's busy rechecks, many times over. */
const FAKE_TIME_LIMIT_MS = 5_000;
/** Structural cost: the run is driven through its prompt and the idle scan in fake time, a step per loop. */
const FAKE_TIME_RUN_TIMEOUT_MS = 60_000;
const MODEL = { provider: "faux", id: "faux-model" };

/** The base adapters' sessions, each with the faux model, `high` thinking and an agent numbered by its creation. */
function withModel(base: StageAdapters): StageAdapters {
	const agentSession = base.agentSession!;
	let created = 0;
	return {
		...base,
		agentSession: {
			async create(options, meta) {
				const session = (await agentSession.create(options, meta)) as StageSessionRuntime;
				created += 1;
				return Object.assign(session, {
					model: MODEL as never,
					thinkingLevel: "high",
					agent: { session: created },
				});
			},
		},
	};
}

/** The `StageReleasedError` a read throws; fails when it throws nothing or something else. */
function releasedReadOf(read: () => object): StageReleasedError {
	try {
		read();
	} catch (error) {
		assert.ok(isStageReleasedError(error), String(error));
		return error;
	}
	return assert.fail("the read did not throw");
}

function contents(messages: readonly object[]): string[] {
	return messages.map((message) => (message as { readonly content: string }).content);
}

describe("a stage the run's idle scan released, read by its workflow (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test(
		"agent and messages throw, model and thinkingLevel stay, readMessages() reads the store, and rehydrate() makes every read work again (#4309)",
		async () => {
			vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
			const seen = counters();
			const released = Promise.withResolvers<void>();
			let whileReleased:
				| {
						readonly messages: StageReleasedError;
						readonly agent: StageReleasedError;
						readonly model: object | undefined;
						readonly thinkingLevel: string | undefined;
						readonly isStreaming: boolean;
						readonly sessionId: string;
						readonly stored: string[];
						readonly live: number;
				  }
				| undefined;
			let afterRehydrate:
				| { readonly messages: string[]; readonly agent: object; readonly created: number }
				| undefined;
			const definition = workflow({
				name: "idle-released-reads",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const alpha = ctx.stage("alpha");
					await alpha.prompt("plan");
					await released.promise;
					whileReleased = {
						messages: releasedReadOf(() => alpha.messages),
						agent: releasedReadOf(() => alpha.agent),
						model: alpha.model,
						thinkingLevel: alpha.thinkingLevel,
						isStreaming: alpha.isStreaming,
						sessionId: alpha.sessionId,
						stored: contents(await alpha.readMessages()),
						live: seen.created - seen.disposed,
					};
					await alpha.rehydrate();
					afterRehydrate = { messages: contents(alpha.messages), agent: alpha.agent, created: seen.created };
					return {};
				},
			});

			const running = run(
				definition,
				{},
				{
					store: createStore(),
					adapters: withModel(detachingAdapters(new FakeCiService(), seen, { detach: false, resumable: true })),
					releaseWhenWaiting: { afterMs: AFTER_MS },
					onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
						if (event.type === "stage_waiting" && event.wait.kind === "idle") released.resolve();
					},
				},
			);
			let finished = false;
			void running.finally(() => {
				finished = true;
			});
			for (let elapsed = 0; elapsed < FAKE_TIME_LIMIT_MS && !finished; elapsed += STEP_MS)
				await vi.advanceTimersByTimeAsync(STEP_MS);
			const result = await running;

			assert.equal(result.status, "completed", result.error);
			assert.ok(whileReleased !== undefined);
			for (const property of ["messages", "agent"] as const) {
				const error: StageReleasedError = whileReleased[property];
				assert.equal(error.code, "stage-released", property);
				assert.equal(error.fields.property, property);
				assert.equal(error.fields.waitKind, "idle");
				assert.equal(error.fields.stageName, "alpha");
				assert.equal(error.fields.sessionId, whileReleased.sessionId);
				assert.equal(error.fields.stageId, result.stages[0]?.id);
				assert.match(error.hint, /await stage\.rehydrate\(\)/);
				assert.match(error.hint, /await stage\.readMessages\(\)/);
			}
			assert.equal(whileReleased.model, MODEL);
			assert.equal(whileReleased.thinkingLevel, "high");
			assert.equal(whileReleased.isStreaming, false);
			assert.deepEqual(whileReleased.stored, ["plan"]);
			assert.equal(whileReleased.live, 0, "reading the transcript reopened no session");
			assert.deepEqual(afterRehydrate, { messages: ["plan"], agent: { session: 2 }, created: 2 });
		},
		FAKE_TIME_RUN_TIMEOUT_MS,
	);
});
