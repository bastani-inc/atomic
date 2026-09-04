import assert from "node:assert/strict";
import feedback, { FEEDBACK_COMMAND_DESCRIPTION } from "@bastani/feedback";
import { Check } from "typebox/value";
import { test } from "vitest";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
import type { ExtensionAPI, RegisteredCommand, ToolDefinition } from "../../packages/coding-agent/src/index.js";

test("feedback extension registration matches its bundled command advertisement", async () => {
	let registeredDescription: string | undefined;
	let submissionTool: ToolDefinition | undefined;
	let toolResultEvent: string | undefined;
	let toolResultHandler: ((event: { toolName: string; details?: unknown }) => unknown) | undefined;
	const toolNames: string[] = [];
	const api = {
		on: ((event: string, handler: typeof toolResultHandler) => {
			toolResultEvent = event;
			toolResultHandler = handler;
		}) as ExtensionAPI["on"],
		registerCommand: ((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			if (name === "feedback") registeredDescription = options.description;
		}) as ExtensionAPI["registerCommand"],
		registerTool: ((tool: ToolDefinition) => {
			toolNames.push(tool.name);
			if (tool.name === "feedback_submit_issue") submissionTool = tool;
		}) as ExtensionAPI["registerTool"],
	} as Pick<ExtensionAPI, "on" | "registerCommand" | "registerTool"> as ExtensionAPI;

	feedback(api);

	const advertised = BUNDLED_EXTENSION_SLASH_COMMANDS.find(({ name }) => name === "feedback");
	assert.equal(registeredDescription, FEEDBACK_COMMAND_DESCRIPTION);
	assert.equal(registeredDescription, advertised?.description);
	assert.equal(toolResultEvent, "tool_result");
	assert.ok(toolResultHandler);
	assert.deepEqual(toolResultHandler({ toolName: "feedback_submit_issue", details: { ok: false } }), {
		isError: true,
	});
	assert.equal(
		toolResultHandler({ toolName: "feedback_submit_issue", details: { ok: true, url: "url", fingerprint: "id" } }),
		undefined,
	);
	assert.equal(toolResultHandler({ toolName: "feedback_prepare_issue", details: { ok: false } }), undefined);
	assert.deepEqual(toolNames, ["feedback_collect_diagnostics", "feedback_prepare_issue", "feedback_submit_issue"]);
	assert.ok(submissionTool);
	const exact = { kind: "bug", title: "Reviewed", body: "Reviewed body" };
	assert.equal(Check(submissionTool.parameters, exact), true);
	for (const extra of ["repository", "token", "rawContext"])
		assert.equal(Check(submissionTool.parameters, { ...exact, [extra]: "must not pass" }), false, extra);
	const result = await submissionTool.execute("id", exact, undefined, undefined, {
		sessionManager: { getBranch: () => [] },
	} as unknown as Parameters<ToolDefinition["execute"]>[4]);
	const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
	assert.match(resultText, /does not match the most recent prepared draft/u);
	assert.doesNotMatch(resultText, /github\.com/u);
});
