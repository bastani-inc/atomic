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
import { createMcpResultSchema } from "../src/extensions/mcp/tools.js";
import { createHarness, getMessageText } from "./suite/harness.js";

test("codemode joins adjacent output with linear separator checks (#10678)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	let separatorInputLength = 0;
	const endsWith = String.prototype.endsWith;
	const separatorSpy = vi.spyOn(String.prototype, "endsWith").mockImplementation(function (
		this: string,
		searchString: string,
		endPosition?: number,
	) {
		if (searchString === "\n") separatorInputLength += this.length;
		return endsWith.call(this, searchString, endPosition);
	});
	try {
		const result = await runScript(harness, 'for (let i = 0; i < 1000; i++) text("");');
		separatorSpy.mockRestore();
		const outputPath = (result.details as CodemodeToolDetails).fullOutputPath;
		const outputBytes = outputPath ? statSync(outputPath).size : Buffer.byteLength(getMessageText(result));
		if (outputPath) rmSync(outputPath, { force: true });
		assert.equal(result.isError, false);
		assert.match(getMessageText(result), /==> text 1000\/1000 <==/);
		assert(
			separatorInputLength <= outputBytes * 2,
			`Separator checks inspected ${separatorInputLength} characters for ${outputBytes} output bytes`,
		);
	} finally {
		separatorSpy.mockRestore();
		await harness.cleanup();
	}
});

test("codemode separates text items and groups console calls after other output", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		const result = await runScript(
			harness,
			'text("one\\ntwo"); console.log("a"); console.log("b"); text("three\\n"); return 4;',
		);
		assert.equal(result.isError, false);
		assert.equal(result.content.length, 2);
		assert.deepEqual(result.content[1], {
			type: "text",
			text: "==> text 1/3 <==\none\ntwo\n==> text 2/3 <==\nthree\n==> text 3/3 <==\n4\n<console_output>\na\nb\n</console_output>",
		});
	} finally {
		await harness.cleanup();
	}
});

test("codemode console prints NaN and Infinity like text() (earendil-works/pi#11901)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		const result = await runScript(harness, 'console.log("avg", 0 / 0, 1 / 0, -1 / 0, { a: 1 }); text(0 / 0);');
		assert.equal(result.isError, false);
		assert(
			getMessageText(result).endsWith(
				'NaN\n<console_output>\navg NaN Infinity -Infinity {"a":1}\n</console_output>',
			),
			getMessageText(result),
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode reports a thrown NaN as NaN (earendil-works/pi#11901)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		const result = await runScript(harness, "throw NaN");
		assert.match(getMessageText(result), /Script failed/);
		assert.match(getMessageText(result), /\bNaN\b/);
		assert.doesNotMatch(getMessageText(result), /\bnull\b/);
	} finally {
		await harness.cleanup();
	}
});

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

