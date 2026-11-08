import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDecisionOutputError, isDecisionProviderError } from "@bastani/atomic";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { STRUCTURED_OUTPUT_CLOSING_INSTRUCTION } from "../../packages/workflows/src/runs/foreground/stage-runner-output.js";
import { isWorkflowStructuredOutputContractError } from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output.js";
import {
	AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS,
	AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES,
} from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output-auto.js";
import { findWorkflowStructuredOutputInferenceError } from "../../packages/workflows/src/shared/structured-output-errors.js";
import { decisionChatModel } from "../helpers/structured-output.js";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageModelFallbackMeta,
	StageRunnerOpts,
} from "./stage-runner-helpers.js";
import {
	assert,
	assistantMessageWithUsage,
	createStageContext,
	makeMockSession,
	makeOpts,
	skippedStructuredOutputTurn,
} from "./stage-runner-helpers.js";
import { FINAL_TEXT, InferenceRig, NO_USAGE, proseTurn, userTurn } from "./structured-output-auto-fixture.js";
import { executeWorkflowDecision } from "./structured-output-workflow-fixture.js";

const SCHEMA = Type.Object(
	{ approved: Type.Boolean(), summary: Type.String() },
	{ additionalProperties: false, description: "Review verdict." },
);

function sentPrompt(authored: string): string {
	return `${authored}${STRUCTURED_OUTPUT_CLOSING_INSTRUCTION}`;
}

interface StageRig {
	readonly ctx: InternalStageContext;
	readonly prompts: string[];
	readonly inference: InferenceRig;
	readonly messages: AgentSession["messages"];
}

/**
 * A schema-backed stage over a session whose turns the test scripts. `turn` runs once per prompt the stage sends, with
 * the number of the prompt (1-based) and the structured_output tool the stage registered.
 */
function stageOver(input: {
	readonly turn: (
		prompt: number,
		tool: NonNullable<ReturnType<typeof registeredTool>>,
		messages: AgentSession["messages"],
	) => Promise<void> | void;
	readonly inference?: InferenceRig;
	readonly withToolContext?: boolean;
	readonly stageOptions?: Record<string, unknown>;
	readonly signal?: AbortSignal;
	readonly runnerOptions?: Partial<StageRunnerOpts>;
}): StageRig {
	const prompts: string[] = [];
	const inference = input.inference ?? new InferenceRig();
	const messages = [] as AgentSession["messages"];
	let created: Parameters<AgentSessionAdapter["create"]>[0] | undefined;
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			created = options;
			const { session } = makeMockSession({
				messages,
				async prompt(text) {
					prompts.push(text);
					userTurn(messages, text);
					const tool = registeredTool(created);
					assert.ok(tool, "the schema-backed stage registers structured_output");
					await input.turn(prompts.length, tool, messages);
				},
			});
			return input.withToolContext === false ? session : inference.attachTo(session);
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { schema: SCHEMA, ...input.stageOptions },
			...(input.signal === undefined ? {} : { signal: input.signal }),
			...input.runnerOptions,
		}),
	) as InternalStageContext;
	return { ctx, prompts, inference, messages };
}

function registeredTool(options: Parameters<AgentSessionAdapter["create"]>[0] | undefined) {
	return options?.customTools?.find((tool) => tool.name === "structured_output");
}

const omitTheCall = (_prompt: number, _tool: unknown, messages: AgentSession["messages"]): void =>
	proseTurn(messages, FINAL_TEXT);

