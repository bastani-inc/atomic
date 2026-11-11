import assert from "node:assert/strict";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@bastani/pi-ai/compat";
import { getModel } from "@bastani/pi-ai/compat";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	WorkflowRunControl,
	WorkflowRunDetail,
	WorkflowRunSummary,
} from "../src/core/extensions/workflow-run-control.js";
import { convertToLlm } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionStore,
} from "../src/core/storage/session/types.js";
import { createHistoryRouter, type ProjectHistory } from "../src/core/tools/history-protocol.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createPlannerStreamFn } from "./structured-planner-test-helpers.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

export interface StoreBackend {
	readonly name: string;
	open(dir: string): Promise<{ store: SessionStore; close(): Promise<void> }>;
}

export const SESSION_STORES: readonly StoreBackend[] = [
	{
		name: "SQLite",
		open: async (dir) => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			const store = await SqlSessionStore.open(database);
			return {
				store,
				close: async () => {
					await store.close();
					await database.close();
				},
			};
		},
	},
	{
		name: "JSONL",
		open: async (dir) => {
			const store = await JsonlSessionStore.open(join(dir, "jsonl"));
			return { store, close: () => store.close() };
		},
	},
];

export const CYCLE_ONE_DECISION = "Decision: the zebra_cache_eviction bug comes from the ttl_sweeper_v2 timer";
export const OTHER_SESSION_FINDING =
	"Earlier finding: ttl_sweeper_v2 evicts zebra_cache_eviction entries whenever the clock skews";
export const STAGE_FINDING = "Stage result: zebra_cache_eviction reproduced only after the ttl_sweeper_v2 timer fired";
export const RUN_ERROR = "ttl_sweeper_v2 timer crashed while zebra_cache_eviction ran";
export const RUN_ERROR_LINE = `error: ${RUN_ERROR}`;
export const KEPT_NOTE = "Kept note: the ttl_sweeper_v2 timer and zebra_cache_eviction stay in scope";
export const LATEST_REQUEST =
	"Why does the zebra_cache_eviction regression return after the ttl_sweeper_v2 timer fires?";
export const FOLLOW_UP_REQUEST =
	"Does the zebra_cache_eviction regression still show after the ttl_sweeper_v2 timer fix?";

const DAY = 86_400_000;
export const OTHER_SESSION_ID = "other-session-4568";
export const STAGE_SESSION_ID = "stage-session-4568";
export const RUN_ID = "run-4568";

export function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function filler(label: string): string {
	return Array.from({ length: 24 }, (_, index) => `${label} filler line ${index} ${"lorem ipsum ".repeat(18)}`).join(
		"\n",
	);
}

export function firstCycleMessages(): Message[] {
	return [
		{ role: "user", content: `task 0\n${CYCLE_ONE_DECISION}\n${filler("first")}`, timestamp: 1 },
		assistantMessage("answer 0", 2),
		{ role: "user", content: "task 1", timestamp: 3 },
		assistantMessage("answer 1", 4),
		{ role: "user", content: "task 2", timestamp: 5 },
		assistantMessage("answer 2", 6),
	];
}

export function secondCycleMessages(): Message[] {
	return [
		{ role: "user", content: `task 3\n${KEPT_NOTE}\n${filler("second")}`, timestamp: 7 },
		assistantMessage("answer 3", 8),
		{ role: "user", content: LATEST_REQUEST, timestamp: 9 },
		assistantMessage("answer 4", 10),
	];
}

export function thirdCycleMessages(): Message[] {
	return [
		{ role: "user", content: `task 5\n${filler("third")}`, timestamp: 11 },
		assistantMessage("answer 5", 12),
		{ role: "user", content: FOLLOW_UP_REQUEST, timestamp: 13 },
		assistantMessage("answer 6", 14),
	];
}

function storeHeader(id: string, cwd: string, createdAt: number, workflow = false): SessionRecordHeader {
	return {
		id,
		version: SESSION_FORMAT_VERSION,
		createdAt: new Date(createdAt).toISOString(),
		cwd,
		...(workflow
			? { internal: true as const, workflow: { runId: RUN_ID, stageId: "stage-1", stageName: "investigate" } }
			: {}),
	};
}

function messageEntry(id: string, message: Message, at: number): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date(at).toISOString(), message };
}

export const BASE_TIME = Date.parse("2026-10-01T00:00:00.000Z");

export async function seedOtherHistory(store: SessionStore, cwd: string): Promise<void> {
	await store.create(storeHeader(OTHER_SESSION_ID, cwd, BASE_TIME), [
		messageEntry("o1", { role: "user", content: "look into the cache", timestamp: BASE_TIME + 1 }, BASE_TIME + 1),
		messageEntry("o2", assistantMessage(OTHER_SESSION_FINDING, BASE_TIME + 2), BASE_TIME + 2),
	]);
	await store.create(storeHeader(STAGE_SESSION_ID, cwd, BASE_TIME + DAY, true), [
		messageEntry(
			"s1",
			{ role: "user", content: "investigate the stage", timestamp: BASE_TIME + DAY + 1 },
			BASE_TIME + DAY + 1,
		),
		messageEntry("s2", assistantMessage(STAGE_FINDING, BASE_TIME + DAY + 2), BASE_TIME + DAY + 2),
	]);
}