test("codemode only hides direct declarations, snippets and guidelines without disabling nested access (#10192, #10343)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension({ mode: "only" }),
			(pi) => {
				pi.registerTool({
					name: "echo",
					label: "Echo",
					description: "Echo",
					promptSnippet: "Echo a value",
					promptGuidelines: ["Use echo to repeat a value."],
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
				assert(!prompt.includes("Use echo to repeat a value."));
				assert(
					getCurrentTools(context.messages)
						.find((tool) => tool.name === "codemode")
						?.description.includes("- Use echo to repeat a value."),
				);
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

test("codemode exposes hidden tool guidelines through describeTool and ALL_TOOLS at zero inline budget (#10343)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension({ mode: "only", inlineBudget: 0 })],
		initialActiveToolNames: ["read", "codemode"],
	});
	try {
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		assert(!codemode?.description.includes("### `read`"));
		harness.setResponses([
			(context) => {
				assert(
					!getCurrentSystemPrompt(context.messages).includes("Use read to inspect file and resource contents"),
				);
				return fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: 'text(await describeTool("read")); text(ALL_TOOLS.find(tool => tool.name === "read"));',
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect hidden tool guidance");
		const output = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		assert.equal(output.match(/- Use read to inspect file and resource contents;/g)?.length, 2, output);
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
		assert.ok(result.content[1].type === "text");
		assert.match(
			result.content[1].text,
			/^==> text 1\/2 <==\nhello\n==> text 2\/2 <==\nRead image file \[image\/png\]\n/,
		);
		savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/m.exec(result.content[1].text)?.[1];
		assert.ok(savedPath);
		assert.deepEqual(result.content.at(-1), { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	} finally {
		if (savedPath) rmSync(savedPath, { force: true });
		await harness.cleanup();
	}
});

test("codemode read rejects when the file is too large to read (#3574)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode", "read"],
	});
	try {
		writeFileSync(join(harness.tempDir, "big.json"), JSON.stringify({ a: "x".repeat(93_000) }));
		const result = await runScript(
			harness,
			'try { await tools.read({ path: "big.json" }); return "read ok"; } catch (error) { return "read failed: " + error.message; }',
		);
		assert.match(getMessageText(result), /read failed: File read blocked/);
		const details = result.details as CodemodeToolDetails;
		assert.equal(details.calls[0]?.status, "error");
	} finally {
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
			["text", "image", "text", "image", "text"],
		);
		assert.ok(items[0].type === "text");
		assert.match(items[0].text, /^==> text 1\/2 <==\nbefore\n/);
		assert.deepEqual(items[4], { type: "text", text: "==> text 2/2 <==\nafter" });
		path = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/m.exec(items[0].text)?.[1];
		assert.ok(path);
		assert.deepEqual(items[2], { type: "text", text: items[0].text.split("\n").at(-1) });
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
		assert.ok(result.content[1].type === "text");
		assert.match(result.content[1].text, /^kept verbatim\n\[Image \(image\/png, \d+B\) could not be saved: /);
		assert.deepEqual(result.content[2], { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
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
		const imagePath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/m.exec(label.text)?.[1];
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
const SVG_XML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>';

async function createModelsHarness() {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	const requests: Array<{ baseUrl: string; apiKey: string | undefined; input: unknown; options: unknown }> = [];
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
					requests.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, input: context.input, options });
					const prompt = context.input.find((block) => block.type === "text")?.text;
					const base = { api: model.api, provider: model.provider, model: model.id, timestamp: 0 };
					if (prompt === "explode") {
						return { ...base, output: [], stopReason: "error", errorMessage: "painter exploded" };
					}
					if (prompt?.startsWith("vector")) {
						const svg = {
							type: "image" as const,
							data: Buffer.from(SVG_XML).toString("base64"),
							mimeType: "image/svg+xml",
						};
						const png = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
						return { ...base, output: prompt === "vector and raster" ? [svg, png] : [svg], stopReason: "stop" };
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
		const label = result.content[1];
		assert.ok(label.type === "text");
		const savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/m.exec(label.text)?.[1];
		assert.ok(savedPath);
		try {
			assert.equal(readFileSync(savedPath).toString("base64"), TINY_PNG_BASE64);
		} finally {
			rmSync(savedPath, { force: true });
		}
		assert.deepEqual(result.content[2], { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
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

test("codemode saves generated SVG images as .svg files and never asks the script to show them (#4332)", async () => {
	const { harness } = await createModelsHarness();
	const { harness: mixedHarness } = await createModelsHarness();
	const saved: string[] = [];
	try {
		const svgOnly = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const first = await models.generateImages(model, { input: [{ type: "text", text: "vector" }] });
				const again = await models.generateImages(model, { input: [{ type: "text", text: "vector" }] });
				return [first.output[0].mimeType, again.output.length];
			`,
		);
		const mixed = await runScript(
			mixedHarness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const result = await models.generateImages(model, { input: [{ type: "text", text: "vector and raster" }] });
				return result.output.map((block) => block.mimeType);
			`,
		);

		const svgOnlyText = getMessageText(svgOnly);
		const mixedText = getMessageText(mixed);
		const svgPaths = (text: string) =>
			[...text.matchAll(/^\[SVG saved to (\S+\.svg) \(image\/svg\+xml, \d+B\)\]$/gm)].map((match) => match[1] ?? "");
		saved.push(...svgPaths(svgOnlyText), ...svgPaths(mixedText));
		assert.equal(svgOnly.isError, false);
		assert.match(svgOnlyText, /\["image\/svg\+xml",1\]/);
		assert.equal(svgPaths(svgOnlyText).length, 1);
		assert.match(svgPaths(svgOnlyText)[0] ?? "", /[\\/]atomic-codemode-[^\\/]+\.svg$/);
		assert.equal(readFileSync(svgPaths(svgOnlyText)[0] ?? "", "utf8"), SVG_XML);
		assert.doesNotMatch(svgOnlyText, /did not show/);
		assert.deepEqual(
			svgOnly.content.filter((block) => block.type === "image"),
			[],
		);
		assert.equal(svgPaths(mixedText).length, 1);
		assert.match(
			mixedText,
			/Note: models\.generateImages\(\) returned 1 image that the script did not show\. Show each image block of result\.output with image\(block\)\./,
		);
	} finally {
		for (const path of saved) rmSync(path, { force: true });
		await harness.cleanup();
		await mixedHarness.cleanup();
	}
});

test("codemode reports an SVG it cannot save and keeps the script output (#4332)", async () => {
	const { harness } = await createModelsHarness();
	try {
		for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, `${harness.tempDir}/missing-output-dir`);
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const generated = await models.generateImages(model, { input: [{ type: "text", text: "vector" }] });
				return generated.stopReason;
			`,
		);

		assert.equal(result.isError, false);
		assert.match(getMessageText(result), /^stop\n\[SVG \(image\/svg\+xml, \d+B\) could not be saved: \S.*\]$/m);
	} finally {
		vi.unstubAllEnvs();
		await harness.cleanup();
	}
});

test("codemode forwards GPT Image request options and image roles without credentials (#4332)", async () => {
	const { harness, requests } = await createModelsHarness();
	try {
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("image", "scorer");
				const block = (role) => ({ type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png", ...(role ? { role } : {}) });
				const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
				const generated = await models.generateImages(
					model,
					{ input: [{ type: "text", text: "recolor" }, block(), block("markup")] },
					{ size: "1024x1024", quality: "low", n: 1, background: "opaque", outputFormat: "gif", outputCompression: undefined, frameCount: 3, frameDurationMs: 200, complexity: "low", svg: { model: "author" }, moderation: "low", safetyIdentifier: "hashed" },
				);
				const withoutOptions = await models.generateImages(model, { input: [{ type: "text", text: "plain" }] }, null);
				const maskOnly = await models.generateImages(model, { input: [{ type: "text", text: "mask it" }, block(), block("mask")] });
				const [judge] = await models.getAvailableOfType("classifier", "scorer");
				const classified = await attempt(() => models.classify(judge, { state: {}, questions: { ok: { type: "bool", instructions: "Fine?", criteria: { true: "yes", false: "no" } } } }, { apiKey: "ignored by classify" }));
				return {
					stopReason: generated.stopReason,
					withoutOptions: withoutOptions.stopReason,
					maskOnly: maskOnly.stopReason,
					classified,
					apiKey: await attempt(() => models.generateImages(model, { input: [{ type: "text", text: "x" }] }, { apiKey: "sk-script" })),
					headers: await attempt(() => models.generateImages(model, { input: [{ type: "text", text: "x" }] }, { size: "auto", headers: { a: "b" }, fetch: "evil" })),
					notAnObject: await attempt(() => models.generateImages(model, { input: [{ type: "text", text: "x" }] }, "low")),
					badRole: await attempt(() => models.generateImages(model, { input: [{ type: "text", text: "x" }, block("sticker")] })),
				};
			`,
		);

		assert.equal(result.isError, false);
		const value = JSON.parse(getMessageText(result).split("Output:\n")[1]?.split("\nNote:")[0] ?? "{}") as Record<
			string,
			string
		>;
		assert.equal(value.stopReason, "stop");
		assert.equal(value.withoutOptions, "stop");
		assert.equal(value.maskOnly, "stop");
		assert.equal(value.classified, "ok");
		assert.match(
			value.apiKey ?? "",
			/does not accept the option "apiKey"\. Allowed options: size, quality, n, background, outputFormat/,
		);
		assert.match(value.headers ?? "", /does not accept the option "headers", "fetch"\./);
		assert.match(value.notAnObject ?? "", /expects options as its third argument to be an object, got a string\./);
		assert.match(
			value.badRole ?? "",
			/context\.input\[1\]\.role must be "markup" or "mask" when set, got a string\./,
		);
		assert.equal(requests.length, 3);
		assert.deepEqual(requests[0]?.input, [
			{ type: "text", text: "recolor" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png", role: "markup" },
		]);
		const forwarded = requests[0]?.options as Record<string, unknown>;
		const { apiKey: _apiKey, signal: _signal, env: _env, headers, ...requestOptions } = forwarded;
		assert.deepEqual(requestOptions, {
			size: "1024x1024",
			quality: "low",
			n: 1,
			background: "opaque",
			outputFormat: "gif",
			frameCount: 3,
			frameDurationMs: 200,
			complexity: "low",
			svg: { model: "author" },
			moderation: "low",
			safetyIdentifier: "hashed",
		});
		assert.deepEqual(headers, {});
		assert.equal(forwarded.apiKey, "secret-key");
		assert(forwarded.signal instanceof AbortSignal);
		assert.equal((requests[1]?.options as { size?: string } | undefined)?.size, undefined);
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
					badClassifierImages: await attempt(() => models.classify(model, { state: {}, images: {}, questions: ${questions} })),
					badClassifierImage: await attempt(() => models.classify(model, { state: {}, images: [{ data: "aW1hZ2U=" }], questions: ${questions} })),
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
		assert.match(
			value.badClassifierImages ?? "",
			/models\.classify\(\) context\.images must be an array, got \{\}\./,
		);
		assert.match(
			value.badClassifierImage ?? "",
			/models\.classify\(\) context\.images\[0\] must be an image block, got \{ data \}\./,
		);
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

test("codemode returns a classifier error for images on text-only models", async () => {
	const { harness } = await createModelsHarness();
	try {
		const result = await runScript(
			harness,
			`
				const [model] = await models.getAvailableOfType("classifier", "scorer");
				const result = await models.classify(model, {
					state: { text: "good" },
					images: [{ type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png" }],
					questions: { ok: { type: "bool", instructions: "Fine?", criteria: { true: "yes", false: "no" } } },
				});
				return [result.stopReason, result.errorMessage];
			`,
		);

		assert.equal(result.isError, false);
		assert.deepEqual(JSON.parse(getMessageText(result).split("Output:\n")[1] ?? "[]"), [
			"error",
			"Model scorer/judge does not accept image input",
		]);
		assert.deepEqual(
			(result.details as CodemodeToolDetails).calls.map((call) => [call.name, call.status, call.error]),
			[["models.classify", "error", "Model scorer/judge does not accept image input"]],
		);
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

test("codemode description says tools with output schemas resolve with their value on failure", () => {
	const description = createCodemodeDescription([]);

	assert(
		description.includes(
			"Failed or blocked calls throw, except that a tool with an output schema resolves with its structuredContent on failure too when it returned one; check its fields.",
		),
	);
});

test("codemode resolves a failing tool that declares an output schema and throws for one that does not", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "plain",
					label: "Plain",
					description: "Fails with text only",
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error("plain failed");
					},
				});
				pi.registerTool({
					name: "shaped",
					label: "Shaped",
					description: "Fails with a structured value",
					exposure: "codemode",
					parameters: Type.Object({}),
					outputSchema: Type.Object({ exit_code: Type.Number() }),
					execute: async () => ({
						content: [{ type: "text", text: "exit 3" }],
						structuredContent: { exit_code: 3 },
						details: {},
						isError: true,
					}),
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
						code: 'const shaped = await tools.shaped({}); const plain = await tools.plain({}).then(() => "resolved", (error) => error.message); return { shaped, plain };',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run failing tools");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError, getMessageText(result));
		const output = JSON.parse(getMessageText(result).split("\n").at(-1) ?? "");
		assert.deepEqual(output.shaped, { exit_code: 3 });
		assert.match(output.plain, /plain failed/);
	} finally {
		await harness.cleanup();
	}
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

// Upstream #11501
test("codemode summarizes union and multi-line output types instead of inlining them", async () => {
	const outputTool = (name: string, outputSchema: ReturnType<typeof Type.Object> | ReturnType<typeof Type.Union>) => ({
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		outputSchema,
		execute: async () => ({ content: [], details: {} }),
	});
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool(
					outputTool(
						"process",
						Type.Union([
							Type.Object({
								action: Type.Literal("start"),
								process: Type.Object({ id: Type.String({ description: "Process id" }), pid: Type.Integer() }),
							}),
							Type.Object({
								action: Type.Literal("list"),
								processes: Type.Array(Type.Object({ id: Type.String() })),
								truncated: Type.Optional(Type.Boolean()),
							}),
						]),
					),
				);
				pi.registerTool(
					outputTool("entries", Type.Array(Type.Object({ id: Type.String(), size: Type.Integer() })) as never),
				);
				pi.registerTool(outputTool("count", Type.Number() as never));
			},
		],
		initialActiveToolNames: ["process", "entries", "count", "codemode"],
	});
	try {
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description;

		assert.equal(
			description("process"),
			'process tool\n\nCodemode: `tools.process(args)` resolves to `{ action: "start", process } | { action: "list", processes, truncated? }`.',
		);
		assert.equal(
			description("entries"),
			'entries tool\n\nCodemode: `tools.entries(args)` resolves to a value; `await describeTool("entries")` shows its type.',
		);
		assert.equal(description("count"), "count tool\n\nCodemode: `tools.count(args)` resolves to `number`.");
	} finally {
		await harness.cleanup();
	}
});

test("codemode tells scripts the fields of an MCP tool's structured content", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "mcp__docs__search",
					label: "Search",
					description: "Search docs",
					parameters: Type.Object({}),
					outputSchema: createMcpResultSchema({
						type: "object",
						properties: { hits: { type: "array", items: { type: "string" } } },
						required: ["hits"],
					}),
					execute: async () => ({ content: [], structuredContent: { content: [] }, details: {} }),
				});
				pi.registerTool({
					name: "mcp__docs__fail",
					label: "Fail",
					description: "Fail",
					parameters: Type.Object({}),
					outputSchema: createMcpResultSchema(undefined),
					execute: async () => ({ content: [], structuredContent: { content: [] }, details: {} }),
				});
			},
		],
		initialActiveToolNames: ["mcp__docs__search", "mcp__docs__fail", "codemode"],
	});
	try {
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description;

		assert.equal(
			description("mcp__docs__search"),
			"Search docs\n\nCodemode: `tools.mcp__docs__search(args)` resolves to `{ content, structuredContent?: { hits }, isError? }`.",
		);
		assert.equal(
			description("mcp__docs__fail"),
			"Fail\n\nCodemode: `tools.mcp__docs__fail(args)` resolves to `{ content, structuredContent?, isError? }`.",
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode summarizes output fields behind local schema references (earendil-works/pi#11803)", async () => {
	const outputTool = (name: string, outputSchema: Record<string, unknown>) => ({
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		outputSchema: Type.Unsafe(outputSchema),
		execute: async () => ({ content: [], details: {} }),
	});
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool(
					outputTool("report", {
						$ref: "#/$defs/Report",
						$defs: {
							Report: {
								type: "object",
								properties: { kind: { $ref: "#/$defs/Kind" }, summary: { $ref: "#/$defs/Summary" } },
								required: ["kind", "summary"],
							},
							Kind: { const: "ledger" },
							Summary: { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
						},
					}),
				);
				pi.registerTool(
					outputTool("result", {
						anyOf: [{ $ref: "#/$defs/Ok" }, { $ref: "#/$defs/Failed" }],
						$defs: {
							Ok: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
							Failed: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
						},
					}),
				);
				pi.registerTool({
					name: "mcp__ledger__search",
					label: "Search",
					description: "Search ledger",
					parameters: Type.Object({}),
					outputSchema: createMcpResultSchema({
						$ref: "#/$defs/Results",
						$defs: {
							Results: { type: "object", properties: { results: { type: "array" } }, required: ["results"] },
						},
					}),
					execute: async () => ({ content: [], structuredContent: { content: [] }, details: {} }),
				});
			},
		],
		initialActiveToolNames: ["report", "result", "mcp__ledger__search", "codemode"],
	});
	try {
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description;

		assert.equal(
			description("report"),
			'report tool\n\nCodemode: `tools.report(args)` resolves to `{ kind: "ledger", summary: { total } }`.',
		);
		assert.equal(
			description("result"),
			"result tool\n\nCodemode: `tools.result(args)` resolves to `{ value } | { error }`.",
		);
		// An MCP tool's own `$defs` move below `structuredContent` with the references that name them.
		assert.equal(
			description("mcp__ledger__search"),
			"Search ledger\n\nCodemode: `tools.mcp__ledger__search(args)` resolves to `{ content, structuredContent?: { results }, isError? }`.",
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode output summaries keep the keywords beside a local schema reference (#4415)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "start",
					label: "start",
					description: "start tool",
					parameters: Type.Object({}),
					outputSchema: Type.Unsafe({
						type: "object",
						properties: {
							action: { $ref: "#/$defs/Action", const: "start" },
							process: { $ref: "#/$defs/Process", properties: { pid: { type: "integer" } }, required: ["pid"] },
							owner: { $ref: "#/$defs/Owner", type: "object" },
						},
						required: ["action", "process", "owner"],
						$defs: {
							Action: { type: "string" },
							Process: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
							Owner: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
						},
					}),
					execute: async () => ({ content: [], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["start", "codemode"],
	});
	try {
		assert.equal(
			harness.session.agent.state.tools.find((tool) => tool.name === "start")?.description,
			'start tool\n\nCodemode: `tools.start(args)` resolves to `{ action: "start", process: { id, pid }, owner: { name } }`.',
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode declarations show input constraints the type cannot express (#10707)", () => {
	const description = createCodemodeDescription([
		{
			name: "wait",
			label: "Wait",
			description: "Wait",
			parameters: Type.Object({
				timeoutMs: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 30000, default: 0, description: "Wait in milliseconds." }),
				),
			}),
			execute: async () => ({ content: [], details: undefined }),
		},
	]);

	assert.match(description, /\/\/ Wait in milliseconds\.\n\s*\/\/ @integer @minimum 0 @maximum 30000 @default 0\n/);
});

test("codemode rejects a // @options: line that is not the first line before the script runs (#10631)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("codemode", { code: '// count\n// @options: {"timeout_ms": 200}\nstore("ran", true);' })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run script");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult");
		assert.equal(result.isError, true);
		assert.equal(
			getMessageText(result),
			"The // @options: line must be the first line of the input; found one on line 2",
		);
		assert(
			!harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
		);
	} finally {
		await harness.cleanup();
	}
});

test("codemode discovery names model-only tools instead of returning nothing (#3510)", async () => {
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool({
					name: "delegate-work",
					label: "Delegate",
					description: "Delegate work",
					exposure: "model-only",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		],
		initialActiveToolNames: ["read", "codemode", "delegate-work"],
	});
	try {
		const description = harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description ?? "";
		assert.match(description, /tools, ALL_TOOLS and searchTools\(\) matches cover only script-callable tools/);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'return { hits: await searchTools("delegate-work"), described: await describeTool("delegate_work"), listed: ALL_TOOLS.some(tool => tool.name === "delegate_work"), callable: "delegate_work" in tools, other: await searchTools("read") };',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("look for the delegate tool");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError, getMessageText(result));
		const output = JSON.parse(getMessageText(result).split("\n").at(-1) ?? "");
		const hint = "`delegate-work` is model-only: call it directly, not from a script.";
		assert.deepEqual(output.hits[0], { name: "delegate-work", description: hint });
		assert.equal(output.described, hint);
		assert.equal(output.listed, false);
		assert.equal(output.callable, false);
		assert(!output.other.some((hit: { name: string }) => hit.name === "delegate-work"));
	} finally {
		await harness.cleanup();
	}
});

