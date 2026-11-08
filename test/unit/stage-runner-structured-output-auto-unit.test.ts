import { createStructuredOutputCapture, type ExtensionToolContext } from "@bastani/atomic";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { stageSessionToolContext } from "../../packages/workflows/src/runs/foreground/stage-runner-session.js";
import {
	createStageStructuredOutputTool,
	type StageStructuredOutputTool,
	stageOptionsWithStructuredOutput,
} from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output.js";
import {
	AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS,
	AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES,
	automaticInferenceExecutionFailure,
	automaticStructuredOutputEvidence,
	automaticStructuredOutputInstructions,
	runAutomaticStructuredOutput,
} from "../../packages/workflows/src/runs/foreground/stage-runner-structured-output-auto.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { WorkflowStructuredOutputInferenceError } from "../../packages/workflows/src/shared/structured-output-errors.js";
import { assert } from "./executor-shared.js";
import type { AgentSession } from "./stage-runner-helpers.js";

type Message = AgentSession["messages"][number];

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as Message;
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as Message;
const toolResult = (text: string): Message =>
	({
		role: "toolResult",
		toolCallId: "c",
		toolName: "read",
		content: [{ type: "text", text }],
		timestamp: 0,
	}) as unknown as Message;

describe("automaticStructuredOutputEvidence (#4565)", () => {
	test("takes the last assistant text of the turn as the final answer and the messages before it as the exchange (#4565)", () => {
		const evidence = automaticStructuredOutputEvidence({
			stagePrompt: "review the change",
			messages: [user("review the change"), assistant("reading"), toolResult("file body"), assistant("approved")],
			promptStartIndex: 0,
		});

		assert.deepEqual(evidence, {
			stageTask: "review the change",
			finalAssistantText: "approved",
			recentTranscript: [
				{ role: "user", text: "review the change" },
				{ role: "assistant", text: "reading" },
			],
		});
	});

	test("leaves tool results, other roles, blank messages and thinking out of the exchange (#4565)", () => {
		const custom = { role: "bashExecution", command: "ls", output: "secret", timestamp: 0 } as unknown as Message;
		const thinking = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "private reasoning" }],
			stopReason: "stop",
			timestamp: 0,
		} as unknown as Message;
		const evidence = automaticStructuredOutputEvidence({
			stagePrompt: "task",
			messages: [user("task"), custom, toolResult("tool output"), thinking, user("  \n "), assistant("done")],
			promptStartIndex: 0,
		});

		assert.deepEqual(evidence?.recentTranscript, [{ role: "user", text: "task" }]);
	});

	test("takes the final answer only from the current turn, even when an earlier turn held assistant text (#4565)", () => {
		const messages = [user("task"), assistant("earlier answer"), user("correction"), assistant("   ")];

		assert.equal(
			automaticStructuredOutputEvidence({ stagePrompt: "task", messages, promptStartIndex: 2 }),
			undefined,
		);
		assert.equal(
			automaticStructuredOutputEvidence({ stagePrompt: "task", messages, promptStartIndex: 0 })?.finalAssistantText,
			"earlier answer",
		);
	});

	test("has no evidence when there is no assistant text at all (#4565)", () => {
		assert.equal(
			automaticStructuredOutputEvidence({ stagePrompt: "task", messages: [], promptStartIndex: 0 }),
			undefined,
		);
		assert.equal(
			automaticStructuredOutputEvidence({ stagePrompt: "task", messages: [user("task")], promptStartIndex: 0 }),
			undefined,
		);
	});

	test("keeps a text of exactly the limit whole and both ends of a longer one (#4565)", () => {
		const limit = AUTOMATIC_STRUCTURED_OUTPUT_TEXT_CHARS;
		const exact = "a".repeat(limit);
		const long = `HEAD${"b".repeat(limit)}TAIL`;

		const whole = automaticStructuredOutputEvidence({
			stagePrompt: exact,
			messages: [assistant(exact)],
			promptStartIndex: 0,
		});
		assert.equal(whole?.stageTask, exact);
		assert.equal(whole?.finalAssistantText, exact);

		const cut = automaticStructuredOutputEvidence({
			stagePrompt: long,
			messages: [assistant(long)],
			promptStartIndex: 0,
		});
		for (const text of [cut?.stageTask ?? "", cut?.finalAssistantText ?? ""]) {
			assert.ok(text.startsWith("HEAD"), "keeps the start");
			assert.ok(text.endsWith("TAIL"), "keeps the end");
			assert.ok(text.includes(`[… ${long.length - limit} characters omitted …]`), "counts what it left out");
			assert.equal(text.length, limit + `\n[… ${long.length - limit} characters omitted …]\n`.length);
		}
	});

	test("hands over at most the last few earlier messages, oldest first (#4565)", () => {
		const earlier = Array.from({ length: AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES + 2 }, (_, index) =>
			index % 2 === 0 ? user(`message ${index}`) : assistant(`message ${index}`),
		);

		const evidence = automaticStructuredOutputEvidence({
			stagePrompt: "task",
			messages: [...earlier, assistant("final")],
			promptStartIndex: 0,
		});

		assert.deepEqual(
			evidence?.recentTranscript.map((entry) => entry.text),
			earlier.slice(-AUTOMATIC_STRUCTURED_OUTPUT_TRANSCRIPT_MESSAGES).map(textOf),
		);
		assert.deepEqual(
			evidence?.recentTranscript.map((entry) => entry.role),
			["user", "assistant", "user", "assistant", "user", "assistant"],
		);
	});
});

