import { describe, test } from "vitest";
import {
	type AgentSession,
	type AgentSessionEvent,
	assert,
	createStore,
	deriveGraphTheme,
	flush,
	makeHandle,
	type StageChatSendUserMessageCall,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

function stageChatViewOpts(store: ReturnType<typeof createStore>, handle: ReturnType<typeof makeHandle>["handle"]) {
	return {
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
	};
}

describe("StageChatView", () => {
	test("Enter names steering so an admission-owned turn cannot demote it to a follow-up", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const sendUserMessageCalls: Array<StageChatSendUserMessageCall> = [];
		// The handle reads idle here exactly as it does in the admission tail race
		// the user hits: the chat takes its prompt branch while workflow admission
		// still owns the retiring turn.
		const { handle, state } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: false,
			sendUserMessageCalls,
		});
		const view = new StageChatView(stageChatViewOpts(store, handle));
		for (const ch of "redirect") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(sendUserMessageCalls, [{ text: "redirect", deliverAs: "steer" }]);
		assert.deepEqual(state.promptCalls, []);
		assert.deepEqual(state.followUpCalls, []);
		view.dispose();
	});

	test("Enter falls back to prompt on a handle without the admission-aware send", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle, state } = makeHandle();
		const view = new StageChatView(stageChatViewOpts(store, handle));
		for (const ch of "start here") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(state.promptCalls, ["start here"]);
		view.dispose();
	});

	test("reattaching rehydrates the stage queue without a concrete AgentSession", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		// No `agentSession`: an adapter-backed runtime that only publishes ordinary
		// `queue_update` events must still get its rows back on reattach.
		const { handle, emit } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: true,
		});
		assert.equal(handle.agentSession, undefined);
		const attached = new StageChatView(stageChatViewOpts(store, handle));
		emit({
			type: "queue_update",
			steering: ["redirect", "redirect"],
			followUp: ["afterwards"],
		} as unknown as AgentSessionEvent);
		assert.match(stripAnsi(attached.render(96).join("\n")), /Steering: redirect/);
		// Detach: the host that owned the display is destroyed, the queue is not.
		attached.dispose();

		const reattached = new StageChatView(stageChatViewOpts(store, handle));
		const rendered = stripAnsi(reattached.render(96).join("\n"));
		// Duplicates are preserved verbatim, in their submitted order.
		assert.equal(rendered.match(/Steering: redirect/g)?.length, 2);
		assert.match(rendered, /Follow-up: afterwards/);

		emit({ type: "queue_update", steering: [], followUp: [] } as unknown as AgentSessionEvent);
		const drained = stripAnsi(reattached.render(96).join("\n"));
		assert.doesNotMatch(drained, /Steering: redirect/);
		assert.doesNotMatch(drained, /Follow-up: afterwards/);
		reattached.dispose();
	});

	test("a slow streaming ctrl+f cannot demote a later idle Enter to a follow-up", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const sendUserMessageCalls: Array<StageChatSendUserMessageCall> = [];
		const { handle, state } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: true,
			sendUserMessageCalls,
		});
		// The streaming follow-up path can await session attachment or creation,
		// so hold it open across the next submission instead of using a timer.
		let releaseFollowUp = (): void => {};
		const followUpEntered = new Promise<void>((resolveEntered) => {
			handle.followUp = async (text: string) => {
				state.followUpCalls.push(text);
				resolveEntered();
				await new Promise<void>((resolveGate) => {
					releaseFollowUp = resolveGate;
				});
			};
		});
		const view = new StageChatView(stageChatViewOpts(store, handle));

		for (const ch of "after this turn") view.handleInput(ch);
		view.handleInput("\x06");
		await followUpEntered;
		assert.deepEqual(state.followUpCalls, ["after this turn"]);

		// The stage stops streaming while that follow-up is still in flight.
		state.isStreaming = false;
		for (const ch of "redirect now") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();

		assert.deepEqual(sendUserMessageCalls, [{ text: "redirect now", deliverAs: "steer" }]);
		releaseFollowUp();
		await flush();
		view.dispose();
	});

	test("streaming Enter queues steering without clearing the live transcript", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle, state, emit } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: true,
		});
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});

		emit({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial answer" }],
			},
		} as unknown as AgentSessionEvent);

		for (const ch of "redirect") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();

		assert.deepEqual(state.steerCalls, ["redirect"]);
		assert.equal(state.promptCalls.length, 0);
		assert.equal(
			view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"),
			false,
		);
		assert.equal(view._transcript.at(-1)?.role, "assistant");
		assert.equal(view._transcript.at(-1)?.text, "partial answer");

		emit({
			type: "queue_update",
			steering: ["redirect"],
			followUp: [],
		} as unknown as AgentSessionEvent);
		assert.match(stripAnsi(view.render(96).join("\n")), /Steering: redirect/);

		emit({
			type: "message_update",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial answer continued" }],
			},
		} as unknown as AgentSessionEvent);
		assert.equal(view._transcript.at(-1)?.role, "assistant");
		assert.equal(view._transcript.at(-1)?.text, "partial answer continued");
		assert.equal(
			view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"),
			false,
		);

		emit({
			type: "queue_update",
			steering: [],
			followUp: [],
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_start",
			message: { role: "user", content: "redirect" },
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_end",
			message: { role: "user", content: "redirect" },
		} as unknown as AgentSessionEvent);
		assert.equal(view._transcript.filter((entry) => entry.role === "user" && entry.text === "redirect").length, 1);
		assert.doesNotMatch(stripAnsi(view.render(96).join("\n")), /Steering: redirect/);
		view.dispose();
	});

	test("streaming Enter uses AgentSession prompt steering when available", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const promptCalls: Array<{
			text: string;
			streamingBehavior: "steer" | "followUp" | undefined;
		}> = [];
		const agentSession = {
			isStreaming: true,
			prompt: async (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
				promptCalls.push({
					text,
					streamingBehavior: options?.streamingBehavior,
				});
			},
		} as unknown as AgentSession;
		const { handle, state } = makeHandle(
			{
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: true,
			},
			[],
			"running",
			agentSession,
		);
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		for (const ch of "redirect") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(promptCalls, [{ text: "redirect", streamingBehavior: "steer" }]);
		assert.deepEqual(state.steerCalls, []);
		assert.deepEqual(state.promptCalls, []);
		assert.equal(
			view._transcript.some((entry) => entry.role === "user" && entry.text === "redirect"),
			false,
		);
		view.dispose();
	});

	test("streaming UI state steers even if the handle has not caught up", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle, state, emit } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: false,
		});
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		emit({ type: "agent_start" } as unknown as AgentSessionEvent);
		for (const ch of "redirect") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(state.steerCalls, ["redirect"]);
		assert.deepEqual(state.promptCalls, []);
		view.dispose();
	});

	test("ctrl+f variants submit normally while idle like the main chat", async () => {
		const ctrlFVariants = ["\x06", "\x1b[102;5u", "\x1b[102;5:1u", "\x1b[27;5;102~"];

		for (const key of ctrlFVariants) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const { handle, state } = makeHandle();
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {},
				onClose: () => {},
			});
			for (const ch of "afterwards") view.handleInput(ch);
			view.handleInput(key);
			await flush();
			await flush();
			assert.deepEqual(state.promptCalls, ["afterwards"], JSON.stringify(key));
			assert.deepEqual(state.followUpCalls, [], JSON.stringify(key));
			view.dispose();
		}
	});

	test("ctrl+f variants stay a follow-up on the admission-aware send path", async () => {
		const ctrlFVariants = ["\x06", "\x1b[102;5u", "\x1b[102;5:1u", "\x1b[27;5;102~"];

		for (const key of ctrlFVariants) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const sendUserMessageCalls: Array<StageChatSendUserMessageCall> = [];
			const { handle, state } = makeHandle({
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: false,
				sendUserMessageCalls,
			});
			const view = new StageChatView(stageChatViewOpts(store, handle));
			for (const ch of "afterwards") view.handleInput(ch);
			view.handleInput(key);
			await flush();
			await flush();
			assert.deepEqual(sendUserMessageCalls, [{ text: "afterwards", deliverAs: "followUp" }], JSON.stringify(key));
			assert.deepEqual(state.promptCalls, [], JSON.stringify(key));
			view.dispose();
		}
	});

	test("ctrl+f reaches the follow-up queue on a compatibility handle the view reads as idle", async () => {
		const store = createStore();
		// The stage has gone terminal while its handle still streams the retiring
		// turn, so the chat takes its idle prompt branch. That is the same window
		// Enter's explicit steering covers; ctrl+f must keep its own queue in it.
		setupRun(store, "run-1", "stage-a", "completed");
		const { handle, state } = makeHandle(
			{
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: true,
			},
			[],
			"completed",
		);
		assert.equal(handle.sendUserMessage, undefined);
		const view = new StageChatView(stageChatViewOpts(store, handle));
		for (const ch of "afterwards") view.handleInput(ch);
		view.handleInput("\x06");
		await flush();
		await flush();
		assert.deepEqual(state.followUpCalls, ["afterwards"]);
		assert.deepEqual(state.promptCalls, []);
		view.dispose();
	});

	test("ctrl+f variants queue a follow-up while streaming", async () => {
		const ctrlFVariants = ["\x06", "\x1b[102;5u", "\x1b[102;5:1u", "\x1b[27;5;102~"];

		for (const key of ctrlFVariants) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const { handle, state } = makeHandle({
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: true,
			});
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {},
				onClose: () => {},
			});
			for (const ch of "afterwards") view.handleInput(ch);
			view.handleInput(key);
			await flush();
			await flush();
			assert.deepEqual(state.followUpCalls, ["afterwards"], JSON.stringify(key));
			assert.deepEqual(state.promptCalls, [], JSON.stringify(key));
			view.dispose();
		}
	});

	test("Escape pauses a pending streaming stage without making it read-only", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle, state } = makeHandle(
			{
				promptCalls: [],
				steerCalls: [],
				followUpCalls: [],
				pauseCalls: 0,
				resumeCalls: [],
				isStreaming: true,
			},
			[],
			"pending",
		);
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		view.handleInput("\x1b");
		await flush();
		await flush();
		assert.equal(state.pauseCalls, 1);
		assert.equal(view._isLocalPaused, false);
		const rendered = stripAnsi(view.render(96).join("\n"));
		assert.doesNotMatch(rendered, /READ-ONLY SESSION/);
		assert.match(rendered, /❯/);
		view.dispose();
	});

	test("Enter on an initially paused stage resumes with the typed message", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "paused");
		const { handle, state } = makeHandle(undefined, [], "paused");
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		for (const ch of "go on") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(state.resumeCalls, ["go on"]);
		assert.deepEqual(state.promptCalls, []);
		assert.deepEqual(state.steerCalls, []);
		view.dispose();
	});
});
