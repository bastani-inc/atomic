import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const backend = await createMemoryTestBackend();
let replay = false;
const prompts: string[] = [];
const answers: string[] = [];
const definition = workflow({
	name: "cached-stage-ui",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const cached = ctx.stage("cached");
		if (!replay) await cached.complete("saved");
		else {
			answers.push(await ctx.ui.input("one"));
			answers.push(await ctx.ui.input("two"));
		}
		return {};
	},
});
const options = {
	runId: "cached-stage-ui",
	durableBackend: backend,
	adapters: { complete: { complete: async (text: string) => text } },
	ui: {
		input: async (prompt: string) => { prompts.push(prompt); return prompt; },
		confirm: async () => false,
		select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
		editor: async () => "",
		custom: async () => assert.fail("custom UI is not used by this workflow"),
	},
};
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
// Module graph is loaded and the backend exists: the parent starts its scenario deadline here.
console.log("cached-stage-ui-ready");
try {
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, commitOptions) => {
		if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
			entered.resolve();
			await release.promise;
		}
		await commit(checkpoint, commitOptions);
	};
	replay = true;
	const completion = run(definition, {}, { ...options, store: createStore() });
	await entered.promise;
	await setImmediate();
	assert.deepEqual(prompts, []);
	release.resolve();
	const result = await completion;
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.deepEqual(prompts, ["one", "two"]);
	assert.deepEqual(answers, prompts);
	assert.equal(backend.listCheckpoints(options.runId).filter((entry) => entry.kind === "ui").length, 2);
	assert.equal(backend.listCheckpoints(options.runId).filter((entry) => entry.checkpointId.startsWith("stage-replay-meta:")).length, 1);
	console.log("cached-stage-ui-drained");
} finally {
	release.resolve();
	await backend.close();
}