function textOf(message: Message): string {
	const { content } = message as { content: string | Array<{ text: string }> };
	return typeof content === "string" ? content : (content[0]?.text ?? "");
}

describe("automaticStructuredOutputInstructions (#4565)", () => {
	test("points the inference at the state and names the result schema when it has a title or description (#4565)", () => {
		const bare = automaticStructuredOutputInstructions(Type.Object({ ok: Type.Boolean() }));
		assert.match(bare, /state\.stageTask/);
		assert.match(bare, /state\.finalAssistantText/);
		assert.match(bare, /state\.recentTranscript/);
		assert.match(bare, /do not invent facts/i);
		assert.equal(bare.includes("Result schema:"), false);
		assert.ok(bare.startsWith("Produce the machine-readable result this workflow stage was asked to return"), bare);
		assert.equal(bare.split("\n").length, 3, "three lines of guidance and nothing after them");

		const described = automaticStructuredOutputInstructions(
			Type.Object({ ok: Type.Boolean() }, { title: "Verdict", description: "Whether the change passes." }),
		);
		assert.ok(described.endsWith("\nResult schema: Verdict: Whether the change passes."), described);
		assert.ok(
			automaticStructuredOutputInstructions(Type.Object({}, { description: "Only a description." })).endsWith(
				"\nResult schema: Only a description.",
			),
		);
		assert.equal(
			automaticStructuredOutputInstructions(Type.Object({}, { title: "  " })).includes("Result schema:"),
			false,
		);
	});
});

const FIELDS = { runId: "run", stageId: "stage", stageName: "review", toolCallId: "workflow-auto-structured-output-1" };

function portsOver(overrides: {
	execute?: StageStructuredOutputTool["execute"];
	toolContext?: () => ExtensionToolContext | undefined;
	messages?: Message[];
	signal?: AbortSignal;
}) {
	const calls: unknown[][] = [];
	const context = { marker: "tool-context" } as unknown as ExtensionToolContext;
	const capture = createStructuredOutputCapture<{ ok: boolean }>();
	const toolContextCalls: unknown[][] = [];
	const input = {
		tool: {
			execute:
				overrides.execute ??
				(async (...args: unknown[]) => {
					calls.push(args);
					capture.value = { ok: true };
					capture.called = true;
					return { content: [], details: { ok: true } };
				}),
		} as unknown as StageStructuredOutputTool,
		schema: Type.Object({ ok: Type.Boolean() }),
		capture,
		stagePrompt: "decide",
		messages: overrides.messages ?? [user("decide"), assistant("it is fine")],
		promptStartIndex: 0,
		toolContext:
			overrides.toolContext ??
			((...args: unknown[]) => {
				toolContextCalls.push(args);
				return context;
			}),
		signal: overrides.signal ?? new AbortController().signal,
		fields: FIELDS,
	};
	return { input, calls, context, capture, toolContextCalls };
}

