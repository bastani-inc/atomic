/**
 * `/tree` in a workflow stage chat moves the stage session's leaf. Without a summary the move is recorded in the
 * session, so the stage reopens on the selected branch, and fork points and run forks use that branch (#3325).
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { forkRun, listForkPoints } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import {
	scanInFlightRuns,
	type SessionEntry as WorkflowSessionEntry,
} from "../../packages/workflows/src/shared/persistence-restore.js";
import { appendRunEnd, appendRunStart } from "../../packages/workflows/src/shared/persistence-session-entries.js";
import { forkStageSession } from "../../packages/workflows/src/shared/stage-session-store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const WORDS = ["alpha", "beta", "gamma", "delta"];

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

async function fauxStageAdapter(cwd: string) {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	faux.setResponses(WORDS.map((word) => fauxAssistantMessage(word)));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	const agentSession = createAgentSessionAdapter({
		cwd,
		agentDir: join(cwd, "agent"),
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: BUILTINS,
		tools: [],
	});
	return { faux, agentSession };
}

function messageText(entry: SessionEntry, role: "user" | "assistant"): string | undefined {
	if (entry.type !== "message" || entry.message.role !== role) return undefined;
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const replyText = (entry: SessionEntry): string | undefined => messageText(entry, "assistant");

function conversation(manager: SessionManager): string[] {
	return manager.buildContextEntries().flatMap((entry) =>
		(["user", "assistant"] as const).flatMap((role) => {
			const text = messageText(entry, role);
			return text === undefined ? [] : [`${role}: ${text}`];
		}),
	);
}

/** The session's entries as the workflows extension reads them on `session_start` to find its in-flight runs. */
const workflowEntries = (manager: SessionManager) => manager.getEntries() as readonly WorkflowSessionEntry[];

const FIRST_TWO_TURNS = [
	"user: Reply with exactly: alpha",
	"assistant: alpha",
	"user: Reply with exactly: beta",
	"assistant: beta",
];

test("/tree in a workflow stage chat reopens on the selected branch, and fork points and run forks use it (#3325)", async () => {
	const cwd = makeTempDirectory("atomic-3325-stage-tree-");
	const sessionStore = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
	const { faux, agentSession } = await fauxStageAdapter(cwd);
	const backend = await createMemoryTestBackend();
	const def = workflow({
		name: "stage-tree-navigation",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("chat").prompt("Reply with exactly: alpha");
			await ctx.stage("next").complete("after the chat");
			return {};
		},
	});
	const adapters = {
		sessionStore,
		agentSession,
		complete: { complete: async (text: string) => text },
	};
	const registry = createStageControlRegistry();
	try {
		const store = createStore();
		const result = await run(
			def,
			{},
			{ cwd, adapters, store, durableBackend: backend, stageControlRegistry: registry },
		);
		assert.equal(result.status, "completed", result.error);
		const chatStage = store.runs()[0]!.stages.find((stage) => stage.name === "chat")!;
		const sessionId = chatStage.sessionId!;

		// The user continues the finished stage's chat, then goes back to the second reply with `/tree`.
		const chat = await ensurePostMortemStageHandle(result.runId, chatStage, { registry, adapters, cwd });
		assert.ok(chat.ok);
		await chat.handle.ensureAttached();
		for (const word of WORDS.slice(1)) await chat.handle.prompt(`Reply with exactly: ${word}`);
		const stageSession = chat.handle.agentSession;
		assert.ok(stageSession);
		const selectedId = stageSession.sessionManager.getEntries().find((entry) => replyText(entry) === "beta")?.id;
		assert.ok(selectedId, "the stage chat has the reply to its second turn");
		const moved = await stageSession.navigateTree(selectedId, { summarize: false });
		assert.equal(moved.cancelled, false);
		await registry.clear();

		const reopened = await SessionManager.open(sessionStore, sessionId);
		assert.equal(reopened.getLeafId(), selectedId, "the stage chat reopens where /tree left it");
		assert.deepEqual(conversation(reopened), FIRST_TWO_TURNS);

		const points = [];
		for await (const point of listForkPoints(result.runId, {
			durableBackend: backend,
			sourceSessionStore: sessionStore,
		}))
			points.push(point);
		const chatPoint = points.find((point) => point.stagePath === "chat");
		assert.equal(chatPoint?.entryId, selectedId, "the fork point names the entry the stage continues from");

		const atPoint = await forkStageSession(sessionStore, sessionId, cwd, {}, sessionStore, chatPoint.entryId);
		assert.deepEqual(conversation(atPoint), FIRST_TWO_TURNS);

		const forked = await forkRun(result.runId, {
			fromStage: "next",
			durableBackend: backend,
			definition: def,
			store: createStore(),
			cwd,
			adapters,
			sourceSessionStore: sessionStore,
		});
		const forkedResult = await forked.result;
		assert.equal(forkedResult.status, "completed", forkedResult.error);
		const copiedChat = backend
			.listCheckpoints(forked.runId)
			.find((checkpoint) => checkpoint.kind === "stage" && checkpoint.name === "chat");
		assert.ok(copiedChat?.kind === "stage" && copiedChat.sessionId, "the fork copied the chat stage's session");
		assert.notEqual(copiedChat.sessionId, sessionId);
		const copied = await SessionManager.open(sessionStore, copiedChat.sessionId);
		assert.equal(copied.getLeafId(), selectedId, "the run fork's copy reopens on the selected branch");
		assert.deepEqual(conversation(copied), FIRST_TWO_TURNS);
	} finally {
		await registry.clear();
		await sessionStore.close();
		faux.unregister();
		removeTempDirectory(cwd);
	}
});