describe("createStageContext — the runtime closes a schema stage's prompt with the structured_output instruction (#4565)", () => {
	test("the first prompt a schema stage sends already carries the instruction, without the author writing it (#4565)", async () => {
		const { ctx, prompts } = stageOver({ turn: omitTheCall });

		await ctx.prompt("review the change");

		assert.equal(prompts[0], sentPrompt("review the change"));
		assert.match(prompts[0] ?? "", /finish by calling the structured_output tool exactly once/);
	});

	test("a schema stage with an output file keeps its artifact instruction and still ends on the structured_output instruction (#4565)", async () => {
		const directory = await mkdtemp(join(tmpdir(), "structured-output-4565-instruction-"));
		try {
			const { ctx, prompts } = stageOver({ turn: omitTheCall });

			await ctx.prompt("review the change", { output: join(directory, "review.md") });

			assert.match(prompts[0] ?? "", /two final output channels/);
			assert.ok((prompts[0] ?? "").endsWith(STRUCTURED_OUTPUT_CLOSING_INSTRUCTION), prompts[0]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("a stage without a schema gets no structured_output instruction (#4565)", async () => {
		const prompts: string[] = [];
		const messages = [] as AgentSession["messages"];
		const { session } = makeMockSession({
			messages,
			async prompt(text) {
				prompts.push(text);
				proseTurn(messages, FINAL_TEXT);
			},
		});
		const ctx = createStageContext(makeOpts({ adapters: { agentSession: { create: async () => session } } }));

		await ctx.prompt("review the change");

		assert.deepEqual(prompts, ["review the change"]);
	});

	test("the prompt re-sent to a fallback candidate's new session carries the instruction too (#4565)", async () => {
		const promptsBySession: string[][] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const prompts: string[] = [];
				promptsBySession.push(prompts);
				const messages = [] as AgentSession["messages"];
				const { session } = makeMockSession({
					messages,
					async prompt(text) {
						prompts.push(text);
						if (promptsBySession.length === 1) return skippedStructuredOutputTurn(messages);
						const tool = registeredTool(options);
						assert.ok(tool);
						await executeWorkflowDecision(tool, "model-call", { approved: true, summary: "fallback" });
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { schema: SCHEMA, model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		);

		await ctx.prompt("review the change");

		assert.equal(promptsBySession.length, 2);
		assert.equal(promptsBySession[1]?.[0], sentPrompt("review the change"));
	});
});

describe("createStageContext — the runtime infers the structured result when the turn ends without the call (#4565)", () => {
	test("finishes the stage from the final answer, recording the result like a model's call (#4565)", async () => {
		const { ctx, prompts, inference } = stageOver({ turn: omitTheCall });

		const result = await ctx.prompt("review the change");

		assert.deepEqual(result, { approved: true, summary: FINAL_TEXT });
		assert.equal(prompts.length, 1, "no corrective prompt is spent");
		assert.equal(inference.requests.length, 1);
		assert.deepEqual(inference.contextRequests, ["workflow-auto-structured-output-1"]);
		assert.equal(ctx.__structuredOutputFinalized(), true);
		assert.equal(ctx.getLastAssistantText(), JSON.stringify(result, null, 2));
		await assert.rejects(ctx.prompt("a second prompt"), /supports one prompt\(\) call per stage context/);
	});

	test("builds the inference's instructions from the result schema and its state from the task, the final answer and the exchange (#4565)", async () => {
		const { ctx, inference } = stageOver({
			turn: (_prompt, _tool, messages) => {
				proseTurn(messages, "First I read the patch.");
				proseTurn(messages, FINAL_TEXT);
			},
		});

		await ctx.prompt("review the change");

		const [request] = inference.requests;
		assert.ok(request);
		assert.match(request.systemPrompt, /Result schema: Review verdict\./);
		assert.match(request.systemPrompt, /state\.finalAssistantText/);
		assert.equal(request.state.stageTask, "review the change");
		assert.equal(request.state.finalAssistantText, FINAL_TEXT);
		assert.deepEqual(request.state.recentTranscript, [
			{ role: "user", text: sentPrompt("review the change") },
			{ role: "assistant", text: "First I read the patch." },
		]);
	});

	test("bounds the exchange it hands the inference (#4565)", async () => {
		const { ctx, inference } = stageOver({
			turn: (_prompt, _tool, messages) => {
				for (let index = 0; index < AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES + 3; index += 1)
					proseTurn(messages, `step ${index} ${"x".repeat(AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS)}`);
				proseTurn(messages, FINAL_TEXT);
			},
		});

		await ctx.prompt("review the change");

		const transcript = inference.requests[0]?.state.recentTranscript ?? [];
		const heads = transcript.map((entry) => entry.text.slice(0, 7));
		assert.deepEqual(heads, ["step 3 ", "step 4 ", "step 5 ", "step 6 ", "step 7 ", "step 8 "]);
		for (const entry of transcript) {
			assert.ok(entry.text.includes("characters omitted"), "a long message keeps both ends around an omission note");
			assert.ok(
				entry.text.length < AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS + 64,
				`bounded, not ${entry.text.length}`,
			);
		}
	});

	test("a model's own successful call wins: the runtime runs no second inference (#4565)", async () => {
		const { ctx, prompts, inference } = stageOver({
			turn: async (_prompt, tool, messages) => {
				proseTurn(messages, FINAL_TEXT);
				await executeWorkflowDecision(tool, "model-call", { approved: false, summary: "by the model" });
			},
		});

		const result = await ctx.prompt("review the change");

		assert.deepEqual(result, { approved: false, summary: "by the model" });
		assert.equal(prompts.length, 1);
		assert.deepEqual(inference.contextRequests, []);
		assert.equal(inference.requests.length, 0);
	});

	test("infers from the tool context's decision model before the current chat model (#4565)", async () => {
		const decider = { ...decisionChatModel, id: "decider" };
		const inference = new InferenceRig();
		const context = inference.context as unknown as {
			modelRegistry: { getAll: () => unknown[] };
			getDecisionModel?: () => string;
		};
		context.modelRegistry.getAll = () => [decider, decisionChatModel];
		context.getDecisionModel = () => "decision-test/decider";
		const { ctx } = stageOver({ turn: omitTheCall, inference });

		await ctx.prompt("review the change");

		assert.deepEqual(inference.models, ["decision-test/decider"]);
	});

	test("keeps the human-readable final text as the artifact of a stage with an output file (#4565)", async () => {
		const directory = await mkdtemp(join(tmpdir(), "structured-output-4565-artifact-"));
		try {
			const output = join(directory, "review.md");
			const { ctx, prompts, inference } = stageOver({ turn: omitTheCall });

			const result = await ctx.prompt("review the change", { output });

			assert.deepEqual(result, { approved: true, summary: FINAL_TEXT });
			assert.equal(await readFile(output, "utf8"), FINAL_TEXT);
			assert.equal(prompts.length, 1);
			assert.equal(inference.requests.length, 1);
			assert.match(ctx.getLastAssistantText() ?? "", /review\.md/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("the artifact is the very final answer the inference was given, whatever the earlier messages carried (#4565)", async () => {
		const directory = await mkdtemp(join(tmpdir(), "structured-output-4565-artifact-final-"));
		try {
			const output = join(directory, "review.md");
			const reportWithFailedCall = {
				...assistantMessageWithUsage("The full report.", NO_USAGE),
				content: [
					{ type: "text", text: "The full report." },
					{ type: "toolCall", id: "failed-call", name: "structured_output", arguments: {} },
				],
			} as AgentSession["messages"][number];
			const { ctx, inference } = stageOver({
				turn: (_prompt, _tool, messages) => {
					proseTurn(messages, "A progress note.");
					messages.push(reportWithFailedCall);
					proseTurn(messages, "   ");
				},
			});

			await ctx.prompt("review the change", { output });

			assert.equal(inference.requests[0]?.state.finalAssistantText, "The full report.");
			assert.equal(await readFile(output, "utf8"), "The full report.");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("keeps an over-long final answer whole in the artifact while the inference sees it bounded (#4565)", async () => {
		const directory = await mkdtemp(join(tmpdir(), "structured-output-4565-artifact-long-"));
		try {
			const output = join(directory, "review.md");
			const long = `START${"x".repeat(AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS)}END`;
			const { ctx, inference } = stageOver({ turn: (_prompt, _tool, messages) => proseTurn(messages, long) });

			await ctx.prompt("review the change", { output });

			assert.ok(inference.requests[0]?.state.finalAssistantText.includes("characters omitted"));
			assert.equal(await readFile(output, "utf8"), long);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not infer a result from a turn that left no assistant text (#4565)", async () => {
		const { ctx, prompts, inference } = stageOver({
			turn: (_prompt, _tool, messages) => proseTurn(messages, "   "),
		});

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(isWorkflowStructuredOutputContractError(failure), String(failure));
		assert.equal(Object.hasOwn(failure, "cause"), false, "nothing failed in an inference that never ran");
		assert.equal(prompts.length, 4, "the corrective budget is untouched");
		assert.deepEqual(inference.contextRequests, []);
	});

	test("infers only from the answer of the turn that just ended, not from an earlier turn's (#4565)", async () => {
		const inference = new InferenceRig(() => "invalid-answer");
		const { ctx, prompts } = stageOver({
			inference,
			turn: (prompt, _tool, messages) => proseTurn(messages, prompt === 1 ? FINAL_TEXT : "   "),
		});

		await assert.rejects(ctx.prompt("review the change"), isWorkflowStructuredOutputContractError);

		assert.equal(prompts.length, 4);
		assert.deepEqual(inference.contextRequests, ["workflow-auto-structured-output-1"]);
	});
});

describe("createStageContext — corrective prompts remain the fallback when the automatic inference fails (#4565)", () => {
	test("a model's corrected call finishes the stage after the automatic inference fails (#4565)", async () => {
		const inference = new InferenceRig(() => "invalid-answer");
		const { ctx, prompts } = stageOver({
			inference,
			turn: async (prompt, tool, messages) => {
				if (prompt === 1) return proseTurn(messages, FINAL_TEXT);
				await executeWorkflowDecision(tool, "model-call", { approved: true, summary: "corrected" });
			},
		});

		const result = await ctx.prompt("review the change");

		assert.deepEqual(result, { approved: true, summary: "corrected" });
		assert.equal(prompts.length, 2);
		assert.match(prompts[1] ?? "", /Corrective attempt 1\/3/);
		assert.deepEqual(inference.contextRequests, ["workflow-auto-structured-output-1"]);
		const warnings = ctx.__modelFallbackMeta().warnings ?? [];
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /^\[structured-output\] .*\(auto-inference-failed\)/);
	});

	test("publishes the inference failure with the stage's durable model metadata the moment it is recorded (#4565)", async () => {
		const notified: StageModelFallbackMeta[] = [];
		const carriesWarning = (meta: StageModelFallbackMeta): boolean =>
			meta.warnings?.some((warning) => warning.startsWith("[structured-output] ")) === true;
		let publishedBeforeCorrection = false;
		const inference = new InferenceRig(() => "invalid-answer");
		const { ctx } = stageOver({
			inference,
			runnerOptions: { onModelFallbackMetaChange: (meta) => notified.push(meta) },
			turn: async (prompt, tool, messages) => {
				if (prompt === 1) return proseTurn(messages, FINAL_TEXT);
				publishedBeforeCorrection = notified.some(carriesWarning);
				await executeWorkflowDecision(tool, "model-call", { approved: true, summary: "corrected" });
			},
		});

		await ctx.prompt("review the change");

		assert.equal(publishedBeforeCorrection, true, "the warning was published before the corrective turn began");
		assert.ok(notified.some(carriesWarning), "a durable callback carried the warning");
		assert.deepEqual(notified.at(-1), ctx.__modelFallbackMeta());
	});

	test("spends the unchanged corrective budget, then fails with the contract error and the typed inference error as its cause (#4565)", async () => {
		const inference = new InferenceRig(() => "invalid-answer");
		const { ctx, prompts } = stageOver({ inference, turn: omitTheCall });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(isWorkflowStructuredOutputContractError(failure), String(failure));
		assert.equal(prompts.length, 4, "the initial prompt plus three corrective ones");
		assert.equal(inference.contextRequests.length, 4, "every turn that ends without the call is inferred from");
		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.ok(cause);
		assert.equal(cause.code, "auto-inference-failed");
		assert.equal(cause.retryable, false);
		assert.deepEqual(cause.fields, {
			runId: "run-xyz",
			stageId: "stage-abc",
			stageName: "My Stage",
			toolCallId: "workflow-auto-structured-output-4",
		});
		assert.ok(cause.cause instanceof Error);
		const warnings = ctx.__modelFallbackMeta().warnings ?? [];
		assert.equal(warnings.length, 1, "one warning for the stage, not one per correction turn");
		assert.match(warnings[0] ?? "", /\(auto-inference-failed\)\..* Cause: \w+/);
	});

	test("with a decision model, as every real session has, an invalid inferred answer is still a correctable contract failure (#4565)", async () => {
		const inference = new InferenceRig(() => "invalid-answer", true);
		const { ctx, prompts } = stageOver({ inference, turn: omitTheCall });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(isWorkflowStructuredOutputContractError(failure), String(failure));
		assert.equal(prompts.length, 4, "the initial prompt plus three corrective ones");
		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.equal(cause?.code, "auto-inference-failed");
		assert.ok(isDecisionOutputError(cause?.cause), "the decision engine's typed output error is the cause");
	});

	test("with a decision model, a provider failure keeps its text and is no contract failure (#4565)", async () => {
		const inference = new InferenceRig(() => "provider-failure", true);
		const { ctx, prompts } = stageOver({ inference, turn: omitTheCall });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(failure);
		assert.equal(isWorkflowStructuredOutputContractError(failure), false);
		assert.equal(prompts.length, 4);
		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.ok(cause?.cause instanceof Error && isDecisionProviderError(cause.cause));
		assert.equal(failure.message, cause.cause.message);
	});

	test("an invalid inferred answer leaves no failure behind once a corrected call succeeds (#4565)", async () => {
		const inference = new InferenceRig(() => "invalid-answer", true);
		const { ctx, prompts } = stageOver({
			inference,
			turn: async (prompt, tool, messages) => {
				if (prompt === 1) return proseTurn(messages, FINAL_TEXT);
				await executeWorkflowDecision(tool, "model-call", { approved: true, summary: "corrected" });
			},
		});

		assert.deepEqual(await ctx.prompt("review the change"), { approved: true, summary: "corrected" });
		assert.equal(prompts.length, 2);
	});

	test("an inference failure no corrective prompt can repair keeps the stage's failure text and carries the typed error (#4565)", async () => {
		const inference = new InferenceRig(() => "provider-failure");
		const { ctx, prompts } = stageOver({ inference, turn: omitTheCall });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(failure);
		assert.equal(isWorkflowStructuredOutputContractError(failure), false);
		assert.equal(prompts.length, 4);
		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.ok(cause);
		assert.equal(cause.code, "auto-inference-failed");
		assert.ok(cause.cause instanceof Error);
		assert.equal(failure.message, cause.cause.message);
	});

	test("a session without a tool context cannot run the inference and goes on to the corrective prompts (#4565)", async () => {
		const { ctx, prompts, inference } = stageOver({ turn: omitTheCall, withToolContext: false });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.ok(isWorkflowStructuredOutputContractError(failure), String(failure));
		assert.equal(prompts.length, 4);
		assert.deepEqual(inference.contextRequests, []);
		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.equal(cause?.code, "tool-context-unavailable");
		assert.equal(cause?.cause, undefined);
		assert.equal(ctx.__modelFallbackMeta().warnings, undefined, "a setup fact, reported by the failure's cause");
	});

	test("a tool context that cannot be made is a typed failure with its cause, not a crash (#4565)", async () => {
		const reason = new Error("extension runner is closed");
		const inference = new InferenceRig();
		inference.contextFailure = reason;
		const { ctx, prompts } = stageOver({ turn: omitTheCall, inference });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		const cause = findWorkflowStructuredOutputInferenceError(failure);
		assert.equal(cause?.code, "tool-context-unavailable");
		assert.equal(cause?.cause, reason);
		assert.equal(prompts.length, 4);
	});

	test("fails over to the next candidate with the original prompt once the automatic inference and the corrective prompts fail (#4565)", async () => {
		const promptsByModel = new Map<string, string[]>();
		const rigs = new Map<string, InferenceRig>([
			["anthropic/primary", new InferenceRig(() => "invalid-answer")],
			["openai/fallback", new InferenceRig()],
		]);
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				const messages = [] as AgentSession["messages"];
				const { session } = makeMockSession({
					messages,
					async prompt(text) {
						promptsByModel.set(model, [...(promptsByModel.get(model) ?? []), text]);
						proseTurn(messages, FINAL_TEXT);
					},
				});
				return rigs.get(model)!.attachTo(session);
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { schema: SCHEMA, model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;

		const result = await ctx.prompt("review the change");

		assert.deepEqual(result, { approved: true, summary: FINAL_TEXT });
		assert.equal(promptsByModel.get("anthropic/primary")?.length, 4);
		assert.deepEqual(promptsByModel.get("openai/fallback"), [sentPrompt("review the change")]);
		assert.equal(rigs.get("anthropic/primary")?.contextRequests.length, 4);
		assert.equal(rigs.get("openai/fallback")?.contextRequests.length, 1);
		assert.deepEqual(
			ctx
				.__modelFallbackMeta()
				.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
	});
});

describe("createStageContext — cancelling a stage during the automatic inference (#4565)", () => {
	test("aborting the stage itself, without the workflow's signal, cancels the inference and fails nothing (#4565)", async () => {
		const inference = new InferenceRig(() => "abort");
		const rig = stageOver({ inference, turn: omitTheCall });
		inference.onAbort = () => void rig.ctx.abort();

		const failure = await rig.ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.equal(failure?.name, "AbortError");
		assert.equal(findWorkflowStructuredOutputInferenceError(failure), undefined);
		assert.equal(rig.prompts.length, 1);
	});

	test("propagates the abort reason, spends no corrective prompt and records no inference failure (#4565)", async () => {
		const controller = new AbortController();
		const reason = new Error("operator cancelled the workflow");
		const inference = new InferenceRig(() => "abort");
		inference.onAbort = () => controller.abort(reason);
		const { ctx, prompts } = stageOver({ inference, turn: omitTheCall, signal: controller.signal });

		const failure = await ctx.prompt("review the change").then(
			() => undefined,
			(error: Error) => error,
		);

		assert.equal(failure, reason);
		assert.equal(findWorkflowStructuredOutputInferenceError(failure), undefined);
		assert.equal(prompts.length, 1);
		assert.equal(ctx.__modelFallbackMeta().warnings, undefined);
	});
});
