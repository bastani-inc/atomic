import { describe, test } from "vitest";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts, Type } from "./stage-runner-helpers.js";

describe("createStageContext — model fallback", () => {
	test("primary retryable failure tries fallback and records metadata", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				const { session } = makeMockSession({
					async prompt() {
						if (model === "anthropic/primary") throw new Error("429 rate limit exceeded");
					},
					dispose() {
						disposed.push(model);
					},
					getLastAssistantText() {
						return model === "openai/fallback" ? "fallback answer" : undefined;
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
				},
			}),
		) as InternalStageContext;

		const text = await ctx.prompt("go");

		assert.equal(text, "fallback answer");
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(disposed, ["anthropic/primary"]);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => attempt.success),
			[false, true],
		);
		assert.equal(meta.modelAttempts?.[0]?.error, "429 rate limit exceeded");
		assert.equal(meta.warnings, undefined);
	});

	test("schema-backed structured_output capture prevents fallback retry after a later model error", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model = typeof options.model === "string" ? options.model : "object-model";
				calls.push(model);
				const { session } = makeMockSession({
					async prompt() {
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-1",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
						throw new Error("429 rate limit exceeded after structured_output");
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
					schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("go"), { ok: true });
		assert.deepEqual(calls, ["anthropic/primary"]);
		assert.deepEqual(disposed, []);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary"]);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[{ model: "anthropic/primary", success: true }],
		);
		assert.equal(meta.warnings, undefined);
	});

	test("non-throwing assistant stopReason error tries fallback and records metadata", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const modelValue = options.model as unknown;
				const model = typeof modelValue === "string" ? modelValue : "object-model";
				calls.push(model);
				const messages: AgentSession["messages"] = [];
				const { session } = makeMockSession({
					messages,
					async prompt() {
						if (model === "anthropic/primary") {
							messages.push({
								role: "assistant",
								content: [],
								stopReason: "error",
								errorMessage: "地域化されたプロバイダー エラー",
								diagnostics: [{ error: { code: 429, message: "quota exhausted" } }],
							} as unknown as AgentSession["messages"][number]);
							return;
						}
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "fallback answer" }],
							stopReason: "stop",
						} as unknown as AgentSession["messages"][number]);
					},
					dispose() {
						disposed.push(model);
					},
					getLastAssistantText() {
						return model === "openai/fallback" ? "fallback answer" : undefined;
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
				},
			}),
		) as InternalStageContext;

		const text = await ctx.prompt("go");

		assert.equal(text, "fallback answer");
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(disposed, ["anthropic/primary"]);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => attempt.success),
			[false, true],
		);
		assert.equal(meta.modelAttempts?.[0]?.error, "地域化されたプロバイダー エラー");
		assert.equal(meta.warnings, undefined);
	});

	test("recovered non-throwing assistant failure in the same prompt does not try fallback", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const modelValue = options.model as unknown;
				const model = typeof modelValue === "string" ? modelValue : "object-model";
				calls.push(model);
				const messages: AgentSession["messages"] = [];
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "429 rate limit exceeded",
							diagnostics: [{ error: { code: 429, message: "rate limit" } }],
						} as unknown as AgentSession["messages"][number]);
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "primary recovered answer" }],
							stopReason: "stop",
						} as unknown as AgentSession["messages"][number]);
					},
					dispose() {
						disposed.push(model);
					},
					getLastAssistantText() {
						return "primary recovered answer";
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
				},
			}),
		) as InternalStageContext;

		const text = await ctx.prompt("go");

		assert.equal(text, "primary recovered answer");
		assert.deepEqual(calls, ["anthropic/primary"]);
		assert.deepEqual(disposed, []);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary"]);
		assert.deepEqual(
			meta.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[{ model: "anthropic/primary", success: true }],
		);
		assert.equal(meta.warnings, undefined);
	});
});