test("codemode describeTool resolves equivalent MCP tool name forms and refuses ambiguous ones (#4065)", async () => {
	const register = (name: string) => ({
		name,
		label: name,
		description: `Tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	});
	const harness = await createHarness({
		extensionFactories: [
			createCodemodeExtension(),
			(pi) => {
				pi.registerTool(register("mcp__alteryx_local__alteryx_local__get_server_info"));
				pi.registerTool(register("mcp__alteryx_local__designer_local__get_server_info"));
				pi.registerTool(register("mcp__my_server__get_item_v2"));
			},
		],
		initialActiveToolNames: [
			"codemode",
			"mcp__alteryx_local__alteryx_local__get_server_info",
			"mcp__alteryx_local__designer_local__get_server_info",
			"mcp__my_server__get_item_v2",
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const forms = ["mcp.alteryx-local.alteryx_local.get_server_info", "mcp__alteryx-local__alteryx_local__get_server_info", "alteryx_local__get_server_info"];
							const described = [];
							for (const form of forms) described.push((await describeTool(form)).includes("Tool mcp__alteryx_local__alteryx_local__get_server_info"));
							let ambiguous = "";
							try { await describeTool("get_server_info"); } catch (error) { ambiguous = error.message; }
							const slashed = (await describeTool("mcp.my-server.get.item/v2")) ?? "";
							const searched = (await searchTools("mcp.my-server.get.item/v2", { limit: 1 })).map((hit) => hit.name);
							return { described, ambiguous, slashed: slashed.includes("Tool mcp__my_server__get_item_v2"), searched };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("describe the alteryx tool");
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError, getMessageText(result));
		const output = JSON.parse(getMessageText(result).split("\n").at(-1) ?? "");
		assert.deepEqual(output.described, [true, true, true]);
		assert.equal(output.slashed, true);
		assert.deepEqual(output.searched, ["mcp__my_server__get_item_v2"]);
		assert.match(output.ambiguous, /ambiguous/);
		assert.match(output.ambiguous, /mcp__alteryx_local__alteryx_local__get_server_info/);
		assert.match(output.ambiguous, /mcp__alteryx_local__designer_local__get_server_info/);
	} finally {
		await harness.cleanup();
	}
});

test("codemode reports a running update before the script's first nested call, so the row timer starts (pi#10708)", async () => {
	const harness = await createHarness({
		extensionFactories: [createCodemodeExtension()],
		initialActiveToolNames: ["codemode"],
	});
	try {
		const result = await runScript(harness, "return 1;");
		assert.equal(result.isError, false);
		const updates = harness.eventsOfType("tool_execution_update").filter((event) => event.toolName === "codemode");
		assert.deepEqual(
			updates.map((event) => (event.partialResult as { details: CodemodeToolDetails }).details),
			[{ calls: [] }],
		);
	} finally {
		await harness.cleanup();
	}
});
