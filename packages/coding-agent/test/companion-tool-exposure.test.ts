import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { registerContactSupervisorTool } from "../../intercom/contact-supervisor-tool.js";
import subagents from "../../subagents/src/extension/index.js";
import { registerWorkflowTool } from "../../workflows/src/extension/workflow-tool-registration.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createHarness } from "./suite/harness.js";

test("script tool catalogs retain ordinary tools but exclude Atomic orchestration and human prompts", async () => {
	let catalog: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			subagents,
			(pi) => {
				registerContactSupervisorTool(pi, {
					childOrchestratorMetadata: () => null,
					ensureConnected: async () => {
						throw new Error("Supervisor transport must not be reached");
					},
					syncPresenceIdentity: () => {},
					resolveSessionTarget: async () => null,
					beginReplyWait: () => {
						throw new Error("Supervisor wait must not be reached");
					},
				});
				registerWorkflowTool(
					{ registerTool: (tool) => pi.registerTool(tool as ToolDefinition) },
					async () => {
						throw new Error("Workflow execution must not be reached");
					},
					(_policy, run) => run(),
				);
				pi.registerTool({
					name: "catalog_probe",
					label: "Catalog probe",
					description: "Inspect callable tools",
					concurrency: "exclusive",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						catalog = ctx.tools.map((tool) => tool.name);
						return { content: [{ type: "text", text: "catalog captured" }], details: {} };
					},
				});
			},
		],
	});
	try {
		const orchestrators = ["subagent", "workflow", "contact_supervisor", "ask_user_question"];
		for (const name of orchestrators)
			assert(harness.session.getActiveToolNames().includes(name), `${name} remains model-active`);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("catalog_probe", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect catalog");
		assert(catalog.includes("read"));
		assert(catalog.includes("bash"));
		for (const name of orchestrators) assert(!catalog.includes(name), `${name} must not be script-callable`);
	} finally {
		await harness.cleanup();
	}
});