describe("runAutomaticStructuredOutput (#4565)", () => {
	test("runs the stage's tool with the runtime's call id, the instructions and state, the signal and the session's tool context (#4565)", async () => {
		const signal = new AbortController().signal;
		const { input, calls, context, capture, toolContextCalls } = portsOver({ signal });

		const outcome = await runAutomaticStructuredOutput(input);

		assert.deepEqual(outcome, { kind: "captured" });
		assert.deepEqual(toolContextCalls, [[FIELDS.toolCallId, signal]]);
		assert.equal(calls.length, 1);
		const [toolCallId, params, passedSignal, onUpdate, passedContext] = calls[0] as [
			string,
			{ instructions: string; state: Record<string, unknown> },
			AbortSignal,
			unknown,
			unknown,
		];
		assert.equal(toolCallId, FIELDS.toolCallId);
		assert.equal(params.instructions, automaticStructuredOutputInstructions(input.schema));
		assert.deepEqual(params.state, automaticStructuredOutputEvidence(input));
		assert.equal(passedSignal, signal);
		assert.equal(onUpdate, undefined);
		assert.equal(passedContext, context);
		assert.deepEqual(capture.value, { ok: true });
	});

	test("skips the inference, without asking for a tool context, when the turn left no assistant text (#4565)", async () => {
		const { input, calls, toolContextCalls } = portsOver({ messages: [user("decide")] });

		assert.deepEqual(await runAutomaticStructuredOutput(input), { kind: "skipped" });
		assert.equal(calls.length, 0);
		assert.equal(toolContextCalls.length, 0);
	});

	test("fails with tool-context-unavailable when the session offers no tool context (#4565)", async () => {
		const { input, calls } = portsOver({ toolContext: () => undefined });

		const outcome = await runAutomaticStructuredOutput(input);

		assert.equal(outcome.kind, "failed");
		assert.ok(outcome.kind === "failed" && outcome.error instanceof WorkflowStructuredOutputInferenceError);
		assert.equal(outcome.kind === "failed" && outcome.error.code, "tool-context-unavailable");
		assert.deepEqual(outcome.kind === "failed" && outcome.error.fields, FIELDS);
		assert.equal(outcome.kind === "failed" && Object.hasOwn(outcome.error, "cause"), false);
		assert.equal(calls.length, 0);
	});

	test("fails with tool-context-unavailable and the cause when making the tool context throws (#4565)", async () => {
		const reason = new Error("runner closed");
		const { input } = portsOver({
			toolContext: () => {
				throw reason;
			},
		});

		const outcome = await runAutomaticStructuredOutput(input);

		assert.ok(outcome.kind === "failed");
		assert.equal(outcome.error.code, "tool-context-unavailable");
		assert.equal(outcome.error.cause, reason);
	});

	test("fails with auto-inference-failed and the cause when the tool throws (#4565)", async () => {
		const reason = new Error("decision failed");
		const { input, capture } = portsOver({
			execute: async () => {
				throw reason;
			},
		});

		const outcome = await runAutomaticStructuredOutput(input);

		assert.ok(outcome.kind === "failed");
		assert.equal(outcome.error.code, "auto-inference-failed");
		assert.equal(outcome.error.cause, reason);
		assert.equal(capture.called, false);
	});

	test("a failure of the tool after the stage was cancelled is the cancellation, not an inference failure (#4565)", async () => {
		const controller = new AbortController();
		const reason = new Error("stage cancelled");
		const { input } = portsOver({
			execute: async () => {
				controller.abort(reason);
				throw new Error("decision interrupted");
			},
			signal: controller.signal,
		});

		await assert.rejects(runAutomaticStructuredOutput(input), (error) => error === reason);
	});

	test("a tool context that cannot be made because the stage was cancelled is the cancellation (#4565)", async () => {
		const controller = new AbortController();
		const reason = new Error("stage cancelled");
		const { input } = portsOver({
			toolContext: () => {
				controller.abort(reason);
				throw new Error("runner closed");
			},
			signal: controller.signal,
		});

		await assert.rejects(runAutomaticStructuredOutput(input), (error) => error === reason);
	});
});

describe("automaticInferenceExecutionFailure (#4565)", () => {
	const failed = (cause?: unknown) =>
		new WorkflowStructuredOutputInferenceError(
			"auto-inference-failed",
			FIELDS,
			cause === undefined ? undefined : { cause },
		);

	test("is the failure text when no corrective prompt can repair the failure (#4565)", () => {
		assert.equal(
			automaticInferenceExecutionFailure(
				failed(new Error("Decision timed out: no answer within its 1000ms deadline")),
			),
			"Decision timed out: no answer within its 1000ms deadline",
		);
		assert.equal(automaticInferenceExecutionFailure(failed("provider down")), "provider down");
	});

	test("is undefined for a contract failure and for an inference that never started (#4565)", () => {
		assert.equal(
			automaticInferenceExecutionFailure(
				failed(new Error("Invalid structured output: response does not match the decision schema.")),
			),
			undefined,
		);
		assert.equal(automaticInferenceExecutionFailure(failed()), undefined);
	});
});

