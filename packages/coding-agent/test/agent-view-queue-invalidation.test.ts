import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { taskFixture, taskValue } from "../../../test/helpers/task-projection.js";
import {
	SUBAGENT_CHILD_RECORD_TYPE,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../subagents/src/runs/foreground/subagent-child-records.js";
import { controlSubagentChildren } from "../../subagents/src/runs/foreground/subagent-run-control.js";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { createEventBus } from "../src/core/event-bus.js";
import type { ExtensionContext, ExtensionUIContext } from "../src/core/extensions/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { setExtensionRuntimeEventBus } from "../src/core/extensions/loader-core.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { dismissedAgentPanelItems, notifyAgentPanelChanged } from "../src/core/tasks/agent-panel-source.ts";
import type { OperationId } from "../src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import type { TaskTranscriptSource } from "../src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../src/core/tasks/task-view-source.js";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.ts";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.ts";
import { bindEngineAgentView } from "../src/modes/rpc/agent-view-rpc.ts";

type InvalidationMessage = Extract<InteractiveEngineMessage, { type: "engine_agent_queue_invalidated" }>;

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function createEngineFixture(options: { readonly sessionFile?: string } = {}) {
	initTheme("dark");
	const fixture = taskFixture();
	await fixture.start("Investigate the queue");
	const sessionManager = SessionManager.inMemory();
	const sessionId = sessionManager.getSessionId();
	const sessionFile = options.sessionFile ?? `/tmp/${sessionId}.jsonl`;
	await sessionManager.appendMessage({ role: "user", content: "initial launch task", timestamp: 1 });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const sentByOtherPath: string[] = [];
	let running = true;
	let cleared = 0;
	const transcript: TaskTranscriptSource = Object.assign(sessionManager, {
		getSessionFile: () => sessionFile,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isRunning: () => running,
		pauseTurn: async () => {
			running = false;
			return { steering: [], followUp: [] };
		},
		clearQueue: async () => {
			cleared++;
			return { steering: [], followUp: [] };
		},
		queueMessage: async (text: string) => {
			sentByOtherPath.push(text);
			return { delivered: true as const };
		},
	});
	fixture.runners[0]!.context.bindTranscript(transcript);
	const taskId = fixture.store.tasks[0]!.ref.taskId;

	const messages: InteractiveEngineMessage[] = [];
	const customUi = new EngineCustomUiService(() => {}, new KeybindingsManager());
	const ownerSession = {} as AgentSession;
	bindOwnerTaskStore(ownerSession, fixture.store);
	const unbind = bindEngineAgentView({
		session: ownerSession,
		send: (message) => messages.push(message),
		customUi,
		ui: {
			getChatRenderSettings: () => ({}),
			getFooterDataProvider: () => undefined,
			notify: () => {},
		} as unknown as ExtensionUIContext,
	});
	await flush();

	return {
		fixture,
		taskId,
		sessionId,
		sessionFile,
		ownerSession,
		source: ownerTaskViewSource(fixture.store),
		messages,
		invalidations: (): InvalidationMessage[] =>
			messages.filter((m): m is InvalidationMessage => m.type === "engine_agent_queue_invalidated"),
		emitChildEvent: (event: AgentSessionEvent) => {
			for (const listener of [...listeners]) listener(event);
		},
		stopChildRunning: () => {
			running = false;
		},
		clearedCount: () => cleared,
		sentByOtherPath,
		async dispose() {
			unbind();
			customUi.dispose();
			await fixture.dispose();
		},
	};
}

let active: Awaited<ReturnType<typeof createEngineFixture>> | undefined;
beforeEach(() => {
	initTheme("dark");
});
afterEach(async () => {
	await active?.dispose();
	active = undefined;
});

describe("engine-side child queue invalidation notices", () => {
	test("emits stopped when a subagent is paused or cancelled", async () => {
		active = await createEngineFixture();
		const paused = await active.source.pauseTask?.(active.taskId);
		assert.equal(paused?.ok, true);
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "stopped" && m.sessionId === active!.sessionId && m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);
	});

	test("emits cleared when a subagent's queue is cleared or it is dismissed from the panel", async () => {
		active = await createEngineFixture();
		const cleared = await active.source.clearTaskQueue?.(active.taskId);
		assert.equal(cleared?.ok, true);
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "cleared" && m.sessionId === active!.sessionId && m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);

		active.messages.length = 0;
		dismissedAgentPanelItems(active.ownerSession).add(`task:${active.taskId}`);
		notifyAgentPanelChanged(active.ownerSession);
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "cleared" && m.sessionId === active!.sessionId && m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);
	});

	test("emits session-ended when a subagent settles non-resumably (read-only)", async () => {
		active = await createEngineFixture();
		active.stopChildRunning();
		await active.fixture.settle();
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "session-ended" &&
						m.sessionId === active!.sessionId &&
						m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);
	});

	test("emits sent-elsewhere on external send or intercom delivery while closed, but not on automatic restart resume note", async () => {
		active = await createEngineFixture();
		// Automatic crash recovery emits a restart resume note: must NOT invalidate pending restore.
		active.emitChildEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "subagent-resume-note",
				content: "Atomic restarted while you were working.",
				display: true,
				details: { kind: "restart" },
				timestamp: 2,
			},
		} as AgentSessionEvent);
		await flush();
		assert.deepEqual(active.invalidations(), [], "automatic crash recovery note must not drop pending restore");

		// Intercom message delivered while closed -> sent-elsewhere.
		active.emitChildEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "intercom_message",
				content: "peer update",
				display: true,
				timestamp: 3,
			},
		} as AgentSessionEvent);
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "sent-elsewhere" &&
						m.sessionId === active!.sessionId &&
						m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);

		// sendTaskMessage while closed -> sent-elsewhere.
		active.messages.length = 0;
		await active.source.sendTaskMessage?.(active.taskId, "follow up from another path", "steer");
		await flush();
		assert.ok(
			active
				.invalidations()
				.some(
					(m) =>
						m.reason === "sent-elsewhere" &&
						m.sessionId === active!.sessionId &&
						m.sessionFile === active!.sessionFile,
				),
			JSON.stringify(active.invalidations()),
		);
	});

	test("emits sent-elsewhere when a resumed attempt binds its session asynchronously after launch", async () => {
		active = await createEngineFixture();
		active.messages.length = 0;
		const resumedSession = SessionManager.inMemory();
		const resumedId = resumedSession.getSessionId();
		const resumedFile = `/tmp/${resumedId}.jsonl`;
		// Admit a resumed task before its transcript session is bound, then bind it afterwards.
		const lease = taskValue(
			await active.fixture.supervisor.startAgentTask(
				active.fixture.owner,
				{ kind: "agent", agent: "worker", task: "Resumed follow-up" },
				"run-1:0:resume:late-bind" as OperationId,
			),
		);
		taskValue(await active.fixture.supervisor.initialObservation(lease, { kind: "background" }));
		active.fixture.store.drain();
		await flush();
		assert.deepEqual(active.invalidations(), [], "unbound resumed task emits nothing until its sessionId is known");

		const transcript: TaskTranscriptSource = Object.assign(resumedSession, {
			getSessionFile: () => resumedFile,
			isRunning: () => true,
		});
		active.fixture.runners.at(-1)!.context.bindTranscript(transcript);
		active.fixture.store.drain();
		await flush();
		assert.ok(
			active
				.invalidations()
				.some((m) => m.reason === "sent-elsewhere" && m.sessionId === resumedId && m.sessionFile === resumedFile),
			JSON.stringify(active.invalidations()),
		);
	});

	test("handles an OwnerTaskStore bound without a supervisor without throwing WeakMap TypeError", async () => {
		const messages: InteractiveEngineMessage[] = [];
		const customUi = new EngineCustomUiService(() => {}, new KeybindingsManager());
		const ownerSession = {} as AgentSession;
		bindOwnerTaskStore(ownerSession, {
			tasks: [],
			backgroundTasks: [],
			ownerTasks: [],
			ownerBackgroundTasks: [],
			settlementOrder: new Map(),
			panelRevision: 1,
			taskRecord: () => undefined,
			recentActivity: () => [],
			activityOmitted: () => false,
			subscribe: () => () => {},
		} as never);
		const unbind = bindEngineAgentView({
			session: ownerSession,
			send: (message) => messages.push(message),
			customUi,
			ui: {
				getChatRenderSettings: () => ({}),
				getFooterDataProvider: () => undefined,
				notify: () => {},
			} as unknown as ExtensionUIContext,
		});
		try {
			await flush();
			assert.deepEqual(messages, []);
		} finally {
			unbind();
			customUi.dispose();
		}
	});

	test("emits stopped when subagent quit/pause stops an already-released idle child (stopIdleChild)", async () => {
		const eventBus = createEventBus();
		const runtime = createExtensionRuntime();
		setExtensionRuntimeEventBus(runtime, eventBus);
		const ownerSessionManager = SessionManager.inMemory();
		const ownerSessionId = ownerSessionManager.getSessionId();
		const releasedSessionId = "released-child-session-1";
		const releasedSessionFile = "/tmp/released-child-session-1.jsonl";
		const releasedRecord: SubagentChildRecord = {
			version: 1,
			childId: "run-rel:0",
			runId: "run-rel",
			index: 0,
			agent: "worker",
			state: "terminal",
			terminalStatus: SUBAGENT_CHILD_RELEASED_STATUS,
			cwd: "/tmp",
			owner: { kind: "session", sessionId: ownerSessionId },
			taskId: "task-rel-1",
			childSessionId: releasedSessionId,
			childSessionFile: releasedSessionFile,
			intercomTarget: "subagent-worker-rel",
			waitingOn: [{ toolCallId: "call-1", toolName: "bash" }],
		};
		await ownerSessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, releasedRecord);

		const messages: InteractiveEngineMessage[] = [];
		const customUi = new EngineCustomUiService(() => {}, new KeybindingsManager());
		const ownerSession = {
			resourceLoader: { getExtensions: () => ({ runtime }) },
		} as unknown as AgentSession;
		const unbind = bindEngineAgentView({
			session: ownerSession,
			send: (message) => messages.push(message),
			customUi,
			ui: {
				getChatRenderSettings: () => ({}),
				getFooterDataProvider: () => undefined,
				notify: () => {},
			} as unknown as ExtensionUIContext,
		});
		try {
			const result = await controlSubagentChildren(
				{
					config: {},
					discoverAgents: () => ({ agents: [], diagnostics: [] }),
					runtime: {} as never,
					pi: {
						events: eventBus,
						appendEntry: async (customType, data) => {
							await ownerSessionManager.appendCustomEntry(customType, data);
						},
						getSessionName: () => undefined,
					},
				},
				{
					cwd: "/tmp",
					sessionManager: ownerSessionManager,
					hasUI: false,
				} as unknown as ExtensionContext,
				{ action: "quit", id: "run-rel:0" },
			);
			assert.notEqual(result.isError, true, JSON.stringify(result));
			await flush();
			const invalidations = messages.filter(
				(m): m is InvalidationMessage => m.type === "engine_agent_queue_invalidated",
			);
			assert.ok(
				invalidations.some(
					(m) =>
						m.reason === "stopped" && m.sessionId === releasedSessionId && m.sessionFile === releasedSessionFile,
				),
				JSON.stringify(invalidations),
			);
		} finally {
			unbind();
			customUi.dispose();
		}
	});
});
