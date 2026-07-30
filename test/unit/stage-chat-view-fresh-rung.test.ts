/**
 * Attached workflow stage chat must show the fresh rung's degraded notice.
 *
 * `StageChatView` renders through the shared `ChatSessionHost`, so a `fresh`
 * boundary reaches it by the same route as the main chat: `compaction_end`
 * carries `result.rung`, the host synthesizes or refreshes the boundary message,
 * and the shared renderer hands `details.rung` to the boundary component. This
 * regression pins that end to end — the review round could not tell, because no
 * test combined a live stage view with a successful `rung: "fresh"` event.
 */

import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
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

const COMPACTED_TEXT = "[User]: retained\n(filtered 12 lines)";

function compactionEnd(rung: "planned" | "fresh", errorMessage?: string): AgentSessionEvent {
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
				linesDeleted: 12,
				linesKept: 8,
				rangeCount: 1,
				tokensBefore: 51_234,
				tokensAfter: 2_000,
				percentReduction: 96.1,
			},
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "focus" },
			promptVersion: 3,
			rung,
		},
	} as unknown as AgentSessionEvent;
}

describe("StageChatView fresh-rung visibility", () => {
	test("a successful fresh compaction renders the degraded notice", async () => {
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("fresh"));
		await flush();

		const body = rendered(view);
		assert.ok(
			body.includes("✻ Context cleared (compaction degraded)"),
			`attached stage chat hid the fresh notice:\n${body}`,
		);
		assert.ok(!body.includes("✻ Context compacted"), `stage chat also showed the ordinary label:\n${body}`);
		// The collapsed boundary card, not a raw custom-message dump.
		assert.ok(!body.includes(COMPACTED_TEXT), `stage chat rendered the raw compacted body:\n${body}`);
		// The compaction spinner is released once the event lands.
		assert.ok(!body.includes("Auto-compacting"), `the compaction status stayed active:\n${body}`);
	});

	test("a planned compaction keeps the ordinary label in stage chat", async () => {
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("planned"));
		await flush();

		const body = rendered(view);
		assert.ok(body.includes("✻ Context compacted"), `stage chat lost the ordinary label:\n${body}`);
		assert.ok(!body.includes("compaction degraded"), `stage chat showed the degraded notice:\n${body}`);
	});

	test("a committed fresh boundary stays visible when the final gate also errors", async () => {
		// Attached stage chat delegates to the same ChatSessionHost, so the
		// compound result-plus-error event must show both there too.
		const error =
			"Post-tool context remains over the provider hard input limit after compaction (9000 > 8000 tokens); the next provider request was not sent.";
		const { view, emit } = createView(fakeFooterAgentSession(false) as AgentSession);

		emit({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent);
		await flush();
		emit(compactionEnd("fresh", error));
		await flush();

		const body = rendered(view);
		assert.ok(
			body.includes("✻ Context cleared (compaction degraded)"),
			`stage chat hid the committed fresh boundary behind the error:\n${body}`,
		);
		assert.ok(!body.includes("Auto-compacting"), `the compaction status stayed active:\n${body}`);
	});
});
