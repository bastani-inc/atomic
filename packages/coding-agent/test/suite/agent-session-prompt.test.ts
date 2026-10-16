import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@bastani/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type Model, type TranscriptContext } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

it("keeps custom-message run prompt sections across tool calls (#10267)", async () => {
	const events: string[] = [];
	const harness = await createHarness({
		tools: [
			{
				name: "noop",
				label: "Noop",
				description: "Noop",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			},
		],
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", (event) => {
					events.push(event.messageType);
					event.systemPromptOptions.sections.extension_rules = "Answer in one word.";
				});
			},
		],
	});
	try {
		const prompts: string[] = [];
		const record = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return response;
		};
		harness.setResponses([
			record(fauxAssistantMessage("hi")),
			record(fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" })),
			record(fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("hello");
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		await harness.session.sendCustomMessage(
			{ customType: "task-done", content: "background task finished", display: true },
			{ triggerTurn: true },
		);
		await settled;
		assert.equal(prompts.length, 3);
		assert.match(prompts[0], /Answer in one word\./);
		assert.equal(new Set(prompts).size, 1);
		assert.deepEqual(events, ["user", "custom"]);
	} finally {
		await harness.cleanup();
	}
});

it.each(["user", "custom"] as const)("queues messages during %s run setup (#10739)", async (messageType) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const requests: TranscriptContext[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	try {
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("done");
			},
		]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		const run =
			messageType === "user"
				? harness.session.prompt("first")
				: harness.session.sendCustomMessage(
						{ customType: "first", content: "first", display: true },
						{ triggerTurn: true },
					);
		await entered.promise;
		assert.equal(harness.session.isStreaming, messageType === "custom");
		await assert.rejects(harness.session.prompt("concurrent prompt"), /Agent is already processing/);
		assert.equal(harness.session.isStreaming, messageType === "custom");
		await harness.session.sendCustomMessage(
			{ customType: "second", content: "second", display: true },
			{ triggerTurn: true },
		);
		release.resolve();
		await Promise.all([run, settled]);
		assert.equal(requests.length, 1);
		assert.match(JSON.stringify(requests[0].messages), /first/);
		assert.match(JSON.stringify(requests[0].messages), /second/);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});

it("rejects tree navigation during user run preparation without moving the prompt", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let treeEvents = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					entered.resolve();
					await release.promise;
				});
				pi.on("session_before_tree", () => {
					treeEvents++;
				});
			},
		],
	});
	let run: Promise<void> | undefined;
	try {
		const targetId = await harness.sessionManager.appendMessage(fauxAssistantMessage("earlier branch"));
		const originalLeafId = await harness.sessionManager.appendMessage(fauxAssistantMessage("original branch"));
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("done")]);
		run = harness.session.prompt("pending prompt");
		await entered.promise;
		const entriesBefore = harness.sessionManager.getEntries();
		assert.equal(harness.session.isStreaming, false);
		await assert.rejects(harness.session.navigateTree(targetId, { summarize: false }), {
			message: "Wait for the current response to finish before navigating the session tree.",
		});
		assert.equal(harness.session.isStreaming, false);
		assert.equal(treeEvents, 0);
		assert.equal(harness.sessionManager.getLeafId(), originalLeafId);
		assert.deepEqual(harness.sessionManager.getEntries(), entriesBefore);
		release.resolve();
		await run;
		const promptEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		assert.ok(promptEntry);
		assert.ok(harness.sessionManager.getBranch(promptEntry.id).some((entry) => entry.id === originalLeafId));
		assert.match(JSON.stringify(promptEntry), /pending prompt/);
	} finally {
		release.resolve();
		await run;
		await harness.cleanup();
	}
});

it.each(["user", "custom"] as const)("honors abort during %s run setup (#10739)", async (messageType) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage("should not complete")]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		const run =
			messageType === "user"
				? harness.session.prompt("first")
				: harness.session.sendCustomMessage(
						{ customType: "first", content: "first", display: true },
						{ triggerTurn: true },
					);
		await entered.promise;
		const aborted = harness.session.abort();
		release.resolve();
		await Promise.all([run, aborted, settled]);
		const last = harness.session.messages.at(-1);
		assert.equal(last?.role, "assistant");
		assert.equal(last?.role === "assistant" && last.stopReason, "aborted");
		assert.equal(harness.session.isStreaming, false);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});

