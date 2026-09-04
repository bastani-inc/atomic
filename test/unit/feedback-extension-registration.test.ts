import assert from "node:assert/strict";
import feedback, { FEEDBACK_COMMAND_DESCRIPTION } from "@bastani/feedback";
import { test } from "vitest";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
import type { ExtensionAPI, RegisteredCommand, ToolDefinition } from "../../packages/coding-agent/src/index.js";

test("feedback extension registration matches its bundled command advertisement", () => {
	let registeredDescription: string | undefined;
	const toolNames: string[] = [];
	const api = {
		registerCommand: ((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			if (name === "feedback") registeredDescription = options.description;
		}) as ExtensionAPI["registerCommand"],
		registerTool: ((tool: ToolDefinition) => {
			toolNames.push(tool.name);
		}) as ExtensionAPI["registerTool"],
	} as Pick<ExtensionAPI, "registerCommand" | "registerTool"> as ExtensionAPI;

	feedback(api);

	const advertised = BUNDLED_EXTENSION_SLASH_COMMANDS.find(({ name }) => name === "feedback");
	assert.equal(registeredDescription, FEEDBACK_COMMAND_DESCRIPTION);
	assert.equal(registeredDescription, advertised?.description);
	assert.deepEqual(toolNames, ["feedback_collect_diagnostics", "feedback_prepare_issue"]);
});
