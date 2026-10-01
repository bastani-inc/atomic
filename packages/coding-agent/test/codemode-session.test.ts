import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { createCodemodeExtension } from "../src/extensions/codemode/index.js";
import { createHarness, getMessageText } from "./suite/harness.js";

test("codemode executes nested tools in a worker and persists successful branch-local store writes", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "echo",
					label: "Echo",
					description: "Echo",
					exposure: "codemode",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'store("note", await tools.echo({value: "hello"})); return load("note");',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run script");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert.match(getMessageText(result), /Script completed/);
		assert.match(getMessageText(result), /hello/);
		assert.equal(result?.role === "toolResult" && result.nestedCalls?.calls[0].name, "echo");
		assert(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode respects content redaction instead of leaking stale structured results", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "secret",
					label: "Secret",
					description: "fixture",
					exposure: "codemode",
					parameters: Type.Object({}),
					outputSchema: Type.Object({ token: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "private-token" }],
						structuredContent: { token: "private-token" },
						details: {},
					}),
				});
				pi.on("tool_result", (event) =>
					event.toolName === "secret" ? { content: [{ type: "text", text: "redacted" }] } : undefined,
				);
			},
		],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.secret({});" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read redacted data");
		const output = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		assert.match(output, /redacted/);
		assert(!output.includes("private-token"));
	} finally {
		await harness.cleanup();
	}
});

test("codemode model catalog omits headers and credential-bearing provider URLs", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		const registry = harness.session.extensionRunner.createContext().modelRegistry;
		const model = registry.find(harness.getModel().provider, harness.getModel().id);
		assert(model);
		model.headers = { Authorization: "private-catalog-token" };
		model.baseUrl = "https://private-catalog-token@example.invalid/?key=private-catalog-token";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `return await models.getModelOfType("chat", ${JSON.stringify(model.provider)}, ${JSON.stringify(model.id)});`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect public catalog");
		const output = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		assert.match(output, /Script completed/);
		assert(output.includes(model.id));
		assert(!output.includes("private-catalog-token"));
		assert(!output.includes("baseUrl"));
		assert(!output.includes("headers"));
	} finally {
		await harness.cleanup();
	}
});

test("codemode timeout discards store writes and releases the worker for later scripts", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: '// @options: {"timeout_ms": 50}\nstore("bad", "uncommitted"); while (true) {}',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("stopped"),
		]);
		await harness.session.prompt("run bounded script");
		const failed = harness.session.messages.find((message) => message.role === "toolResult");
		assert(failed?.role === "toolResult" && failed.isError);
		assert.match(getMessageText(failed), /Script failed/);
		assert(
			!harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: 'return load("bad") === undefined ? "clean" : "leaked";' })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run another script");
		const later = harness.session.messages.findLast((message) => message.role === "toolResult");
		assert.match(getMessageText(later), /Script completed/);
		assert.match(getMessageText(later), /clean/);
	} finally {
		await harness.cleanup();
	}
});

test("codemode filters full nested output while direct calls retain the model-facing cap", async () => {
	const large = `${"x".repeat(70_000)}tail`;
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "large",
					label: "Large",
					description: "fixture",
					parameters: Type.Object({}),
					maxResultSizeChars: 1000,
					execute: async () => ({ content: [{ type: "text", text: large }], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["codemode", "large"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return (await tools.large({})).slice(-4);" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("large", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("filter large output then call directly");
		const script = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "codemode",
		);
		assert.match(getMessageText(script), /Output:\n\ntail$/);
		const direct = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "large",
		);
		assert(getMessageText(direct).length < large.length);
		assert.notEqual(getMessageText(direct), large);
	} finally {
		await harness.cleanup();
	}
});

test("codemode only hides direct declarations and prompt snippets without disabling nested access (#10192)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension({ mode: "only" }),
			(pi) => {
				pi.registerTool({
					name: "echo",
					label: "Echo",
					description: "Echo",
					promptSnippet: "Echo a value",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["codemode", "echo"],
	});
	try {
		harness.setResponses([
			(context) => {
				const names = getCurrentTools(context.messages).map((tool) => tool.name);
				assert(names.includes("codemode"));
				assert(!names.includes("echo"));
				const prompt = getCurrentSystemPrompt(context.messages);
				assert(!prompt.includes("\n- echo: "));
				assert(prompt.includes("\n- codemode: "));
				return fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.echo({});" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call through script only");
		assert(!harness.session.systemPrompt.includes("\n- echo: "));
		assert(harness.session.getActiveToolNames().includes("echo"));
		assert(harness.session.getCallableToolNames().includes("echo"));
		assert(getCurrentTools(harness.session.messages).some((tool) => tool.name === "echo"));
		assert.match(
			getMessageText(harness.session.messages.find((message) => message.role === "toolResult")),
			/Script completed/,
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode describes namespace instructions on request without listing them inline (#10212)", async () => {
	const namespace = {
		name: "docs",
		description: "Product docs",
		instructions: "Search before reading private guidance",
	};
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "docs-search",
					label: "Search",
					description: "Search docs",
					exposure: "codemode",
					namespace,
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'return { docs: await describeNamespace("docs"), missing: await describeNamespace("missing"), hits: await searchTools("private guidance") };',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect namespace");
		const description = harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description ?? "";
		assert(!description.includes(namespace.instructions));
		assert(description.includes("## docs"));
		assert(!description.includes("(1 tools)"));
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError);
		const output = JSON.parse(getMessageText(result).split("\n").at(-1) ?? "");
		assert.deepEqual(output.docs, { ...namespace, tools: ["docs_search"] });
		assert.equal(output.missing, undefined);
		assert.equal(output.hits[0].name, "docs_search");
	} finally {
		await harness.cleanup();
	}
});

test("codemode rejects corrupt image outputs before they enter later provider turns (#10215)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		for (const data of ["%%%", "a", "aGVsbG8="]) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code: `image("data:image/png;base64,${data}")` })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("emit image");
			const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
			assert.ok(result?.role === "toolResult");
			assert.equal(result.isError, true);
			assert.equal(
				result.content.some((block) => block.type === "image"),
				false,
			);
			assert.match(getMessageText(result), /invalid image output|unsupported image type/);
		}
	} finally {
		await harness.cleanup();
	}
});

test("codemode detects the image MIME type instead of trusting the supplied type (#10215)", async () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=";
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: `image("data:image/jpeg;base64,${png}")` })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("emit image");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		assert.deepEqual(
			result.content.filter((block) => block.type === "image"),
			[{ type: "image", data: png, mimeType: "image/png" }],
		);
	} finally {
		await harness.cleanup();
	}
});
