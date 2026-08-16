import { describe } from "vitest";
import {
	type AgentSession,
	assert,
	type CreateAgentSessionOptions,
	createStore,
	mockSession,
	RESUME_CONTINUATION_PROMPT,
	run,
	type StageSessionRuntime,
	type ToolDefinition,
	Type,
	test,
	workflow,
} from "./executor-shared.js";

/**
 * A resume continuation must not erase a stage result the stage already
 * finalized as structured output.
 *
 * The reported order: a `user-feedback` stage emitted a labeled report, a
 * queued user message was consumed inside that turn, and the executor injected
 * `Continue where you left off...`. The later unlabeled wrap-up became the
 * stage result, and the workflow read approval out of the replacement.
 * `skipResumeContinuationInjection()` returns true once
 * `__structuredOutputFinalized()` does, which is the guard that closes the
 * displacement window for a stage with a declared schema.
 * cross-ref: issue #2401.
 */

const LABELED_REPORT = ["user_notes:", "- The hero background is too busy."].join("\n");
const CONTINUATION_WRAP_UP = "All set — the live review session is closed and the preview is ready.";
const QUEUED_USER_MESSAGE = "one more thing: keep the tighter density";
const FEEDBACK_SCHEMA = Type.Object(
	{ decision: Type.String(), user_notes: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const FEEDBACK_PAYLOAD = { decision: "revise", user_notes: ["The hero background is too busy."] };

type SessionEvent = { type: string; [key: string]: unknown };

/**
 * A feedback session that consumes a queued user message inside its turn, which
 * is what arms the resume continuation. With a declared schema it also
 * finalizes `structured_output` before that happens.
 */
function liveReviewSession(input: {
	readonly options: CreateAgentSessionOptions;
	readonly promptCalls: string[];
}): StageSessionRuntime {
	const listeners = new Set<(event: SessionEvent) => void>();
	const messages: AgentSession["messages"] = [] as AgentSession["messages"];
	let lastAssistantText = "";
	const structuredTool = input.options.customTools?.find(
		(tool): tool is ToolDefinition => tool.name === "structured_output",
	);
	const emit = (event: SessionEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	const emitUserMessage = (text: string): void =>
		emit({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		});
	const pushAssistant = (text: string): void => {
		lastAssistantText = text;
		messages.push({ role: "assistant", content: [{ type: "text", text }] } as AgentSession["messages"][number]);
	};

	return {
		...mockSession(),
		async prompt(text: string) {
			input.promptCalls.push(text);
			emit({ type: "agent_start" });
			emitUserMessage(text);
			if (text === RESUME_CONTINUATION_PROMPT) {
				pushAssistant(CONTINUATION_WRAP_UP);
				emit({ type: "agent_end", messages: [] });
				return;
			}
			pushAssistant(LABELED_REPORT);
			if (structuredTool) {
				const result = await structuredTool.execute(
					"structured-call",
					FEEDBACK_PAYLOAD as Parameters<ToolDefinition["execute"]>[1],
					undefined,
					undefined,
					{} as Parameters<ToolDefinition["execute"]>[4],
				);
				emit({
					type: "tool_execution_end",
					toolCallId: "structured-call",
					toolName: "structured_output",
					result,
				});
				messages.push({
					role: "toolResult",
					toolCallId: "structured-call",
					toolName: "structured_output",
					content: result.content,
				} as AgentSession["messages"][number]);
			}
			// The user's queued message is consumed inside this turn: the executor
			// arms a resume continuation for exactly this shape.
			emitUserMessage(QUEUED_USER_MESSAGE);
			emit({ type: "agent_end", messages: [] });
		},
		subscribe(listener) {
			listeners.add(listener as (event: SessionEvent) => void);
			return () => {
				listeners.delete(listener as (event: SessionEvent) => void);
			};
		},
		get messages() {
			return messages;
		},
		getLastAssistantText() {
			return lastAssistantText;
		},
	};
}

async function runLiveReview(input: { readonly name: string; readonly schema: boolean }): Promise<{
	readonly promptCalls: readonly string[];
	readonly stageResult: string | undefined;
	readonly status: string;
}> {
	const promptCalls: string[] = [];
	const store = createStore();
	const definition = workflow({
		name: input.name,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx
				.stage("user-feedback-1", input.schema ? { schema: FEEDBACK_SCHEMA } : {})
				.prompt("run the live review");
			return {};
		},
	});
	const execution = await run(
		definition,
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create(options: CreateAgentSessionOptions) {
						return liveReviewSession({ options, promptCalls });
					},
				},
			},
		},
	);
	return { promptCalls, stageResult: store.runs()[0]?.stages[0]?.result, status: execution.status };
}

describe("executor — a resume continuation cannot erase a finalized structured result (#2401)", () => {
	test("a schema-backed stage keeps the answer it finalized", async () => {
		const observed = await runLiveReview({ name: "structured-live-review", schema: true });

		assert.equal(observed.status, "completed");
		// The continuation prompt is never injected: the stage already finalized
		// its structured answer, so there is nothing left to continue.
		assert.deepEqual(observed.promptCalls, ["run the live review"]);
		assert.equal(observed.promptCalls.includes(RESUME_CONTINUATION_PROMPT), false);
		assert.equal(observed.stageResult, JSON.stringify(FEEDBACK_PAYLOAD, null, 2));
		assert.equal(observed.stageResult?.includes(CONTINUATION_WRAP_UP), false);
	});

	test("the same turn without a declared schema is the reported displacement", async () => {
		// The control: identical session, no schema. The continuation runs and its
		// short wrap-up becomes the stage result — which is why the feedback stage
		// declares a schema rather than trusting its final prose. Runtime
		// result-selection for plain-text stages is deliberately unchanged.
		const observed = await runLiveReview({ name: "plain-live-review", schema: false });

		assert.equal(observed.status, "completed");
		assert.deepEqual(observed.promptCalls, ["run the live review", RESUME_CONTINUATION_PROMPT]);
		assert.equal(observed.stageResult, CONTINUATION_WRAP_UP);
	});
});