it("does not start a custom run paused during setup (#10739)", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	try {
		harness.setResponses([
			() => {
				requests++;
				return fauxAssistantMessage("should stay queued");
			},
		]);
		const settled = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
			});
		});
		const run = harness.session.sendCustomMessage(
			{ customType: "first", content: "first", display: true },
			{ triggerTurn: true },
		);
		await entered.promise;
		harness.session.pauseQueuedMessages();
		release.resolve();
		await Promise.all([run, settled]);
		assert.equal(requests, 0);
		assert.equal(harness.session.queuedMessagesPaused, true);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});

const processImage = vi.hoisted(() =>
	vi.fn(async (_bytes: Uint8Array, mimeType: string) => ({
		ok: true as const,
		data: Buffer.from("normalized").toString("base64"),
		mimeType,
		hints: [],
	})),
);
vi.mock("../../src/utils/image-process.ts", () => ({ processImage }));

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		processImage.mockClear();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages.find((message) => message.role === "user"))).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[3]?.role).toBe("toolResult");
		expect(harness.session.messages[4]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9631
	it("uses the model selected by before_agent_start for image normalization", async () => {
		let strictModel: Model<string> | undefined;
		const harness = await createHarness({
			models: [{ id: "wide" }, { id: "strict" }],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!strictModel) throw new Error("Expected strict model");
						await pi.setModel(strictModel);
					});
				},
			],
		});
		harnesses.push(harness);
		strictModel = harness.getModel("strict");
		if (!strictModel) throw new Error("Expected strict model");
		const resizeOptions = { maxWidth: 1000, maxHeight: 1000, maxBytes: 500000, jpegQuality: 70 };
		strictModel.inputLimits = { images: { resize: resizeOptions } };
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("inspect", {
			images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
		});

		expect(harness.session.model?.id).toBe("strict");
		expect(processImage).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", {
			autoResizeImages: true,
			resizeOptions,
		});
		const userMessage = harness.session.messages.find((message) => message.role === "user");
		expect(userMessage?.content).toContainEqual({
			type: "image",
			data: Buffer.from("normalized").toString("base64"),
			mimeType: "image/png",
		});
	});

	it("expands skill commands before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(getMessageText(harness.session.messages.find((message) => message.role === "user"))).toBe(
			"from extension",
		);
	});

	it("sendUserMessage sends a registered command literally by default", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.sendUserMessage("/testcmd hello world");

		// Absent the option, every pre-existing caller keeps today's meaning:
		// no dispatch, the raw text is sent to the model.
		expect(commandRuns).toEqual([]);
		expect(getMessageText(harness.session.messages.find((message) => message.role === "user"))).toBe(
			"/testcmd hello world",
		);
	});

	it("sendUserMessage dispatches extension commands with expandPromptTemplates", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.sendUserMessage("/testcmd hello world", { expandPromptTemplates: true });

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage with expandPromptTemplates falls through to a literal send for unknown commands", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.sendUserMessage("/nosuchcommand keep literal", { expandPromptTemplates: true });

		expect(getMessageText(harness.session.messages.find((message) => message.role === "user"))).toBe(
			"/nosuchcommand keep literal",
		);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("sendUserMessage expands prompt templates with expandPromptTemplates", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		await harness.session.sendUserMessage("/review src/index.ts", { expandPromptTemplates: true });

		expect(getMessageText(harness.session.messages.find((message) => message.role === "user"))).toBe(
			"Review this code: src/index.ts",
		);
	});

	it("does not report streamingBehavior to input handlers while idle", async () => {
		const inputEvents: InputEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("idle", { streamingBehavior: "followUp" });

		expect(inputEvents).toHaveLength(1);
		expect(inputEvents[0]?.streamingBehavior).toBeUndefined();
	});

	it("reports streamingBehavior to input handlers while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const inputEvents: InputEvent[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("queued", { streamingBehavior: "followUp" });

		expect(inputEvents.map((event) => event.streamingBehavior)).toEqual([undefined, "followUp"]);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws a clear 'unknown model' error when the model has no provider", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Simulate an unknown/unresolved model id reaching the prompt path as a
		// bare string (no `.provider`) — the shape that previously surfaced as the
		// confusing "No API key found for undefined".
		harness.session.agent.state.model = "openai/ghost" as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow('Unknown model: "openai/ghost"');
		await expect(harness.session.prompt("hi")).rejects.not.toThrow("No API key found for undefined");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