export function workflowRunControl(
	stageSessionIds: () => readonly string[] = () => [STAGE_SESSION_ID],
): WorkflowRunControl {
	const summary: WorkflowRunSummary = {
		runId: RUN_ID,
		name: "investigate-cache",
		status: "failed",
		startedAt: BASE_TIME + DAY,
		elapsedMs: 1000,
		activeStages: [],
		awaitingInputCount: 0,
		awaitingInput: [],
	};
	const detail: WorkflowRunDetail = {
		runId: RUN_ID,
		name: "investigate-cache",
		status: "failed",
		startedAt: BASE_TIME + DAY,
		inputs: { topic: "cache eviction" },
		stages: [],
		error: RUN_ERROR,
	};
	const unsupported = async (): Promise<never> => {
		throw new Error("unused");
	};
	return {
		listRuns: async () => [summary],
		getRun: async (runId) => {
			if (runId !== RUN_ID) throw new Error(`no such run ${runId}`);
			return {
				...detail,
				stages: stageSessionIds().map((sessionId, index) => ({
					id: `stage-${index + 1}`,
					name: "investigate",
					status: "completed" as const,
					sessionId,
				})),
			};
		},
		getStages: unsupported,
		pause: unsupported,
		quit: unsupported,
		resume: unsupported,
		waitForSettled: async () => {},
	};
}

export interface CompactingSession {
	readonly session: AgentSession;
	readonly manager: SessionManager;
}

export interface CompactingSessionOptions {
	readonly store: SessionStore;
	readonly cwd: string;
	readonly plannerResponses: readonly string[];
	readonly internal?: boolean;
	readonly settings?: Parameters<typeof SettingsManager.inMemory>[0];
	readonly workflows?: WorkflowRunControl;
	/** The launching session's history, for a session started as a workflow stage or a subagent. */
	readonly inheritedHistory?: ProjectHistory;
}

export async function createCompactingSession(options: CompactingSessionOptions): Promise<CompactingSession> {
	const faux = createPlannerStreamFn([...options.plannerResponses]);
	const streamFn: StreamFn = faux.streamFn;
	const manager = await SessionManager.create(options.store, options.cwd);
	if (options.internal) {
		await manager.markSessionInternal({ runId: RUN_ID, stageId: "stage-compacting", stageName: "compacting" });
	}
	const agent = new Agent({
		getApiKey: () => undefined,
		initialState: { model: getModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "test", tools: [] },
		streamFn,
	});
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const workflows = options.workflows;
	const extensionsResult = workflows
		? await createTestExtensionsResult([(pi) => void pi.registerWorkflowRunControl(workflows)], options.cwd)
		: undefined;
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(options.settings),
		cwd: options.cwd,
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : {}),
		...(options.inheritedHistory ? { inheritedHistory: options.inheritedHistory } : {}),
	});
	return { session, manager };
}

export async function appendMessages(compacting: CompactingSession, messages: readonly Message[]): Promise<void> {
	for (const message of messages) await compacting.manager.appendMessage(message);
	compacting.session.agent.state.messages = compacting.manager.buildSessionContext().messages;
}

export async function compactOnce(compacting: CompactingSession): Promise<string> {
	return (await compacting.session.compact({ preserve_recent: 2 })).compactedText;
}

export function boundaryText(session: AgentSession): string {
	const [first] = convertToLlm(session.sessionManager.buildSessionContext().messages);
	assert.equal(first?.role, "user");
	assert.ok(typeof first?.content !== "string");
	return first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

/** `search` and `read` exactly as the agent calls them in `session`, with the session's own history router. */
export function historyTools(session: AgentSession, cwd: string, workflows: WorkflowRunControl | undefined) {
	const router = createHistoryRouter({
		cwd,
		currentSessionId: session.sessionId,
		sessionStore: () => session.sessionManager.getSessionStore(),
		workflows: () => workflows,
	});
	const ctx = { internalResourceRouter: router, cwd } as InternalResourceContext;
	return {
		search: async (pattern: string, paths: string) =>
			toolText(
				await createSearchToolDefinition(cwd).execute(
					"search",
					{ pattern, paths },
					undefined,
					undefined,
					ctx as never,
				),
			),
		read: async (path: string) =>
			toolText(await createReadToolDefinition(cwd).execute("read", { path }, undefined, undefined, ctx as never)),
	};
}

export const RECALLED_CONTEXT_HEADING = "Recalled context";

/** The `Recalled context` section of a compacted text: its heading line through its last snippet line. */
export function recalledSection(compactedText: string): string[] {
	const lines = compactedText.split("\n");
	const start = lines.findIndex((line) => line.startsWith(RECALLED_CONTEXT_HEADING));
	if (start < 0) return [];
	const end = lines.findIndex((line, index) => index > start && line === "");
	return lines.slice(start, end < 0 ? undefined : end);
}

/** The compacted text with its `Recalled context` section removed. */
export function withoutRecalledSection(compactedText: string): string {
	const section = recalledSection(compactedText);
	return section.length === 0 ? compactedText : compactedText.replace(`\n\n${section.join("\n")}`, "");
}

export function recalledSources(compactedText: string): string[] {
	return recalledSection(compactedText).filter((line) => /^history:\/\/\S+:\d+-\d+$/.test(line));
}

export function recalledLines(compactedText: string): string[] {
	return recalledSection(compactedText)
		.filter((line) => line.startsWith("> "))
		.map((line) => line.slice(2));
}

/** A store whose `load` rejects once armed, to show that failed history reads never fail compaction. */
export function failingLoadStore(store: SessionStore): { store: SessionStore; arm(): void } {
	let armed = false;
	const proxy = new Proxy(store, {
		get(target, property) {
			if (property === "load") {
				return async (sessionId: string) => {
					if (armed) throw new Error("history store unavailable");
					return target.load(sessionId);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		store: proxy,
		arm: () => {
			armed = true;
		},
	};
}
