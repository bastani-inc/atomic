import { describe } from "vitest";
import {
	assert,
	createStageControlRegistry,
	createStore,
	deferred,
	mockSession,
	run,
	type StageSessionRuntime,
	sleep,
	test,
	workflow,
} from "./executor-shared.js";

/**
 * #3996: a pooled worker records a stage's session id in its store as soon as the session's
 * creation starts. A user message sent to the stage before that creation finishes must join
 * the live generation, not treat the stage as an archived transcript to reopen and close.
 */
describe("stage user message during session startup", () => {
	test("a message sent while the stage's recorded session is still starting leaves its generation open (#3996)", async () => {
		const registry = createStageControlRegistry();
		const store = createStore();
		const creation = deferred<void>();
		const createStarted = deferred<{ runId: string; stageId: string }>();
		let generationClosed = false;
		const closedWhilePrompting: boolean[] = [];
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionId: "pooled-stage-session",
			async prompt(text: string) {
				if (text === "go") closedWhilePrompting.push(generationClosed);
			},
			async closeWorkflowStageGeneration() {
				generationClosed = true;
			},
		};
		const def = workflow({
			name: "message-during-startup-wf",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("work").prompt("go");
				return {};
			},
		});
		const runPromise = run(
			def,
			{},
			{
				adapters: {
					agentSession: {
						async create(_options, meta) {
							assert.ok(meta, "stage identity");
							// As the pool worker's adapter does: the id is recorded before the session exists.
							store.recordStageSession(meta.runId, meta.stageId, { sessionId: session.sessionId });
							createStarted.resolve({ runId: meta.runId, stageId: meta.stageId });
							await creation.promise;
							return session;
						},
					},
				},
				store,
				stageControlRegistry: registry,
			},
		);
		const { runId, stageId } = await createStarted.promise;
		const handle = registry.get(runId, stageId);
		assert.ok(handle, "stage handle should be registered");
		const sent = handle.sendUserMessage?.("/workflow attach some-run work-0", { deliverAs: "steer" });
		await sleep(5);
		creation.resolve();
		await sent;
		const result = await runPromise;

		assert.equal(result.status, "completed");
		assert.deepEqual(closedWhilePrompting, [false], "the stage prompt ran with its generation open");
	});
});
