import assert from "node:assert/strict";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { test } from "vitest";
import { resolveHomeGroup } from "../../packages/intercom/group.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

test("the embedded session adapter keeps the workflow invocation group", async () => {
	const optionsSeen: CreateAgentSessionOptions[] = [];
	const definition = workflow({
		name: "embedded-invocation-group",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("embedded-stage", { prompt: "run" });
			return {};
		},
	});
	const adapters = buildRuntimeAdapters(
		{},
		{
			async createAgentSession(options) {
				optionsSeen.push(options ?? {});
				return { session: mockSession() };
			},
		},
	);

	const result = await run(definition, {}, { store: createStore(), adapters });

	assert.equal(result.status, "completed");
	assert.equal(optionsSeen.length, 1);
	const group = optionsSeen[0]?.orchestrationContext?.intercomGroup;
	assert.ok(group);
	assert.notEqual(group, "default");
	const savedGroup = process.env.ATOMIC_INTERCOM_GROUP;
	process.env.ATOMIC_INTERCOM_GROUP = "environment-group";
	try {
		assert.equal(resolveHomeGroup({ group: "config-group" }, optionsSeen[0]), group);
	} finally {
		if (savedGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
		else process.env.ATOMIC_INTERCOM_GROUP = savedGroup;
	}
});
