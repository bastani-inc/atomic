import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const EMPTY_REPORT = { replayed: 0, dropped: 0, completions: 0, notices: [] };

function recordingAdapter(order: string[], expectedSessionId?: string): AgentSessionAdapter {
	return {
		async create(options) {
			if (expectedSessionId !== undefined) assert.equal(options.sessionManager?.getSessionId(), expectedSessionId);
			const { session } = makeMockSession({
				async startPendingRecovery(reason) {
					order.push(`recovery:${reason}`);
					return EMPTY_REPORT;
				},
				async prompt(text: string) {
					order.push(`prompt:${text}`);
				},
			});
			return session;
		},
	};
}

test("a resumed workflow stage recovers its children and deliveries before its continuation prompt (#3760)", async () => {
	const store = new MemorySessionStore();
	const interrupted = await SessionManager.create(store, process.cwd());
	await interrupted.appendMessage({ role: "user", content: "lane work", timestamp: Date.now() });
	const order: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession: recordingAdapter(order, interrupted.getSessionId()) },
			stageOptions: {
				sessionStore: store,
				resumeFromSessionId: interrupted.getSessionId(),
				durableReplayKey: "stage:lane:1",
			},
		}),
	);
	await ctx.prompt("continue");
	assert.deepEqual(order, ["recovery:workflow_stage_resume", "prompt:continue"]);
});

test("reopening a completed stage for post-mortem chat does not restart its stopped work (#3760)", async () => {
	const store = new MemorySessionStore();
	const completed = await SessionManager.create(store, process.cwd());
	await completed.appendMessage({ role: "user", content: "lane work", timestamp: Date.now() });
	const order: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession: recordingAdapter(order, completed.getSessionId()) },
			stageOptions: { sessionStore: store, resumeFromSessionId: completed.getSessionId() },
		}),
	);
	await ctx.prompt("what did you change?");
	assert.deepEqual(order, ["prompt:what did you change?"]);
});

test("a fresh workflow stage starts without session recovery (#3760)", async () => {
	const order: string[] = [];
	const ctx = createStageContext(makeOpts({ adapters: { agentSession: recordingAdapter(order) } }));
	await ctx.prompt("start");
	assert.deepEqual(order, ["prompt:start"]);
});
