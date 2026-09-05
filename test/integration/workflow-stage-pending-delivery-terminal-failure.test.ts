/**
 * Integration: a workflow stage whose queued Intercom instructions can no
 * longer be delivered must reach a deterministic terminal outcome.
 *
 * Before the fix, the Intercom wrapper wrote one console diagnostic when its
 * bounded warm-up retries ran out and nothing settled the delivery, so the
 * stage stayed `running` forever on the untimed
 * `await pendingStageDelivery.ready()` in `stage-runner-controller`.
 *
 * The reason handed to `fail()` here is the exact chain production builds —
 * `IntercomWarmUpExhaustedError` ← `IntercomClientDisconnectedError` ← the raw
 * `ECONNRESET` transport error — because a bare `Error` cannot catch the second
 * defect: chaining that reason as `cause` let the shared model-failure
 * classifier's cause walk read `code: "ECONNRESET"` and call a dead delivery a
 * retryable `network_timeout`, spending a same-model retry and every fallback
 * candidate on a stage that could never receive its instructions. The stage is
 * therefore given a real model plus a fallback and real retry settings, so both
 * decision sites are reachable, and the test asserts exactly one session
 * creation, exactly one recorded model attempt, and no `[fallback]` warning.
 */

import { getDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { StageExecutionMeta } from "../../packages/workflows/src/shared/types.js";
import {
	assert,
	createStore,
	mockSession,
	run,
	type StageSessionRuntime,
	test,
	workflow,
} from "../unit/executor-shared.js";

const { IntercomClientDisconnectedError } = await import("../../packages/intercom/recoverable-disconnect.js");
const { IntercomWarmUpExhaustedError } = await import("../../packages/intercom/warm-up-exhaustion.js");

const QUEUED_MESSAGE_ID = "steering-1";
const WARM_UP_EXHAUSTED = "Intercom could not reach the broker after 5 warm-up attempts.";
const PRIMARY_MODEL = "anthropic/primary";
const FALLBACK_MODEL = "openai/fallback";

/** The exact reason chain `packages/intercom/index.ts` hands to `fail()` in production. */
function productionWarmUpExhaustedReason(): Error {
	const transport = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
	return new IntercomWarmUpExhaustedError(5, { cause: new IntercomClientDisconnectedError({ cause: transport }) });
}

test("a stage whose pending Intercom delivery fails terminally becomes a failed stage", async () => {
	const store = createStore();
	let prompted = 0;
	const creates: string[] = [];
	const definition = workflow({
		name: "pending-stage-terminal-failure",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx
				.stage("reviewer", {
					tools: ["intercom"],
					model: PRIMARY_MODEL,
					fallbackModels: [FALLBACK_MODEL],
				})
				.prompt("review the change");
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create(options, meta?: StageExecutionMeta) {
						creates.push(
							typeof options.model === "string"
								? options.model
								: `${String(options.model?.provider)}/${String(options.model?.id)}`,
						);
						const delivery = options.orchestrationContext?.pendingStageDelivery;
						assert.ok(delivery, "the stage must expose the production pending delivery");
						assert.ok(meta);
						const runId = meta.runId;
						const group = `workflow:${runId}`;
						// Queue the steering this stage was supposed to receive, then model
						// the Intercom wrapper running out of bounded warm-up retries.
						const queued = await store.queueStageMessage(
							{
								runId,
								stageKey: "reviewer",
								from: { id: "planner-session", name: "planner", group },
								message: {
									id: QUEUED_MESSAGE_ID,
									timestamp: 1_725_000_000_000,
									content: { text: "Scope amendment the reviewer must read first." },
								},
								queuedAt: "2026-09-04T00:00:00.000Z",
							},
							group,
							group,
							getDurableBackend(),
						);
						assert.equal(queued?.ok, true, "the steering is queued");
						delivery.fail(productionWarmUpExhaustedReason());
						// `stage-runner-controller` only gates on `ready()` when the created
						// session is recognized as a real AgentSession (`asAgentSession`) and
						// carries the stage's orchestration context, so the mock supplies the
						// same shape production does. Real retry settings make the same-model
						// retry site reachable, so the guard there is actually exercised.
						const session: StageSessionRuntime = {
							...mockSession(),
							async prompt() {
								prompted += 1;
							},
							state: {},
							sessionManager: {},
							modelRuntime: {},
							settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: 1 }) },
							getContextUsage: () => ({}),
							orchestrationContext: options.orchestrationContext,
						} as StageSessionRuntime;
						return session;
					},
				},
			},
		},
	);

	assert.equal(prompted, 0, "the stage never runs without the instructions it was refused");
	assert.deepEqual(creates, [PRIMARY_MODEL], "no same-model retry and no fallback candidate is spent");
	assert.equal(result.status, "failed");
	const stage = result.stages.find((candidate) => candidate.name === "reviewer");
	assert.ok(stage);
	assert.equal(stage.status, "failed", "the stage reaches a terminal outcome instead of staying parked");
	assert.equal(stage.failureDisposition, "terminal_failed");
	assert.equal(stage.failureKind, "unknown");
	assert.equal(stage.modelAttempts?.length ?? 0, 1, "exactly the one attempt that was actually spent");
	assert.equal(stage.modelAttempts?.[0]?.success, false);
	assert.equal(stage.warnings, undefined, "no [fallback] warning blames a model for a delivery failure");
	assert.match(String(stage.error), /stage "reviewer"/);
	assert.ok(String(stage.error).includes(WARM_UP_EXHAUSTED));

	const queued = store.pendingStageMessagesFor(result.runId, "reviewer");
	assert.equal(queued.length, 1, "the steering is not dropped");
	assert.equal(queued[0]?.id, QUEUED_MESSAGE_ID);
	assert.equal(queued[0]?.status, "queued");
});
