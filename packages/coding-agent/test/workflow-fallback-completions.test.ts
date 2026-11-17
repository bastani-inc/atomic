import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@bastani/atomic-tui";
import { test } from "vitest";
import { BUILTIN_SLASH_COMMANDS, BUNDLED_EXTENSION_SLASH_COMMANDS } from "../src/core/slash-commands.js";

const provider = new CombinedAutocompleteProvider(
	[...BUILTIN_SLASH_COMMANDS, ...BUNDLED_EXTENSION_SLASH_COMMANDS],
	process.cwd(),
);

async function suggest(line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

test("bundled slash commands offer only /workflows and /workflow-authoring for workflows (#5224)", async () => {
	const workflowBundled = BUNDLED_EXTENSION_SLASH_COMMANDS.filter((command) => command.name.startsWith("workflow"));
	assert.deepEqual(workflowBundled, [
		{ name: "workflows", description: "Browse running and completed workflows" },
		{ name: "workflow-authoring", description: "Load the reference for writing workflow definitions" },
	]);
	assert.equal(
		BUILTIN_SLASH_COMMANDS.some((command) => command.name.startsWith("workflow")),
		false,
	);

	const suggestions = await suggest("/workflow");
	assert.ok(suggestions);
	assert.deepEqual(
		suggestions.items
			.filter((item) => item.value.startsWith("workflow"))
			.map((item) => ({ value: item.value, description: item.description })),
		[
			{ value: "workflows", description: "Browse running and completed workflows" },
			{ value: "workflow-authoring", description: "Load the reference for writing workflow definitions" },
		],
	);
	assert.equal(
		suggestions.items.some((item) => item.value === "workflow"),
		false,
	);
});

test("bundled fallback completes /workflows and /workflow-authoring and never completes /workflow subcommands (#5224)", async () => {
	const line = "/workfl";
	const suggestions = await suggest(line);
	assert.ok(suggestions);
	const workflows = suggestions.items.find((item) => item.value === "workflows");
	const authoring = suggestions.items.find((item) => item.value === "workflow-authoring");
	assert.ok(workflows);
	assert.ok(authoring);
	assert.equal(workflows.description, "Browse running and completed workflows");
	assert.equal(authoring.description, "Load the reference for writing workflow definitions");
	assert.deepEqual(provider.applyCompletion([line], 0, line.length, workflows, suggestions.prefix), {
		lines: ["/workflows "],
		cursorLine: 0,
		cursorCol: "/workflows ".length,
	});
	assert.deepEqual(provider.applyCompletion([line], 0, line.length, authoring, suggestions.prefix), {
		lines: ["/workflow-authoring "],
		cursorLine: 0,
		cursorCol: "/workflow-authoring ".length,
	});

	for (const removedLine of [
		"/workflow ",
		"/workflow list",
		"/workflow status",
		"/workflow pause",
		"/workflow quit",
		"/workflow resume",
		"/workflow fork",
		"/workflow inputs",
		"/workflow reload",
		"/workflows ",
		"/workflow-authoring ",
	]) {
		assert.equal(await suggest(removedLine), null, removedLine);
	}
});
