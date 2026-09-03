import type { AssistantMessage } from "@bastani/pi-ai/compat";
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
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("review this"), /must finish by calling structured_output/);
		assert.equal(prompts.length, 4);
		assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
		assert.match(prompts[2] ?? "", /Corrective attempt 2\/3/);
		assert.match(prompts[3] ?? "", /Corrective attempt 3\/3/);
		// Issue #2812: a candidate that never produced a structured_output call
		// failed, so no attempt it recorded may be reported as successful.
		const meta = ctx.__modelFallbackMeta();
		assert.equal(meta.modelAttempts?.length, 4);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => attempt.success),
			[false, false, false, false],
		);
		for (const attempt of meta.modelAttempts ?? []) {
			assert.match(attempt.error ?? "", /must finish by calling structured_output/);
		}
		// Nothing to retry with, so the chain records no fallback warning.
		assert.equal(meta.warnings, undefined);
	});
});

// Issue #2812: exhausting the per-candidate structured-output correction budget
// must fail the candidate over to the next configured fallback model through the
// same chain rate limits use, instead of throwing outside candidate handling and
// recording every empty turn as a success.
describe("createStageContext — structured_output correction exhaustion and model fallback", () => {
	const SCHEMA = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });

	test("advances to the fallback model when the primary exhausts the correction budget", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		const promptsByModel = new Map<string, string[]>();
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				const { session } = makeMockSession({
					async prompt(promptText) {
						const seen = promptsByModel.get(model) ?? [];
						seen.push(promptText);
						promptsByModel.set(model, seen);
						// The primary returns a clean turn that produced no assistant
						// message at all — the exact shape reported in issue #2812.
						if (model === "anthropic/primary") return;
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-fallback",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
					dispose() {
						disposed.push(model);
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(disposed, ["anthropic/primary"]);
		// The primary spends the initial prompt plus exactly three corrective ones.
		assert.equal(promptsByModel.get("anthropic/primary")?.length, 4);
		assert.match(promptsByModel.get("anthropic/primary")?.[3] ?? "", /Corrective attempt 3\/3/);
		// The next candidate restarts from the original stage prompt with a fresh
		// budget, never from a corrective prompt written for the abandoned one.
		assert.deepEqual(promptsByModel.get("openai/fallback"), ["partition the work"]);

		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, [
			"anthropic/primary",
			"anthropic/primary",
			"anthropic/primary",
			"anthropic/primary",
			"openai/fallback",
		]);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
		for (const attempt of meta.modelAttempts?.slice(0, 4) ?? []) {
			assert.equal(
				attempt.error,
				"atomic-workflows: stage configured with schema must finish by calling structured_output. The model produced no assistant message after the prompt",
			);
		}
		assert.equal(meta.modelAttempts?.[4]?.error, undefined);
		// The standard warning supplies its own sentence break, so the composed
		// text reads as one sentence rather than doubling the period.
		assert.deepEqual(meta.warnings, [
			"[fallback] anthropic/primary failed: atomic-workflows: stage configured with schema must finish by calling structured_output. The model produced no assistant message after the prompt. Retrying with openai/fallback.",
		]);
	});

	test("advances to the fallback model when every structured_output call fails validation", async () => {
		const calls: string[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				let emit: ((event: { type: string; [k: string]: unknown }) => void) | undefined;
				const mock = makeMockSession({
					async prompt() {
						if (model === "anthropic/primary") {
							emit?.({
								type: "tool_execution_end",
								toolName: "structured_output",
								isError: true,
								result: {
									isError: true,
									content: [{ type: "text", text: "structured_output arguments failed schema validation" }],
								},
							});
							return;
						}
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-fallback",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
				});
				emit = mock.emit;
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
		// The validation error is what the candidate failed on, so it — not the
		// generic missing-call sentence — is what the attempt records.
		for (const attempt of meta.modelAttempts?.slice(0, 4) ?? []) {
			assert.equal(attempt.error, "structured_output arguments failed schema validation");
		}
		assert.deepEqual(meta.warnings, [
			"[fallback] anthropic/primary failed: structured_output arguments failed schema validation. Retrying with openai/fallback.",
		]);
	});

	test("fails with the contract error once every candidate has exhausted its budget", async () => {
		const calls: string[] = [];
		const prompts: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
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
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("partition the work"), /must finish by calling structured_output/);
		// Each candidate spends its own budget: two candidates, four prompts each.
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		assert.equal(prompts.length, 8);
		assert.equal(prompts[4], "partition the work");
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: false },
				{ model: "openai/fallback", success: false },
				{ model: "openai/fallback", success: false },
				{ model: "openai/fallback", success: false },
			],
		);
		assert.equal(meta.warnings?.length, 1);
		assert.match(meta.warnings?.[0] ?? "", /^\[fallback\] anthropic\/primary failed: /);
	});

	test("a successful correction on the current candidate never reaches the fallback", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		let promptCount = 0;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				const { session } = makeMockSession({
					async prompt() {
						promptCount += 1;
						if (promptCount === 1) return;
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-corrected",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
					dispose() {
						disposed.push(model);
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });
		assert.equal(promptCount, 2);
		assert.deepEqual(calls, ["anthropic/primary"]);
		assert.deepEqual(disposed, []);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => attempt.success),
			[true, true],
		);
		assert.equal(meta.warnings, undefined);
	});

	test("names an empty assistant turn in the failed attempt error", async () => {
		const messages = [] as AgentSession["messages"];
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({
					messages,
					async prompt() {
						// A clean turn whose assistant message carries no text: a
						// different external cause from producing no message at all.
						messages.push(assistantMessageWithContent([{ type: "text", text: "" }]));
					},
				}).session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", schema: SCHEMA },
			}),
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("partition the work"), /must finish by calling structured_output/);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => attempt.success),
			[false, false, false, false],
		);
		for (const attempt of meta.modelAttempts ?? []) {
			assert.match(attempt.error ?? "", /empty text/);
		}
	});

	// Issue #2812, durable resume/replay: an abandoned candidate can hold no
	// structured capture to reuse, because exhaustion is defined by
	// `structuredOutputCapture.called === false` — the candidate is only
	// abandoned when nothing was captured on it. The observable half of that
	// invariant is what a resumed run reads back: the abandoned candidate's
	// turns must be attempts marked failed, and the value must come from the
	// candidate that actually called the tool.
	test("a resumed run reads the surviving candidate's capture, never the abandoned one", async () => {
		const captured: unknown[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				const { session } = makeMockSession({
					async prompt() {
						if (model === "anthropic/primary") return;
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						captured.push({ model, value: { ok: true } });
						await structuredTool.execute(
							"structured-call-fallback",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });
		// Only the surviving candidate ever executed the tool, so no abandoned
		// capture exists for a replay to pick up.
		assert.deepEqual(captured, [{ model: "openai/fallback", value: { ok: true } }]);
		assert.equal(ctx.__structuredOutputFinalized(), true);
		const meta = ctx.__modelFallbackMeta();
		const abandoned = meta.modelAttempts?.filter((attempt) => attempt.model === "anthropic/primary") ?? [];
		assert.equal(abandoned.length, 4);
		assert.equal(
			abandoned.every((attempt) => attempt.success === false),
			true,
		);
	});
});

// A github-copilot opus catalog entry whose Model object advertises a tiered
// context window (200K default + ~936K long-context), mirroring the live CAPI
// catalog. Only contextWindow/defaultContextWindow/contextWindowOptions are read
// by the resolver, so the rest of Model<Api> is intentionally omitted.
