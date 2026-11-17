/**
 * Attached workflow stage chat shows the same compaction boundary line as the main chat.
 *
 * `StageChatView` renders through the shared `ChatSessionHost`, so a boundary reaches it by the
 * same route as the main chat: `compaction_end` carries `result.form`, the host synthesizes or
 * refreshes the boundary message, and the shared renderer draws the boundary component.
 */

import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import { VERBATIM_COMPACTION_PROMPT_VERSION } from "../../packages/coding-agent/src/core/compaction/index.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	flush,
	makeHandle,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

function createView(agentSession: AgentSession) {
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "running");
	const runtime = makeHandle(undefined, [], "running", agentSession);
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: runtime.handle,
		onDetach: () => {},
		onClose: () => {},
	});
	return { view, ...runtime };
}

function rendered(view: StageChatView): string {
	return stripAnsi(view.render(96).join("\n"));
}

const COMPACTED_TEXT =
	"Context cleared. Your earlier conversation (51,234 tokens) is no longer in your context window.";

function compactionEnd(form: "cleared" | "compacted", errorMessage?: string): AgentSessionEvent {
	return {
		type: "compaction_end",
		reason: "threshold",
		aborted: false,
		willRetry: false,
		...(errorMessage === undefined ? {} : { errorMessage }),
		result: {
			compactedText: COMPACTED_TEXT,
			firstKeptEntryId: null,
			tokensBefore: 51_234,
			stats: {
				linesBefore: 20,
				linesDeleted: 20,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 51_234,
				tokensAfter: 2_000,
				percentReduction: 96.1,
			},
			parameters: { query: "focus" },
			promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
			form,
			...(form === "compacted" ? { backend: "compactor" as const, model: "morph/morph-compactor" } : {}),
		},
	};
}

describe("StageChatView compaction boundary", () => {
	test("a cleared context renders one boundary line in stage chat", async () => {
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("cleared"));
		await flush();

		const body = rendered(view);
		assert.ok(body.includes("⚛ Context cleared · 51.2k tokens"), `stage chat hid the boundary:\n${body}`);
		assert.ok(!body.includes("degraded"), `stage chat showed a degraded state:\n${body}`);
		// The collapsed boundary card, not a raw custom-message dump.
		assert.ok(!body.includes(COMPACTED_TEXT), `stage chat rendered the raw boundary body:\n${body}`);
		assert.ok(!body.includes("Auto-compacting"), `the compaction status stayed active:\n${body}`);
	});

	test("a compactor boundary names the model in stage chat", async () => {
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("compacted"));
		await flush();

		const body = rendered(view);
		assert.ok(
			body.includes("⚛ Context compacted · morph/morph-compactor · 51.2k → 2.0k tokens"),
			`stage chat lost the compactor label:\n${body}`,
		);
	});

	test("a committed boundary stays visible when the final gate also errors", async () => {
		const error =
			"Post-tool context remains over the provider hard input limit after compaction (9000 > 8000 tokens); the next provider request was not sent.";
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("cleared", error));
		await flush();

		const body = rendered(view);
		assert.ok(
			body.includes("⚛ Context cleared · 51.2k tokens"),
			`stage chat hid the boundary behind the error:\n${body}`,
		);
		assert.ok(!body.includes("Auto-compacting"), `the compaction status stayed active:\n${body}`);
	});
});
