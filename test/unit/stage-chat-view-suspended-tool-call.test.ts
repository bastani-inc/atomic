/**
 * The chat of a stage suspended on a tool call shows the call as pending, not as interrupted, and keeps the
 * interrupted result for a stage that really died on it (#4589).
 */
import { afterEach, describe, test, vi } from "vitest";
import {
	assert,
	createStore,
	deriveGraphTheme,
	join,
	makeHandle,
	mkdtempSync,
	SessionManager,
	StageChatView,
	stripAnsi,
	tmpdir,
} from "./stage-chat-view-helpers.js";

const INTERRUPTED = /Tool execution was interrupted after it started/;
const WAIT = {
	kind: "tool",
	since: 1_000,
	toolCalls: [{ toolCallId: "call-1", toolName: "bash" }],
} as const;

const views: StageChatView[] = [];
afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
});

async function chatOfStage(patch: { status: "suspended" | "failed"; wait?: typeof WAIT }): Promise<StageChatView> {
	const manager = await SessionManager.create(process.cwd(), mkdtempSync(join(tmpdir(), "atomic-suspended-chat-")));
	await manager.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 });
	await manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo pending" } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	} as Parameters<SessionManager["appendMessage"]>[0]);
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "test-wf",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("run-1", {
		id: "stage-a",
		name: "review-a",
		status: patch.status,
		parentIds: [],
		toolEvents: [],
		startedAt: 1,
		...(patch.wait === undefined ? {} : { wait: patch.wait }),
	});
	store.recordStageSession("run-1", "stage-a", { sessionId: manager.getSessionId() });
	const view = new StageChatView({
		store,
		sessionStore: manager.getSessionStore(),
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		onDetach: () => {},
		onClose: () => {},
		requestRender: () => {},
	});
	views.push(view);
	return view;
}

const rendered = (view: StageChatView): string => stripAnsi(view.render(96).join("\n"));

describe("the chat of a stage with a tool call pending (#4589)", () => {
	test("a stage suspended on a tool call shows the call as pending, not interrupted (#4589)", async () => {
		const view = await chatOfStage({ status: "suspended", wait: WAIT });

		await vi.waitFor(() => assert.match(rendered(view), /\$ echo pending/));

		assert.doesNotMatch(rendered(view), INTERRUPTED);
	});

	test("a stage that died on the call keeps the interrupted result (#4589)", async () => {
		const view = await chatOfStage({ status: "failed" });

		await vi.waitFor(() => assert.match(rendered(view), INTERRUPTED));
	});

	test("a chat whose stage the store does not hold yet still loads the saved conversation (#4589)", async () => {
		const manager = await SessionManager.create(process.cwd(), mkdtempSync(join(tmpdir(), "atomic-suspended-chat-")));
		await manager.appendMessage({ role: "user", content: [{ type: "text", text: "saved prompt" }], timestamp: 1 });
		const { handle } = makeHandle();
		Object.assign(handle, { sessionId: manager.getSessionId(), sessionStore: manager.getSessionStore() });
		const view = new StageChatView({
			store: createStore(),
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			requestRender: () => {},
		});
		views.push(view);

		await vi.waitFor(() => assert.match(rendered(view), /saved prompt/));
	});
});
