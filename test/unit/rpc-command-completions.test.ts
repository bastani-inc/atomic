import { test } from "bun:test";
import assert from "node:assert/strict";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

function createHarness() {
	const seenPrefixes: string[] = [];
	const command = {
		name: "workflow",
		invocationName: "workflow",
		description: "Workflow command",
		sourceInfo: { path: "/fixture/workflow.ts", source: "extension" as const },
		handler: async () => {},
		getArgumentCompletions: async (prefix: string) => {
			seenPrefixes.push(prefix);
			return [
				{ value: "my-custom ", label: "my-custom", description: "Run workflow: my-custom" },
				{ value: "my-custom ", label: "my-custom alias" },
			];
		},
	};
	const session = Object.create(AgentSession.prototype, {
		extensionRunner: { value: { getRegisteredCommands: () => [command] } },
		promptTemplates: { value: [] },
		resourceLoader: { value: { getSkills: () => ({ skills: [] }) } },
	}) as AgentSession;
	const runtimeHost = Object.create(AgentSessionRuntime.prototype, {
		services: { value: { agentDir: "/fixture" } },
	}) as AgentSessionRuntime;
	return {
		seenPrefixes,
		handle: createRpcCommandHandler({
			runtimeHost,
			getSession: () => session,
			rebindSession: async () => {},
			output: () => {},
		}),
	};
}

test("RPC command catalog advertises and evaluates live extension argument completions", async () => {
	const { handle, seenPrefixes } = createHarness();
	const catalog = await handle({ id: "catalog", type: "get_commands" });
	assert.equal(catalog?.success, true);
	assert.deepEqual("data" in catalog! ? catalog.data : undefined, {
		commands: [{
			name: "workflow",
			description: "Workflow command",
			source: "extension",
			sourceInfo: { path: "/fixture/workflow.ts", source: "extension" },
			hasArgumentCompletions: true,
		}],
	});

	const response = await handle({
		id: "completion",
		type: "get_command_completions",
		commandName: "workflow",
		argumentPrefix: "inputs my-",
	});
	assert.equal(response?.success, true);
	assert.deepEqual("data" in response! ? response.data : undefined, {
		completions: [
			{ value: "my-custom ", label: "my-custom", description: "Run workflow: my-custom" },
			{ value: "my-custom ", label: "my-custom alias" },
		],
	});
	assert.deepEqual(seenPrefixes, ["inputs my-"]);
});

test("RPC command completion is permissive for missing providers", async () => {
	const { handle } = createHarness();
	const response = await handle({
		id: "missing",
		type: "get_command_completions",
		commandName: "not-registered",
		argumentPrefix: "verbatim prefix ",
	});
	assert.equal(response?.success, true);
	assert.deepEqual("data" in response! ? response.data : undefined, { completions: null });
});