test("a workflow run started on a branch that /tree abandons stays listed until it ends, also after reopening (#3325)", async () => {
	const cwd = makeTempDirectory("atomic-3325-abandoned-run-");
	const sessionStore = new MemorySessionStore();
	const manager = await SessionManager.create(sessionStore, cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager: SettingsManager.inMemory(),
		sessionManager: manager,
		builtins: BUILTINS,
	});
	const persistence = {
		appendEntry: (type: string, payload: Record<string, unknown>) => manager.appendCustomEntry(type, payload),
		setLabel: async (entryId: string, label: string) => {
			await manager.appendLabelChange(entryId, label);
		},
	};
	try {
		await manager.appendMessage({ role: "user", content: "Reply with exactly: alpha", timestamp: 1 });
		await manager.appendMessage(fauxAssistantMessage("alpha"));
		const selectedId = manager.getLeafId()!;
		await manager.appendMessage({ role: "user", content: "Start the workflow", timestamp: 2 });
		await appendRunStart(persistence, {
			runId: "run-on-abandoned-branch",
			name: "abandoned",
			inputs: {},
			modelOwner: "session",
			ts: 3,
		});

		await session.navigateTree(selectedId, { summarize: false });
		const reopened = await SessionManager.open(sessionStore, manager.getSessionId());
		assert.equal(reopened.getLeafId(), selectedId);
		assert.deepEqual(
			scanInFlightRuns(workflowEntries(reopened)).map((run) => run.runId),
			["run-on-abandoned-branch"],
			"the run is still in flight and listed for this session, whichever branch is current",
		);

		// The run ends while the session is on the selected branch; that ends it for the whole session.
		await appendRunEnd(persistence, { runId: "run-on-abandoned-branch", status: "completed", ts: 4 });
		const afterEnd = await SessionManager.open(sessionStore, manager.getSessionId());
		assert.deepEqual(scanInFlightRuns(workflowEntries(afterEnd)), []);
		assert.equal(afterEnd.getLeafEntry()?.parentId, selectedId, "the end was recorded on the selected branch");
	} finally {
		await session.dispose();
		removeTempDirectory(cwd);
	}
});
