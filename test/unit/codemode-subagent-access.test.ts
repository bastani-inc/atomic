import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";

async function runScript(h: Harness, code: string) {
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	]);
	await h.session.prompt("Run the script");
	const message = h.session.messages.findLast((item) => item.role === "toolResult");
	assert(message?.role === "toolResult" && !message.isError, getMessageText(message));
	return JSON.parse(getMessageText(message).split("\n").at(-1)!);
}

test("unavailable actions and definition mutations never reach subagent permission hooks", async () => {
	const permitted: string[] = [];
	const h = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			registerSubagentExtension,
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "subagent") permitted.push(String(event.input.action));
				});
			},
		],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const messages: string[] = await runScript(
			h,
			`return await Promise.all(['create','update','delete'].map(action=>tools.subagent({action}).then(()=>null,e=>e.message)))`,
		);
		for (const error of messages) assert.match(error, /call the subagent tool directly/i);
		assert.deepEqual(permitted, []);
		h.session.setActiveToolsByName(["codemode"]);
		assert.equal(await runScript(h, `return 'subagent' in tools`), false);
	} finally {
		await h.cleanup();
	}
});

test("a subagent child's script cannot launch or control another child", async () => {
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
		subagentPolicy: {
			depth: 1,
			managementActions: "restricted",
			fanoutAuthorized: true,
			inheritProjectContext: false,
			inheritSkills: false,
		},
	});
	try {
		const messages: string[] = await runScript(
			h,
			`return await Promise.all([{agent:'worker',task:'nested'},{action:'quit',all:true}].map(args=>tools.subagent(args).then(()=>null,e=>e.message)))`,
		);
		for (const error of messages) assert.match(error, /delegation is not available inside a subagent/i);
	} finally {
		await h.cleanup();
	}
});

test("script discovery returns executable definitions while direct calls keep their model-facing output", async () => {
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const definition = await runScript(
			h,
			`const { agents } = await tools.subagent({action:'list'});
			const worker = agents.find(a => a.name === 'worker'); const { definitions } = await tools.subagent({action:'get',agent:worker.name});
			return [worker.executable, worker.scope, definitions[0].name, typeof definitions[0].systemPrompt];`,
		);
		assert.deepEqual(definition, [true, "builtin", "worker", "string"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { action: "list" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await h.session.prompt("List agents directly");
		const result = h.session.messages.findLast((m) => m.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError);
		assert.match(getMessageText(result), /^Executable agents:/);
		assert.deepEqual(result.details, { mode: "management", results: [] });
	} finally {
		await h.cleanup();
	}
});

test("a script can select a configured model without credentials or provider internals", async () => {
	const h = await createHarness({
		extensionFactories: [createCodemodeExtension(), registerSubagentExtension],
		initialActiveToolNames: ["codemode", "subagent"],
	});
	try {
		const catalog = await runScript(h, 'return await tools.subagent({ action: "models" })');
		const current = h.getModel();
		assert.equal(catalog.action, "models");
		assert.deepEqual(
			catalog.models.find((m: { isCurrent: boolean }) => m.isCurrent),
			{
				provider: current.provider,
				id: current.id,
				fullId: `${current.provider}/${current.id}`,
				isCurrent: true,
				availableThinkingLevels: ["off"],
			},
		);
	} finally {
		await h.cleanup();
	}
});
