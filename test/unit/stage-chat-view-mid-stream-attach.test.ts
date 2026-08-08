/**
 * Attaching a stage chat to a session that is already mid-stream.
 *
 * `message_update` carries only a delta since streaming updates went
 * delta-only, so a chat mounted part-way through a turn sees neither the
 * `message_start` that opened the message nor the deltas that already went
 * past. The text the stage streamed before the user opened its chat therefore
 * has to come from the live session, and the deltas that arrive afterwards
 * have to continue that same message instead of starting a second one.
 *
 * The provider's own partial is off limits while that happens: pi-agent-core
 * emits `{ ...partial }` for `message_start`, whose `content` array is the one
 * pi-ai keeps appending to, so a consumer that assembles deltas into it writes
 * every delta on top of the provider's own accumulation.
 *
 * cross-ref: test/integration/workflow-stage-steering-queue-cli.test.ts
 */

import { describe, test } from "vitest";
import {
	type AgentSession,
	type AgentSessionEvent,
	assert,
	assistantTextMessage,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

/** A live session holding one in-flight assistant message, as pi reports it. */
function sessionStreaming(message: AgentSession["messages"][number] | undefined): AgentSession {
	return {
		...fakeFooterAgentSession(true),
		agent: { state: { streamingMessage: message } },
	} as unknown as AgentSession;
}

function streamingHandleState() {
	return {
		promptCalls: [],
		steerCalls: [],
		followUpCalls: [],
		pauseCalls: 0,
		resumeCalls: [],
		isStreaming: true,
	};
}

function mountStageChat(handle: ReturnType<typeof makeHandle>["handle"]): StageChatView {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	return new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
	});
}

describe("StageChatView attached mid-stream", () => {
	test("renders the assistant text the stage streamed before the chat was opened", () => {
		const { handle, emit } = makeHandle(
			streamingHandleState(),
			[],
			"running",
			sessionStreaming(assistantTextMessage("issue-2074 stage is mid-turn")),
		);
		const view = mountStageChat(handle);

		assert.match(stripAnsi(view.render(96).join("\n")), /issue-2074 stage is mid-turn/);

		// The heartbeat delta of a held-open turn carries no text; it must not
		// replace what the session already streamed.
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " and still going" },
		} as unknown as AgentSessionEvent);

		assert.match(stripAnsi(view.render(96).join("\n")), /issue-2074 stage is mid-turn and still going/);
		view.dispose();
	});

	test("assembles split deltas before message_end without writing into the provider's partial", () => {
		const { handle, emit } = makeHandle(streamingHandleState(), [], "running", sessionStreaming(undefined));
		const view = mountStageChat(handle);
		const partial = assistantTextMessage("") as AgentSession["messages"][number] & {
			content: Array<{ type: "text"; text: string }>;
		};
		partial.content.length = 0;

		// pi-agent-core copies the message but not its content array, so the
		// consumer is handed the array pi-ai is still appending to.
		emit({ type: "message_start", message: { ...partial } } as unknown as AgentSessionEvent);
		partial.content.push({ type: "text", text: "" });
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		} as unknown as AgentSessionEvent);
		for (const delta of ["split ", "deltas"]) {
			partial.content[0]!.text += delta;
			emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			} as unknown as AgentSessionEvent);
		}

		const rendered = stripAnsi(view.render(96).join("\n"));
		assert.match(rendered, /split deltas/);
		assert.doesNotMatch(rendered, /split split/);
		assert.equal(partial.content[0]?.text, "split deltas");
		view.dispose();
	});
});
