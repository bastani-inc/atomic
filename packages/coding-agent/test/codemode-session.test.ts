import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { createCodemodeExtension } from "../src/extensions/codemode/index.js";
import {
	CODEMODE_DOCS_PATH,
	type CodemodeToolDetails,
	createCodemodeDescription,
} from "../src/extensions/codemode/tool.js";
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

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test("codemode read returns text and image blocks accepted by image() (#10251)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode", "read"],
	});
	let savedPath: string | undefined;
	try {
		writeFileSync(join(harness.tempDir, "notes.txt"), "hello");
		writeFileSync(join(harness.tempDir, "pixel.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		const result = await runScript(
			harness,
			'text(await tools.read({ path: "notes.txt:raw" })); const shot = await tools.read({ path: "pixel.png" }); text(shot.note); image(shot);',
		);
		assert.equal(result.isError, false);
		assert.deepEqual(result.content[1], { type: "text", text: "hello" });
		assert.deepEqual(result.content[2], { type: "text", text: "Read image file [image/png]" });
		assert.ok(result.content[3].type === "text");
		savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(result.content[3].text)?.[1];
		assert.ok(savedPath);
		assert.deepEqual(result.content.at(-1), { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	} finally {
		if (savedPath) rmSync(savedPath, { force: true });
		await harness.cleanup();
	}
});

test("codemode saves duplicate images once and labels each image in output order (#3429)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	let path: string | undefined;
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `text("before"); image("data:image/png;base64,${TINY_PNG_BASE64}"); image("data:image/png;base64,${TINY_PNG_BASE64}"); text("after");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("emit images");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		const items = result.content.slice(1);
		assert.deepEqual(
			items.map((item) => item.type),
			["text", "text", "image", "text", "image", "text"],
		);
		assert.deepEqual(items[0], { type: "text", text: "before" });
		assert.deepEqual(items[5], { type: "text", text: "after" });
		assert.ok(items[1].type === "text");
		path = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(items[1].text)?.[1];
		assert.ok(path);
		assert.deepEqual(items[3], items[1]);
		assert.equal(readFileSync(path).toString("base64"), TINY_PNG_BASE64);
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		if (path) rmSync(path, { force: true });
		await harness.cleanup();
	}
});

test("image save failures keep successful script output and images (#3429)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, `${harness.tempDir}/missing-output-dir`);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `text("kept verbatim"); image("data:image/png;base64,${TINY_PNG_BASE64}");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("save image with unwritable temp directory");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		assert.deepEqual(result.content[1], { type: "text", text: "kept verbatim" });
		assert.ok(result.content[2].type === "text");
		assert.match(result.content[2].text, /^\[Image \(image\/png, \d+B\) could not be saved: /);
		assert.deepEqual(result.content[3], { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	} finally {
		vi.unstubAllEnvs();
		await harness.cleanup();
	}
});

test("truncation keeps saved image labels next to images and outside the text budget (#3429)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	const paths: string[] = [];
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `// @options: {"max_output_tokens": 10}\ntext("x".repeat(200)); image("data:image/png;base64,${TINY_PNG_BASE64}");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("truncate image output");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		assert.deepEqual(result.content.at(-1), { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		const label = result.content.at(-2);
		assert.ok(label?.type === "text");
		const imagePath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(label.text)?.[1];
		assert.ok(imagePath);
		paths.push(imagePath);
		assert.equal(readFileSync(imagePath).toString("base64"), TINY_PNG_BASE64);
		const outputPath = (result.details as CodemodeToolDetails).fullOutputPath;
		assert.ok(outputPath);
		paths.push(outputPath);
		assert.equal(readFileSync(outputPath, "utf8"), "x".repeat(200));
		if (process.platform !== "win32") assert.equal(statSync(outputPath).mode & 0o777, 0o600);
	} finally {
		for (const path of paths) rmSync(path, { force: true });
		await harness.cleanup();
	}
});

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function createModelsHarness() {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	const requests: Array<{ baseUrl: string; apiKey: string | undefined; input: unknown }> = [];
	const painter = {
		type: "image" as const,
		id: "painter",
		name: "Painter",
		api: "test-images",
		provider: "scorer",
		baseUrl: "https://images.test/v1",
		input: ["text", "image"] as ("text" | "image")[],
		output: ["text", "image"] as ("text" | "image")[],
		cost: ZERO_COST,
	};
	const judge = {
		type: "classifier" as const,
		id: "judge",
		name: "Judge",
		api: "test-classifier",
		provider: "scorer",
		baseUrl: "https://classify.test/v1",
		input: ["text"] as "text"[],
		contextWindow: 8000,
		cost: ZERO_COST,
	};
	harness.session.modelRuntime.registerProvider("scorer", {
		apiKey: "secret-key",
		models: [painter, judge],
		images: {
			"test-images": {
				generateImages: async (model, context, options) => {
					requests.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, input: context.input });
					const prompt = context.input.find((block) => block.type === "text")?.text;
					const base = { api: model.api, provider: model.provider, model: model.id, timestamp: 0 };
					if (prompt === "explode") {
						return { ...base, output: [], stopReason: "error", errorMessage: "painter exploded" };
					}
					const input = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 };
					return {
						...base,
						output: [
							{ type: "text", text: `painted ${prompt}` },
							{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
						],
						usage: { ...input, cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
						stopReason: "stop",
					};
				},
			},
		},
		classifiers: {
			"test-classifier": {
				classify: async (model) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: {},
					stopReason: "error",
					errorMessage: "classifier exploded",
					timestamp: 0,
				}),
			},
		},
	});
	return { harness, requests };
}

async function runScript(harness: Awaited<ReturnType<typeof createModelsHarness>>["harness"], code: string) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("run script");
	const result = harness.session.messages.find((message) => message.role === "toolResult");
	assert(result?.role === "toolResult");
	return result;
}

test("codemode generates images with catalog credentials and attaches them through image()", async () => {
	const { harness, requests } = await createModelsHarness();
	try {
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const reference = { type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png" };
				const generated = await models.generateImages(
					{ ...model, baseUrl: "https://evil.test" },
					{ input: [{ type: "text", text: "a fox" }, reference] },
				);
				for (const block of generated.output) {
					if (block.type === "image") image(block);
					else text(block.text);
				}
				const failed = await models.generateImages(model, { input: [{ type: "text", text: "explode" }] });
				const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
				return {
					id: model.id,
					stopReason: generated.stopReason,
					failed: [failed.stopReason, failed.errorMessage],
					wrongType: await attempt(() => models.generateImages({ provider: "scorer", id: "judge" }, { input: [] })),
				};
			`,
		);

		assert.equal(result.isError, false);
		const output = getMessageText(result);
		assert.match(output, /painted a fox/);
		assert.match(output, /"stopReason":"stop"/);
		assert.match(output, /"failed":\["error","painter exploded"\]/);
		assert.match(
			output,
			/"scorer\/judge\\" is a classifier model, not an image model\. List the image models you can use with models\.getAvailableOfType\(\\"image\\"\)\./,
		);
		assert.deepEqual(
			result.content.filter((block) => block.type === "image"),
			[{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		);
		const label = result.content[2];
		assert.ok(label.type === "text");
		const savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(label.text)?.[1];
		assert.ok(savedPath);
		try {
			assert.equal(readFileSync(savedPath).toString("base64"), TINY_PNG_BASE64);
		} finally {
			rmSync(savedPath, { force: true });
		}
		assert.deepEqual(result.content[3], { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		assert.deepEqual(
			requests.map((request) => [request.baseUrl, request.apiKey]),
			[
				["https://images.test/v1", "secret-key"],
				["https://images.test/v1", "secret-key"],
			],
		);
		assert.deepEqual(requests[0]?.input, [
			{ type: "text", text: "a fox" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		]);
		assert.deepEqual(
			(result.details as CodemodeToolDetails).calls.map((call) => [
				call.name,
				call.args,
				call.status,
				call.cost,
				call.error,
			]),
			[
				["models.generateImages", "scorer/painter", "ok", 0.04, undefined],
				["models.generateImages", "scorer/painter", "error", undefined, "painter exploded"],
			],
		);
		assert.ok(Math.abs((result.usage?.cost.total ?? 0) - 0.04) < 1e-10);
		assert.ok(Math.abs(harness.session.getSessionStats().cost - 0.04) < 1e-10);
	} finally {
		await harness.cleanup();
	}
});

test("codemode notes generated images that the script did not show", async () => {
	const { harness } = await createModelsHarness();
	try {
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const generated = await models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });
				return generated.stopReason;
			`,
		);

		assert.equal(result.isError, false);
		assert.match(
			getMessageText(result),
			/stop\nNote: models\.generateImages\(\) returned 1 image that the script did not show\. Show each image block of result\.output with image\(block\)\./,
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode model calls fail with the expected argument shape and a way back", async () => {
	const { harness } = await createModelsHarness();
	try {
		const questions = '{ ok: { type: "bool", instructions: "Fine?", criteria: { true: "yes", false: "no" } } }';
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("classifier", "scorer");
				const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
				return {
					unknown: await attempt(() => models.classify({ provider: "scorer", id: "nope" }, {})),
					noModel: await attempt(() => models.classify("judge", {})),
					undefinedModel: await attempt(() => models.classify(undefined, {})),
					noState: await attempt(() => models.classify(model, { questions: ${questions} })),
					badQuestion: await attempt(() =>
						models.classify(model, { state: {}, questions: { kind: { type: "choice", instructions: "Kind?", criteria: ["a", "b"] } } }),
					),
					badImage: await attempt(() => models.generateImages({ provider: "scorer", id: "painter" }, { prompt: "a fox" })),
					badSplit: await attempt(() => models.getModelOfType("classifier", "scorer/judge")),
				};
			`,
		);

		assert.equal(result.isError, false);
		const value = JSON.parse(getMessageText(result).split("Output:\n")[1] ?? "{}") as Record<string, string>;
		assert.equal(
			value.unknown,
			'Unknown classifier model "scorer/nope". List the classifier models you can use with models.getAvailableOfType("classifier").',
		);
		assert.match(
			value.noModel ?? "",
			/^models\.classify\(\) expects a classifier model as its first argument, got a string\./,
		);
		assert.match(
			value.undefinedModel ?? "",
			/models\.getModelOfType\(\) returns undefined for an unknown provider or id\./,
		);
		assert.match(value.noState ?? "", /models\.classify\(\) context\.state must be an object, got undefined\./);
		assert(value.noState?.includes(CODEMODE_DOCS_PATH));
		assert(
			value.badQuestion?.includes(
				'context.questions.kind is a "choice" question, so criteria must map each label to its meaning.',
			),
		);
		assert.match(
			value.badImage ?? "",
			/models\.generateImages\(\) context\.input must be a non-empty array of blocks, got undefined\./,
		);
		assert(value.badSplit?.includes("The provider and the id are separate arguments"));
	} finally {
		await harness.cleanup();
	}
});

test("codemode description points to the models reference only when models are enabled", () => {
	const withModels = createCodemodeDescription([], { models: true });

	assert(withModels.includes("`models`"));
	assert(withModels.includes(CODEMODE_DOCS_PATH));
	assert(CODEMODE_DOCS_PATH.endsWith("codemode.md"));
	assert(!withModels.includes("models.classify("));
	assert(!createCodemodeDescription([], {}).includes("`models`"));
});

test("codemode tells declared tools how scripts call them instead of repeating their declaration", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "echo",
					label: "Echo",
					description: "Echo a value",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.registerTool({
					name: "stats",
					label: "Stats",
					description: "Report counts",
					parameters: Type.Object({}),
					outputSchema: Type.Object({ count: Type.Number(), label: Type.Optional(Type.String()) }),
					execute: async () => ({
						content: [{ type: "text", text: "{}" }],
						structuredContent: { count: 1 },
						details: {},
					}),
				});
			},
		],
		initialActiveToolNames: ["echo", "stats", "codemode"],
	});
	try {
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description;

		assert.equal(description("echo"), "Echo a value\n\nCodemode: `tools.echo(args)` resolves to a string.");
		assert.equal(
			description("stats"),
			"Report counts\n\nCodemode: `tools.stats(args)` resolves to `{ count, label? }`.",
		);
	} finally {
		await harness.cleanup();
	}
});
