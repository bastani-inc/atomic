import { test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { setCallbackActivityReporter, type CallbackActivity } from "../../packages/coding-agent/src/core/callback-activity.ts";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.ts";
import { run } from "../../packages/workflows/src/engine/run.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";

test.serial("real workflow author, ctx.tool, and stage adapter callbacks report activity", async () => {
	const started: CallbackActivity[] = [];
	setCallbackActivityReporter({ started: (activity) => started.push(activity), finished: () => {} });
	try {
		const definition = workflow({
			name: "activity-fixture",
			description: "",
			inputs: {},
			outputs: { value: Type.String() },
			run: async (ctx) => {
				const value = await ctx.tool("author-tool", {}, async () => "tool-value");
				await ctx.stage("adapter-stage").complete("complete-value");
				return { value };
			},
		});
		const result = await run(definition, {}, {
			runId: "activity-run",
			store: createStore(),
			durableBackend: new InMemoryDurableBackend(),
			adapters: { complete: { complete: async (text) => text } },
			onStageStart: () => {},
			onStageEnd: () => {},
		});
		assert.equal(result.status, "completed");
		assert.ok(started.some((activity) => activity.kind === "workflow.run" && activity.name === "activity-fixture" && activity.runId === "activity-run"));
		assert.ok(started.some((activity) => activity.kind === "workflow.ctx_tool" && activity.name === "author-tool" && activity.runId === "activity-run"));
		assert.ok(started.some((activity) => activity.kind === "workflow.stage_adapter" && activity.name === "complete:adapter-stage" && activity.stageId));
		assert.ok(started.some((activity) => activity.name === "onStageStart:adapter-stage"));
		assert.ok(started.some((activity) => activity.name === "onStageEnd:adapter-stage"));
	} finally {
		setCallbackActivityReporter(undefined);
	}
});
