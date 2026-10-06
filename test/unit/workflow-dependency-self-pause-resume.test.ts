import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { currentStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => setDurableBackend(undefined));

for (const legacySnapshot of [false, true]) {
	test(`public same-session resume replays completed checkpoints after dependency self-pause${legacySnapshot ? " with stale metadata" : ""} (#3466)`, async () => {
		const sdk = createMockSdk();
		let offline = false;
		const backend = new DbosDurableBackend({
			...sdk,
			async recordStepOutput(id, step, output) {
				if (offline) throw new DbosDependencyError();
				await sdk.recordStepOutput(id, step, output);
			},
		});
		setDurableBackend(backend);
		const store = createStore();
		const jobs = createJobTracker();
		const toolControls = createToolControlRegistry();
		const stageControls = createStageControlRegistry();
		const release = Promise.withResolvers<void>();
		let receipts = 0;
		let bodies = 0;
		const definition = workflow({
			name: "dependency-self-pause",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodies++;
				await ctx.tool("receipt", {}, async () => ++receipts);
				await ctx.tool("interrupted", {}, async () => {
					if (bodies === 1) offline = true;
					return "done";
				});
				await ctx.tool("finish", {}, async () => {
					await release.promise;
					return "done";
				});
				return {};
			},
		});
		const id = testRunId(`dependency-self-pause-${legacySnapshot}`);
		const initial = await run(
			definition,
			{},
			{
				runId: id,
				store,
				durableBackend: backend,
				toolControlRegistry: toolControls,
				stageControlRegistry: stageControls,
			},
		);
		assert.equal(initial.status, "paused");
		assert.equal(backend.isCheckpointUnavailable(id), true);
		assert.ok((backend.getWorkflow(id)?.completedCheckpoints ?? 0) > 0);
		assert.equal(toolControls.runControl(id), undefined);
		if (legacySnapshot) {
			const { exitReason: _exitReason, ...stale } = store.runs()[0]!;
			store.recordRunStart(stale);
		}
		offline = false;
		const runtime = createExtensionRuntime({
			definitions: [definition],
			store,
			jobs,
			toolControlRegistry: toolControls,
			stageControlRegistry: stageControls,
		});
		const errors: string[] = [];
		const info: string[] = [];
		try {
			await handleRunControlCommand(
				"resume",
				[id],
				{ hasUI: false, ui: { notify: () => undefined } },
				{ info: (message) => info.push(message), error: (message) => errors.push(message) },
				{
					pi: {},
					overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
					runtimeForContext: () => runtime,
					ensureWorkflowResourcesLoaded: () => undefined,
					owner: {
						store,
						jobs,
						toolControlRegistry: toolControls,
						stageControlRegistry: stageControls,
						stageUiBroker: currentStageUiBroker(),
					},
				},
			);
			assert.deepEqual(errors, []);
			assert.match(info.join("\n"), /Resuming durable workflow/);
			const resumed = jobs.get(id);
			assert.ok(resumed, "resume must retain the original durable identity");
			const duplicate = await runtime.resumeDurableWorkflow(id);
			assert.equal(duplicate.ok, false, "a genuinely live owner still rejects duplicate resume");
			assert.equal(jobs.get(id), resumed);
			release.resolve();
			await resumed.promise;
			assert.equal(store.runs()[0]?.status, "completed");
			assert.equal(receipts, 1, "the committed receipt must not be executed again");
			assert.equal(bodies, 2);
			assert.equal(store.runs().length, 1);
			assert.deepEqual([...sdk.state.workflows.keys()], [id]);
		} finally {
			release.resolve();
			await jobs.get(id)?.promise;
		}
	});
}
