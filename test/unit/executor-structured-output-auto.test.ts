import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, type CreateAgentSessionOptions, createStore, mockSession } from "./executor-shared.js";
import { FINAL_TEXT, InferenceRig, proseTurn, userTurn } from "./structured-output-auto-fixture.js";

afterEach(() => {
	setDurableBackend(undefined);
});

const SCHEMA = Type.Object({ approved: Type.Boolean(), summary: Type.String() }, { additionalProperties: false });
const VERDICT = { approved: true, summary: FINAL_TEXT };

function reviewWorkflow() {
	return workflow({
		name: "auto-structured-output",
		description: "",
		inputs: {},
		outputs: { approved: Type.Boolean() },
		run: async (ctx) => {
			const review = await ctx.task("review", {
				prompt: "review the change",
				schema: SCHEMA,
				model: "anthropic/primary",
			});
			return { approved: (review.structured as typeof VERDICT).approved };
		},
	});
}

function adaptersOver(inference: InferenceRig, sessions: string[]) {
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(options: CreateAgentSessionOptions) {
				sessions.push("created");
				const base = mockSession(options.sessionManager);
				return inference.attachTo({
					...base,
					async prompt(text: string) {
						userTurn(base.messages, text);
						proseTurn(base.messages, FINAL_TEXT);
					},
				});
			},
		},
	};
}

describe("executor — a stage the runtime finished with its own structured_output inference (#4565)", () => {
	test("records the inferred result as the stage's structured result, like a model's call (#4565)", async () => {
		const inference = new InferenceRig();
		const store = createStore();

		const execution = await run(reviewWorkflow(), {}, { store, adapters: adaptersOver(inference, []) });

		assert.equal(execution.status, "completed");
		assert.deepEqual(store.runs()[0]?.stages[0]?.structured, VERDICT);
		assert.deepEqual(store.runs()[0]?.result, { approved: true });
		assert.equal(inference.requests.length, 1);
	});

	test("a replayed run reuses the recorded result and never re-runs the completed inference (#4565)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const inference = new InferenceRig();
		const sessions: string[] = [];
		const adapters = adaptersOver(inference, sessions);
		const definition = reviewWorkflow();
		const first = await run(definition, {}, { store: createStore(), durableBackend: backend, adapters });
		assert.equal(first.status, "completed", first.error);
		assert.equal(inference.requests.length, 1);
		assert.equal(sessions.length, 1);

		const replayStore = createStore();
		const replayed = await run(
			definition,
			{},
			{ runId: first.runId, store: replayStore, durableBackend: backend, adapters },
		);

		assert.equal(replayed.status, "completed", replayed.error);
		assert.equal(inference.requests.length, 1, "the replay asks the decision model nothing");
		assert.equal(inference.contextRequests.length, 1);
		assert.equal(sessions.length, 1, "the replay opens no session");
		assert.deepEqual(replayStore.runs()[0]?.stages[0]?.structured, VERDICT);
		assert.deepEqual(replayStore.runs()[0]?.result, { approved: true });
	});
});