describe("stageSessionToolContext (#4565)", () => {
	const signal = new AbortController().signal;

	test("asks the session's extension runner for the context of a call, with its id and signal (#4565)", () => {
		const context = { marker: "ctx" } as unknown as ExtensionToolContext;
		const asked: unknown[][] = [];
		const session = {
			extensionRunner: {
				createToolContext(...args: unknown[]) {
					asked.push(args);
					return context;
				},
			},
		} as unknown as StageSessionRuntime;

		assert.equal(stageSessionToolContext(session, "call-1", signal), context);
		assert.deepEqual(asked, [["call-1", signal]]);
	});

	test("has none for a missing session, a session without an extension runner, or a runner that cannot make one (#4565)", () => {
		assert.equal(stageSessionToolContext(undefined, "call-1", signal), undefined);
		assert.equal(stageSessionToolContext({} as StageSessionRuntime, "call-1", signal), undefined);
		assert.equal(
			stageSessionToolContext({ extensionRunner: {} } as unknown as StageSessionRuntime, "call-1", signal),
			undefined,
		);
	});
});

describe("stageOptionsWithStructuredOutput (#4565)", () => {
	const schema = Type.Object({ ok: Type.Boolean() });
	const tool = createStageStructuredOutputTool({ schema }, createStructuredOutputCapture());
	const other = createStageStructuredOutputTool({ schema }, createStructuredOutputCapture());

	test("leaves options without a schema, and a stage without a tool, as they are (#4565)", () => {
		const options = { tools: ["read"] };
		assert.equal(stageOptionsWithStructuredOutput(options, tool), options);
		assert.equal(stageOptionsWithStructuredOutput({ schema, tools: ["read"] }, undefined)?.customTools, undefined);
		assert.equal(stageOptionsWithStructuredOutput(undefined, tool), undefined);
	});

	test("registers the tool after the stage's own custom tools (#4565)", () => {
		const registered = stageOptionsWithStructuredOutput({ schema, customTools: [other] }, tool);

		assert.deepEqual(registered?.customTools, [other, tool]);
		assert.equal(stageOptionsWithStructuredOutput({ schema }, tool)?.customTools?.[0], tool);
	});

	test("adds structured_output once to an explicit allowlist, or alone under noTools all, and leaves the default tool set alone (#4565)", () => {
		assert.deepEqual(stageOptionsWithStructuredOutput({ schema, tools: ["read"] }, tool)?.tools, [
			"read",
			"structured_output",
		]);
		assert.deepEqual(
			stageOptionsWithStructuredOutput({ schema, tools: ["structured_output", "read"] }, tool)?.tools,
			["structured_output", "read"],
		);
		assert.deepEqual(stageOptionsWithStructuredOutput({ schema, noTools: "all" }, tool)?.tools, [
			"structured_output",
		]);
		assert.equal(stageOptionsWithStructuredOutput({ schema }, tool)?.tools, undefined);
	});

	test("never excludes structured_output but keeps every other exclusion (#4565)", () => {
		assert.deepEqual(
			stageOptionsWithStructuredOutput({ schema, excludedTools: ["structured_output", "bash"] }, tool)
				?.excludedTools,
			["bash"],
		);
		assert.equal(stageOptionsWithStructuredOutput({ schema }, tool)?.excludedTools, undefined);
	});
});

describe("createStageStructuredOutputTool (#4565)", () => {
	test("records the call's id and value as the execution snapshot the artifact is paired with (#4565)", async () => {
		const capture = createStructuredOutputCapture<{ ok: boolean }>();
		const execution: { snapshot?: { toolCallId: string; value: { ok: boolean } } } = {};
		const tool = createStageStructuredOutputTool({ schema: Type.Object({ ok: Type.Boolean() }) }, capture, execution);
		const { decisionChatModel, decisionMessage, messageStream } = await import("../helpers/structured-output.js");
		const { toolContext } = await import("../helpers/tool-context.js");
		const context = toolContext({
			model: decisionChatModel,
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: () => messageStream(decisionMessage({ ok: true })),
			},
		} as never);

		await tool.execute("call-7", { instructions: "decide", state: { task: "t" } }, undefined, undefined, context);

		assert.deepEqual(execution.snapshot, { toolCallId: "call-7", value: { ok: true } });
		assert.deepEqual(capture.value, { ok: true });
		assert.equal(capture.called, true);
	});
});
