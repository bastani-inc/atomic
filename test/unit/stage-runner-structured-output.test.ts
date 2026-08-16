import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, test } from "vitest";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
	assert,
	createStageContext,
	join,
	makeMockSession,
	makeOpts,
	mkdtemp,
	readFile,
	rm,
	Type,
	tmpdir,
} from "./stage-runner-helpers.js";

function assistantMessageWithContent(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("createStageContext — structured_output corrective retry", () => {
	test("schema-backed noTools=all stages still expose structured_output", async () => {
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				return makeMockSession().session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					noTools: "all",
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		) as InternalStageContext;

		await ctx.__ensureSession();

		assert.deepEqual(createOptions?.tools, ["structured_output"]);
		assert.equal(
			createOptions?.customTools?.some((tool) => tool.name === "structured_output"),
			true,
		);
	});

	test("re-prompts when a schema-backed stage skips structured_output and then succeeds", async () => {
		let createOptions: StageSessionCreateOptions | undefined;
		const prompts: string[] = [];
		const mock = makeMockSession({
			async prompt(promptText) {
				prompts.push(promptText);
				if (prompts.length === 1) return;
				const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
				assert.ok(structuredTool);
				await structuredTool.execute("structured-call-1", { ok: true }, undefined, undefined, undefined as never);
			},
		});
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		);

		assert.deepEqual(await ctx.prompt("review this"), { ok: true });
		assert.equal((ctx as InternalStageContext).getLastAssistantText(), '{\n  "ok": true\n}');
		assert.equal(prompts.length, 2);
		assert.equal(prompts[0], "review this");
		assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
		assert.match(prompts[1] ?? "", /must finish by calling structured_output/);
		assert.match(prompts[1] ?? "", /Do not answer with plain JSON text/);
	});

	test("echoes structured_output validation errors in the corrective prompt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-correction-"));
		let transcriptPath: string | undefined;
		let createOptions: StageSessionCreateOptions | undefined;
		const prompts: string[] = [];
		const messages = [] as AgentSession["messages"];
		const validationError = 'Validation failed for tool "structured_output": ok: Expected boolean';
		let emit: ((event: { type: string; [k: string]: unknown }) => void) | undefined;
		const mock = makeMockSession({
			messages,
			async prompt(promptText) {
				prompts.push(promptText);
				if (prompts.length === 1) {
					messages.push(
						assistantMessageWithContent([
							{ type: "text", text: "invalid attempt artifact" },
							{
								type: "toolCall",
								id: "structured-call-invalid",
								name: "structured_output",
								arguments: { ok: "not-a-boolean" },
							},
						]),
					);
					emit?.({
						type: "tool_execution_end",
						toolCallId: "structured-call-invalid",
						toolName: "structured_output",
						result: {
							isError: true,
							content: [{ type: "text", text: validationError }],
						},
					});
					return;
				}
				const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
				assert.ok(structuredTool);
				messages.push(
					assistantMessageWithContent([
						{ type: "text", text: "# Corrected review" },
						{ type: "text", text: "\n\nReady to merge." },
						{
							type: "toolCall",
							id: "structured-call-2",
							name: "structured_output",
							arguments: { ok: true },
						},
					]),
				);
				await structuredTool.execute("structured-call-2", { ok: true }, undefined, undefined, undefined as never);
				// A later turn can mention the same tool name without being the execution
				// whose arguments were captured. Name-based reverse scans pick this decoy.
				messages.push(
					assistantMessageWithContent([
						{ type: "text", text: "late wrong artifact" },
						{
							type: "toolCall",
							id: "structured-call-decoy",
							name: "structured_output",
							arguments: { ok: false },
						},
					]),
				);
			},
		});
		emit = mock.emit;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		);

		const output = join(dir, "corrected-review.md");
		try {
			assert.deepEqual(await ctx.prompt("review this", { output, outputMode: "file-only" }), { ok: true });
			assert.equal(prompts.length, 2);
			assert.match(prompts[1] ?? "", new RegExp(validationError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(prompts[1] ?? "", /artifact as ordinary text before calling `structured_output`/);
			assert.match(prompts[1] ?? "", /correct the tool arguments and call `structured_output` again/);
			assert.equal(await readFile(output, "utf8"), "# Corrected review\n\nReady to merge.");
			const receipt = (ctx as InternalStageContext).getLastAssistantText();
			assert.ok(receipt);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("schema-backed output writes prose from the structured_output turn when an admitted turn follows it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-"));
		let transcriptPath: string | undefined;
		try {
			let createOptions: StageSessionCreateOptions | undefined;
			let promptCalls = 0;
			const messages = [] as AgentSession["messages"];
			const mock = makeMockSession({
				messages,
				async prompt() {
					promptCalls += 1;
					const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
					assert.ok(structuredTool);
					messages.push(
						assistantMessageWithContent([
							{ type: "text", text: "# Review" },
							{ type: "text", text: "\n\nReady to merge." },
							{
								type: "toolCall",
								id: "structured-call-schema",
								name: "structured_output",
								arguments: { ok: true },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-schema",
						{ ok: true },
						undefined,
						undefined,
						undefined as never,
					);
					messages.push({
						role: "custom",
						customType: "subagent-notify",
						stageAdmissionKey: "subagent:schema-job",
						content: "late schema notification",
						display: true,
						timestamp: Date.now(),
					} as AgentSession["messages"][number]);
					messages.push({
						role: "assistant",
						content: [{ type: "text", text: "late acknowledgement" }],
						timestamp: Date.now(),
					} as AgentSession["messages"][number]);
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					createOptions = options;
					return mock.session;
				},
			};
			const output = join(dir, "review.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
				}),
			);

			assert.deepEqual(await ctx.prompt("return structured data", { output, outputMode: "file-only" }), {
				ok: true,
			});
			assert.equal(promptCalls, 1);
			assert.equal(await readFile(output, "utf8"), "# Review\n\nReady to merge.");
			const receipt = (ctx as InternalStageContext).getLastAssistantText();
			assert.ok(receipt);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
			assert.match(await readFile(transcriptPath, "utf8"), /late schema notification/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("schema-backed output warns and writes an empty artifact when the structured_output turn has no prose", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-empty-"));
		let transcriptPath: string | undefined;
		try {
			let createOptions: StageSessionCreateOptions | undefined;
			const messages = [] as AgentSession["messages"];
			const mock = makeMockSession({
				messages,
				async prompt() {
					const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
					assert.ok(structuredTool);
					messages.push(
						assistantMessageWithContent([
							{
								type: "toolCall",
								id: "structured-call-empty",
								name: "structured_output",
								arguments: { ok: true },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-empty",
						{ ok: true },
						undefined,
						undefined,
						undefined as never,
					);
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					createOptions = options;
					return mock.session;
				},
			};
			const output = join(dir, "review.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
				}),
			) as InternalStageContext;

			assert.deepEqual(await ctx.prompt("return structured data", { output, outputMode: "file-only" }), {
				ok: true,
			});
			assert.equal(await readFile(output, "utf8"), "");
			const receipt = ctx.getLastAssistantText();
			assert.ok(receipt);
			assert.match(receipt, /WARNING: the stage artifact is empty/);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("recovers earlier-turn prose when the corrective turn calls structured_output without text", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-earlier-"));
		let transcriptPath: string | undefined;
		try {
			let createOptions: StageSessionCreateOptions | undefined;
			const prompts: string[] = [];
			const messages = [] as AgentSession["messages"];
			const mock = makeMockSession({
				messages,
				async prompt(promptText) {
					prompts.push(promptText);
					if (prompts.length === 1) {
						// The model writes the full deliverable as ordinary text but
						// never calls the tool, so the corrective loop runs.
						messages.push(
							assistantMessageWithContent([{ type: "text", text: "# Full deliverable from the first turn" }]),
						);
						return;
					}
					const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
					assert.ok(structuredTool);
					// The corrective turn calls the tool with no accompanying prose.
					messages.push(
						assistantMessageWithContent([
							{
								type: "toolCall",
								id: "structured-call-late",
								name: "structured_output",
								arguments: { ok: true },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-late",
						{ ok: true },
						undefined,
						undefined,
						undefined as never,
					);
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					createOptions = options;
					return mock.session;
				},
			};
			const output = join(dir, "review.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
				}),
			);

			assert.deepEqual(await ctx.prompt("return structured data", { output, outputMode: "file-only" }), {
				ok: true,
			});
			assert.equal(prompts.length, 2);
			assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
			assert.equal(await readFile(output, "utf8"), "# Full deliverable from the first turn");
			const receipt = (ctx as InternalStageContext).getLastAssistantText();
			assert.ok(receipt);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("completes with an empty artifact when the session no longer holds the successful tool-call message", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-missing-"));
		let transcriptPath: string | undefined;
		try {
			let createOptions: StageSessionCreateOptions | undefined;
			const messages = [] as AgentSession["messages"];
			const mock = makeMockSession({
				messages,
				async prompt() {
					const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
					assert.ok(structuredTool);
					// A model-fallback recreation can leave the live session holding
					// only an earlier tool-call id, never the captured one.
					messages.push(
						assistantMessageWithContent([
							{
								type: "toolCall",
								id: "structured-call-from-abandoned-session",
								name: "structured_output",
								arguments: { ok: false },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-live",
						{ ok: true },
						undefined,
						undefined,
						undefined as never,
					);
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					createOptions = options;
					return mock.session;
				},
			};
			const output = join(dir, "review.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
				}),
			) as InternalStageContext;

			assert.deepEqual(await ctx.prompt("return structured data", { output, outputMode: "file-only" }), {
				ok: true,
			});
			assert.equal(await readFile(output, "utf8"), "");
			const receipt = ctx.getLastAssistantText();
			assert.ok(receipt);
			assert.match(receipt, /WARNING: the stage artifact is empty/);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("pairs the artifact with the latest successful execution across a fallback recreation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-workflows-structured-output-recreated-"));
		let transcriptPath: string | undefined;
		try {
			let createOptions: StageSessionCreateOptions | undefined;
			const messages = [] as AgentSession["messages"];
			const mock = makeMockSession({
				messages,
				async prompt() {
					const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
					assert.ok(structuredTool);
					messages.push(
						assistantMessageWithContent([
							{ type: "text", text: "# First session" },
							{
								type: "toolCall",
								id: "structured-call-first",
								name: "structured_output",
								arguments: { ok: false },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-first",
						{ ok: false },
						undefined,
						undefined,
						undefined as never,
					);
					// The session is recreated and the model repeats the call: the
					// live session's pairing must win over the abandoned one.
					messages.push(
						assistantMessageWithContent([
							{ type: "text", text: "# Recreated session" },
							{
								type: "toolCall",
								id: "structured-call-second",
								name: "structured_output",
								arguments: { ok: true },
							},
						]),
					);
					await structuredTool.execute(
						"structured-call-second",
						{ ok: true },
						undefined,
						undefined,
						undefined as never,
					);
				},
			});
			const agentSession: AgentSessionAdapter = {
				async create(options) {
					createOptions = options;
					return mock.session;
				},
			};
			const output = join(dir, "review.md");
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession },
					stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
				}),
			);

			assert.deepEqual(await ctx.prompt("return structured data", { output, outputMode: "file-only" }), {
				ok: true,
			});
			assert.equal(await readFile(output, "utf8"), "# Recreated session");
			const receipt = (ctx as InternalStageContext).getLastAssistantText();
			assert.ok(receipt);
			const transcriptMatch = receipt.match(/Transcript saved to: ([^ ]+) \(/);
			assert.ok(transcriptMatch?.[1]);
			transcriptPath = transcriptMatch[1];
		} finally {
			await rm(dir, { recursive: true, force: true });
			if (transcriptPath) await rm(transcriptPath, { force: true });
		}
	});

	test("schema-only stages keep following late admitted assistant text", async () => {
		let createOptions: StageSessionCreateOptions | undefined;
		const messages = [] as AgentSession["messages"];
		let sessionLastAssistantText = "# Structured turn";
		const mock = makeMockSession({
			messages,
			getLastAssistantText: () => sessionLastAssistantText,
			async prompt() {
				const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
				assert.ok(structuredTool);
				messages.push(
					assistantMessageWithContent([
						{ type: "text", text: "# Structured turn" },
						{
							type: "toolCall",
							id: "structured-call-schema-only",
							name: "structured_output",
							arguments: { ok: true },
						},
					]),
				);
				await structuredTool.execute(
					"structured-call-schema-only",
					{ ok: true },
					undefined,
					undefined,
					undefined as never,
				);
			},
		});
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }) },
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("return structured data"), { ok: true });
		assert.equal(ctx.getLastAssistantText(), '{\n  "ok": true\n}');
		// A late admitted turn grows the session and displaces the serialized
		// schema value, exactly as it would on a stage without structured output.
		messages.push(assistantMessageWithContent([{ type: "text", text: "late admitted acknowledgement" }]));
		sessionLastAssistantText = "late admitted acknowledgement";
		assert.equal(ctx.getLastAssistantText(), "late admitted acknowledgement");
	});

	test("stops after three corrective prompts when structured_output is still missing", async () => {
		const prompts: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					async prompt(promptText) {
						prompts.push(promptText);
					},
				}).session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		);

		await assert.rejects(ctx.prompt("review this"), /must finish by calling structured_output/);
		assert.equal(prompts.length, 4);
		assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
		assert.match(prompts[2] ?? "", /Corrective attempt 2\/3/);
		assert.match(prompts[3] ?? "", /Corrective attempt 3\/3/);
	});
});

// A github-copilot opus catalog entry whose Model object advertises a tiered
// context window (200K default + ~936K long-context), mirroring the live CAPI
// catalog. Only contextWindow/defaultContextWindow/contextWindowOptions are read
// by the resolver, so the rest of Model<Api> is intentionally omitted.
