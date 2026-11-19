// @ts-nocheck
import { describe, test } from "vitest";
import type { RegisteredCommand } from "./slash-dispatch-utils.js";
import {
	assert,
	buildMockPi,
	installSlashDispatchTestHooks,
	makeInflightRun,
	runFactory,
	store,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("factory command registration (real factory)", () => {
	async function runFactoryWithMock(): Promise<RegisteredCommand[]> {
		const { pi, commands } = buildMockPi();
		await runFactory(pi);
		return commands;
	}

	test.sequential("per-workflow slash aliases and /workflow are not registered (#5224)", async () => {
		const commands = await runFactoryWithMock();
		const names = commands.map((c) => c.name);
		assert.equal(
			names.some((name) => name.startsWith("workflow:")),
			false,
		);
		assert.equal(names.includes("workflow"), false);
		assert.deepEqual(
			names.filter((name) => name.startsWith("workflow")),
			["workflows", "workflow-authoring"],
		);
	});

	test.sequential("registers /workflows and /workflow-authoring with their descriptions (#5224)", async () => {
		const commands = await runFactoryWithMock();
		const workflowsCommand = commands.find((command) => command.name === "workflows");
		const authoringCommand = commands.find((command) => command.name === "workflow-authoring");
		assert.notEqual(workflowsCommand, undefined);
		assert.notEqual(authoringCommand, undefined);
		assert.equal(workflowsCommand!.options.description, "Browse running and completed workflows");
		assert.equal(authoringCommand!.options.description, "Load the reference for writing workflow definitions");
	});

	test.sequential("/workflows argument completions offer only top-level session run IDs (#5224)", async () => {
		const runId = "a1b2c3d4-0000-4000-8000-000000000001";
		store.recordRunStart(makeInflightRun(runId));
		const commands = await runFactoryWithMock();
		const workflowsCmd = commands.find((c) => c.name === "workflows");
		assert.notEqual(workflowsCmd, undefined);

		const completions = (await workflowsCmd!.options.getArgumentCompletions?.("a1b2")) ?? [];
		assert.deepEqual(completions, [
			{
				value: `${runId} `,
				label: runId,
				description: "test-wf — running",
			},
		]);
		assert.equal(await workflowsCmd!.options.getArgumentCompletions?.(`${runId} `), null);
	});
});
