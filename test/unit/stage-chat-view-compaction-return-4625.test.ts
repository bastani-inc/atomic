import { test } from "vitest";
import {
	type AgentSessionEvent,
	assert,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

type CompactionReason = "manual" | "threshold" | "overflow";

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

const labels: ReadonlyArray<readonly [CompactionReason, RegExp]> = [
	["manual", /Compacting context\.\.\. \(esc Cancel\)/],
	["threshold", /Auto-compacting\.\.\. \(esc Cancel\)/],
	["overflow", /Context overflow detected\. Auto-compacting\.\.\. \(esc Cancel\)/],
];

test("#4625: a stage chat reopened from another view mid-compaction shows the indicator and cancel hint", () => {
	for (const [reason, label] of labels) {
		const agentSession = Object.assign(fakeFooterAgentSession(true), {
			compactionReason: reason,
			isCompacting: true,
		});
		const { handle, state, emit } = makeHandle(undefined, [], "running", agentSession);
		state.isStreaming = true;

		const first = mountStageChat(handle);
		emit({ type: "compaction_start", reason } as unknown as AgentSessionEvent);
		assert.match(stripAnsi(first.render(96).join("\n")), label, `${reason}: live`);
		first.dispose();

		const reopened = mountStageChat(handle);
		const rendered = stripAnsi(reopened.render(96).join("\n"));
		assert.match(rendered, label, `${reason}: after the round trip`);
		assert.doesNotMatch(rendered, /Working\.\.\./);
		reopened.dispose();
	}
});

test("#4625: a stage chat reopened after its compaction ended in another view shows no stale indicator", () => {
	const agentSession = Object.assign(fakeFooterAgentSession(true), {
		compactionReason: "threshold" as CompactionReason | undefined,
		isCompacting: true,
	});
	const { handle, state, emit } = makeHandle(undefined, [], "running", agentSession);
	state.isStreaming = true;

	const first = mountStageChat(handle);
	emit({ type: "compaction_start", reason: "threshold" } as unknown as AgentSessionEvent);
	assert.match(stripAnsi(first.render(96).join("\n")), /Auto-compacting\.\.\./);
	first.dispose();

	agentSession.isCompacting = false;
	agentSession.compactionReason = undefined;
	const reopened = mountStageChat(handle);

	const rendered = stripAnsi(reopened.render(96).join("\n"));
	assert.doesNotMatch(rendered, /ompacting|\(esc Cancel\)/);
	assert.match(rendered, /Working\.\.\./);
	reopened.dispose();
});
