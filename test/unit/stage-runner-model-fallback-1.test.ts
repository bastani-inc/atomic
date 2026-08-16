import { describe, test } from "vitest";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
	assert,
	assistantMessageWithUsage,
	createStageContext,
	makeMockSession,
	makeOpts,
	Type,
} from "./stage-runner-helpers.js";

const USAGE_A = { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 0.011 };
const USAGE_B = { input: 111, output: 222, cacheRead: 333, cacheWrite: 444, cost: 0.111 };

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
		// Neither attempt admitted an assistant response, so neither may carry usage.
		assert.equal(Object.hasOwn(meta.modelAttempts?.[0] ?? {}, "usage"), false);
		assert.equal(Object.hasOwn(meta.modelAttempts?.[1] ?? {}, "usage"), false);
	});

	test("a successful candidate with one meaningful assistant reports the exact usage aggregate", async () => {
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push(assistantMessageWithUsage("primary answer", USAGE_A));
					},
					getLastAssistantText() {
						return "primary answer";
					},
				});
				return session;
			},
		};

		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "primary answer");
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary"]);
		assert.deepEqual(meta.modelAttempts?.[0], {
			model: "anthropic/primary",
			success: true,
			usage: { ...USAGE_A, turns: 1 },
		});
	});

	test("multiple meaningful assistants in one attempt sum every bucket and count each turn", async () => {
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					messages,
					async prompt() {
						// One provider round that recovered after an error, then the final answer.
						messages.push(assistantMessageWithUsage("recovered", USAGE_A, "error"));
						messages.push(assistantMessageWithUsage("primary answer", USAGE_B));
					},
					getLastAssistantText() {
						return "primary answer";
					},
				});
				return session;
			},
		};

		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "primary answer");
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary"]);
		assert.deepEqual(meta.modelAttempts?.[0], {
			model: "anthropic/primary",
			success: true,
			usage: {
				input: USAGE_A.input + USAGE_B.input,
				output: USAGE_A.output + USAGE_B.output,
				cacheRead: USAGE_A.cacheRead + USAGE_B.cacheRead,
				cacheWrite: USAGE_A.cacheWrite + USAGE_B.cacheWrite,
				cost: USAGE_A.cost + USAGE_B.cost,
				turns: 2,
			},
		});
	});

	test("a failed provider response keeps its usage while the fallback keeps its own window", async () => {
		const calls: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				const messages: AgentSession["messages"] = [];
				const { session } = makeMockSession({
					messages,
					async prompt() {
						if (model === "anthropic/primary") {
							messages.push(assistantMessageWithUsage("partial primary response", USAGE_A, "error"));
							throw new Error("429 rate limit exceeded");
						}
						messages.push(assistantMessageWithUsage("fallback answer", USAGE_B));
					},
					dispose() {
						calls.push(`dispose:${model}`);
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

		assert.equal(await ctx.prompt("go"), "fallback answer");
		assert.deepEqual(calls, ["anthropic/primary", "openai/fallback", "dispose:anthropic/primary"]);
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.deepEqual(meta.modelAttempts?.[0], {
			model: "anthropic/primary",
			success: false,
			error: "429 rate limit exceeded",
			usage: { ...USAGE_A, turns: 1 },
		});
		assert.deepEqual(meta.modelAttempts?.[1], {
			model: "openai/fallback",
			success: true,
			usage: { ...USAGE_B, turns: 1 },
		});
	});

	test("a zeroed assistant usage object is omitted from the attempt", async () => {
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				const { session } = makeMockSession({
					messages,
					async prompt() {
						if (model === "anthropic/primary") {
							messages.push(
								assistantMessageWithUsage(
									"empty provider response",
									{
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0,
									},
									"error",
								),
							);
							return;
						}
						messages.push(assistantMessageWithUsage("fallback answer", USAGE_A));
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
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");
		const meta = ctx.__modelFallbackMeta();
		assert.deepEqual(meta.attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.equal(Object.hasOwn(meta.modelAttempts?.[0] ?? {}, "usage"), false);
		assert.deepEqual(meta.modelAttempts?.[1], {
			model: "openai/fallback",
			success: true,
			usage: { ...USAGE_A, turns: 1 },
		});
	});

	test("cost-only and total-token-only signals each count as meaningful turns", async () => {
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push(
							assistantMessageWithUsage("cost-only", {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0.25,
								totalTokens: 0,
							}),
							assistantMessageWithUsage("total-only", {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								totalTokens: 7,
							}),
						);
					},
					getLastAssistantText: () => "total-only",
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "total-only");
		assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts?.[0]?.usage, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.25,
			turns: 2,
		});
	});

	test("malformed usage records are omitted instead of poisoning the aggregate", async () => {
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push(
							assistantMessageWithUsage("nan", {
								input: 1,
								output: Number.NaN,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
							}),
							assistantMessageWithUsage("infinite", {
								input: Number.POSITIVE_INFINITY,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
							}),
							assistantMessageWithUsage("negative", {
								input: 1,
								output: -1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								totalTokens: 0,
							}),
						);
					},
					getLastAssistantText: () => "negative",
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "negative");
		assert.equal(Object.hasOwn(ctx.__modelFallbackMeta().modelAttempts?.[0] ?? {}, "usage"), false);
	});

	test("schema-backed structured_output capture prevents fallback retry after a later model error", async () => {
		const calls: string[] = [];
		const disposed: string[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model = typeof options.model === "string" ? options.model : "object-model";
				calls.push(model);
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push(assistantMessageWithUsage("structured tool call", USAGE_A));
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
		// The provider response that carried the structured tool call is part of
		// this successful attempt, so its usage must be present.
		assert.deepEqual(meta.modelAttempts?.[0]?.usage, { ...USAGE_A, turns: 1 });
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
		// The error assistant carries no usage object, so the failed attempt must omit usage.
		assert.equal(meta.modelAttempts?.[0]?.usage, undefined);
		assert.equal(meta.modelAttempts?.[1]?.usage, undefined);
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
