import { test } from "vitest";
import { WORKING_MESSAGE } from "../helpers/working-line.ts";
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
	["manual", /Compacting context\.\.\. \(\d+s · esc to cancel\)/],
	["threshold", /Auto-compacting\.\.\. \(\d+s · esc to cancel\)/],
	["overflow", /Context overflow detected\. Auto-compacting\.\.\. \(\d+s · esc to cancel\)/],
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
		assert.doesNotMatch(rendered, WORKING_MESSAGE);
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
	assert.doesNotMatch(rendered, /ompacting|to cancel\)/);
	assert.match(rendered, WORKING_MESSAGE);
	reopened.dispose();
});
