import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { registerContactSupervisorTool } from "../../intercom/contact-supervisor-tool.js";
import subagents from "../../subagents/src/extension/index.js";

import { createHarness } from "./suite/harness.js";

test("script tool catalogs include subagent but exclude workflow, supervisor and human prompts", async () => {
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
		const directOnly = ["contact_supervisor", "ask_user_question"];
		for (const name of ["subagent", ...directOnly])
			assert(harness.session.getActiveToolNames().includes(name), `${name} remains model-active`);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("catalog_probe", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect catalog");
		assert(catalog.includes("read"));
		assert(catalog.includes("bash"));
		assert(catalog.includes("subagent"));
		for (const name of directOnly) assert(!catalog.includes(name), `${name} must not be script-callable`);
	} finally {
		await harness.cleanup();
	}
});
