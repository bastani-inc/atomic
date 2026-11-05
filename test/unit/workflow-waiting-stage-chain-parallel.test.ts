import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import type { ReleaseWhenWaiting } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	isStageWaitConfigError,
	type StageWaitConfigError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import type { WorkflowTaskStep } from "../../packages/workflows/src/shared/types.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { type Counters, counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

type Primitive = "chain" | "parallel";

/** The fake adapters, recording the detachment policy each stage's session receives, by stage name. */
function policyRecordingAdapters(
	seen: Counters,
	policies: Map<string, { readonly afterMs: number } | undefined>,
): StageAdapters {
	const adapters = detachingAdapters(new FakeCiService(), seen, { detach: false });
	const agentSession = adapters.agentSession!;
	return {
		...adapters,
		agentSession: {
			...agentSession,
			async create(options, meta) {
				const created = await agentSession.create(options, meta);
				const session: StageSessionRuntime = "session" in created ? created.session : created;
				const stageName = meta?.stageName ?? "stage";
				return {
					...session,
					setToolDetachment(policy: { readonly afterMs: number } | undefined) {
						policies.set(stageName, policy);
						session.setToolDetachment?.(policy);
					},
				};
			},
		},
	};
}

/** Run one `ctx.chain` or `ctx.parallel` call and return what it threw, with the counted model and session work. */
async function refusedSteps(
	primitive: Primitive,
	steps: readonly WorkflowTaskStep[],
	shared: { readonly releaseWhenWaiting?: ReleaseWhenWaiting } = {},
): Promise<{ readonly error: unknown; readonly seen: Counters }> {
	const seen = counters();
	const service = new FakeCiService();
	let error: unknown;
	const definition = workflow({
		name: `waiting-stage-${primitive}-validation`,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			try {
				await ctx[primitive](steps, shared);
			} catch (caught) {
				error = caught;
			}
			return {};
		},
	});
	await run(definition, {}, { store: createStore(), adapters: detachingAdapters(service, seen) });
	assert.equal(service.dispatches, 0);
	return { error, seen };
}

function assertRefusedBeforeAnyModelCall(
	outcome: { readonly error: unknown; readonly seen: Counters },
	expected: { readonly stageName?: string; readonly value: string },
): void {
	assert.ok(isStageWaitConfigError(outcome.error), String(outcome.error));
	const error = outcome.error as StageWaitConfigError;
	assert.equal(error.code, "invalid-release-when-waiting");
	assert.equal(error.fields.field, "releaseWhenWaiting.afterMs");
	assert.equal(error.fields.value, expected.value);
	assert.equal(error.fields.stageName, expected.stageName);
	assert.equal(outcome.seen.created, 0, "no stage session was created");
	assert.equal(
		[...outcome.seen.userPrompts.values()].reduce((sum, count) => sum + count, 0),
		0,
		"no model call",
	);
}

for (const primitive of ["chain", "parallel"] as const) {
	test(`ctx.${primitive} refuses an invalid releaseWhenWaiting on a later step before any step prompts a model (#4309)`, async () => {
		const outcome = await refusedSteps(primitive, [
			{ name: "plan", prompt: "plan it" },
			{ name: "implement", prompt: "build it", releaseWhenWaiting: { afterMs: 2_147_483_648 } },
			{ name: "review", prompt: "review it" },
		]);

		assertRefusedBeforeAnyModelCall(outcome, { stageName: "implement", value: "2147483648" });
	});

	test(`ctx.${primitive} refuses an invalid shared releaseWhenWaiting, naming the first step that would use it (#4309)`, async () => {
		const outcome = await refusedSteps(
			primitive,
			[
				{ name: "plan", prompt: "plan it", releaseWhenWaiting: false },
				{ name: "implement", prompt: "build it" },
			],
			{ releaseWhenWaiting: { afterMs: -1 } },
		);

		assertRefusedBeforeAnyModelCall(outcome, { stageName: "implement", value: "-1" });
	});

	test(`ctx.${primitive} refuses an invalid shared releaseWhenWaiting even when every step sets its own (#4309)`, async () => {
		const outcome = await refusedSteps(
			primitive,
			[{ name: "plan", prompt: "plan it", releaseWhenWaiting: { afterMs: 5 } }],
			{ releaseWhenWaiting: { afterMs: Number.NaN } },
		);

		assertRefusedBeforeAnyModelCall(outcome, { value: "NaN" });
	});

	test(`a valid releaseWhenWaiting on a ctx.${primitive} step reaches that stage's session, and the shared one the others (#4309)`, async () => {
		const seen = counters();
		const policies = new Map<string, { readonly afterMs: number } | undefined>();
		const definition = workflow({
			name: `waiting-stage-${primitive}-policy`,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx[primitive](
					[
						{ name: "own", prompt: "own threshold", releaseWhenWaiting: { afterMs: 1_234 } },
						{ name: "resident", prompt: "stays resident", releaseWhenWaiting: false },
						{ name: "shared", prompt: "shared threshold" },
						{ name: "longest", prompt: "longest threshold", releaseWhenWaiting: { afterMs: 2_147_483_647 } },
					],
					{ releaseWhenWaiting: { afterMs: 777 } },
				);
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ store: createStore(), adapters: policyRecordingAdapters(seen, policies), releaseWhenWaiting: false },
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			Object.fromEntries([...policies].sort(([a], [b]) => a.localeCompare(b))),
			{ longest: { afterMs: 2_147_483_647 }, own: { afterMs: 1_234 }, shared: { afterMs: 777 } },
			"a stage that stays resident gets no detachment policy",
		);
		assert.equal(seen.created, 4);
	});
}
