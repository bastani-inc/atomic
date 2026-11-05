import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import {
	AuthStorage,
	ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "../../packages/coding-agent/src/index.js";
import { latestStageSessionCheckpoints } from "../../packages/workflows/src/durable/stage-primitive.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import {
	STAGE_WAIT_RETRY_ATTEMPTS,
	STAGE_WAIT_RETRY_BUDGET_MS,
} from "../../packages/workflows/src/shared/stage-wait.js";
import {
	deserializeStageWaitError,
	isStageRehydrationError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const ANSWER = "ci passed; merging";
/**
 * Structural cost: every attempt runs on the real `AgentSession` runtime, and the two attempts that block wait out the
 * stage's real retry backoff (up to `STAGE_WAIT_RETRY_BUDGET_MS` each) before they end.
 */
const BLOCKED_ATTEMPTS_TIMEOUT_MS = TEST_TIMEOUT_MS + 2 * STAGE_WAIT_RETRY_BUDGET_MS;

/** A session store on a disk that is full while `failedToolResultSaves` lasts: saving a tool result fails. */
class FullDiskSessionStore extends MemorySessionStore {
	/** How many more saves of a tool result fail. */
	failedToolResultSaves = 0;
	/** Thrown instead of the store's own failure, for a fault that is not the store's. */
	failure: (() => Error) | undefined;
	toolResultSaves = 0;

	override async append(
		sessionId: string,
		entries: Parameters<SessionStore["append"]>[1],
		options: Parameters<SessionStore["append"]>[2],
	): Promise<{ readonly lastSeq: number }> {
		if (entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")) {
			this.toolResultSaves += 1;
			if (this.failedToolResultSaves > 0) {
				this.failedToolResultSaves -= 1;
				throw (
					this.failure?.() ??
					new StorageUnavailableError(
						this.descriptor,
						Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
					)
				);
			}
		}
		return super.append(sessionId, entries, options);
	}
}

interface Harness {
	readonly sessionStore: FullDiskSessionStore;
	readonly store: Store;
	/** While set, the sessions the stage opens return from `resumeDetachedTurn` without saving or continuing anything. */
	ignoreResults: boolean;
	/** How many times the detachable tool's work started. */
	toolRuns(): number;
	/** How many times the model was asked. */
	modelRequests(): number;
	attempt(continuation?: { readonly runId: string }): Promise<RunResult>;
	/** The stage's stored conversation: each message as `role` or `role/stopReason`, the system prompt left out. */
	transcript(sessionId: string | undefined): Promise<string[]>;
	/** The calls whose results the stage's latest durable record keeps for a resume. */
	recordedResultIds(runId: string, replayKey: string | undefined): string[];
}

let cwd: string;
let faux: ReturnType<typeof registerFauxProvider>;

beforeEach(() => {
	cwd = makeTempDirectory("atomic-waiting-stage-unsaved-results-");
	faux = registerFauxProvider();
});

afterEach(() => {
	faux.unregister();
	removeTempDirectory(cwd);
});

/** One task on the real SDK session that calls a detachable tool, waits for it released, and answers once it has its result. */
async function harness(): Promise<Harness> {
	const model = faux.getModel();
	faux.setResponses(
		Array.from(
			{ length: 8 },
			() => (context: { messages: readonly { role: string }[] }) =>
				context.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(ANSWER)
					: fauxAssistantMessage([fauxToolCall("wait_for_ci", {})], { stopReason: "toolUse" }),
		),
	);
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
	let toolRuns = 0;
	const waitForCi: ToolDefinition = {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Waits for the CI run of the change",
		parameters: Type.Object({}),
		detachable: true,
		execute: async (): Promise<AgentToolResult> => {
			toolRuns += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { content: [{ type: "text", text: "ci passed" }], details: undefined };
		},
	};
	const sdkAdapter = createAgentSessionAdapter({
		cwd,
		agentDir: join(cwd, "agent"),
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: BUILTINS,
		tools: ["wait_for_ci"],
	});
	const agentSession: NonNullable<StageAdapters["agentSession"]> = {
		async create(...args) {
			const created = await sdkAdapter.create(...args);
			const session = "session" in created ? created.session : created;
			const resume = session.resumeDetachedTurn?.bind(session);
			session.resumeDetachedTurn = async (results) => {
				if (!rig.ignoreResults) await resume?.(results);
			};
			return created;
		},
	};
	const definition = workflow({
		name: "unsaved-tool-result",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("implement", { prompt: "ship the change", customTools: [waitForCi] });
			return {};
		},
	});
	const sessionStore = new FullDiskSessionStore();
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const rig: Harness = {
		sessionStore,
		ignoreResults: false,
		store,
		toolRuns: () => toolRuns,
		modelRequests: () => faux.state.callCount,
		attempt(continuation) {
			const source =
				continuation === undefined
					? undefined
					: store.runs().find((candidate) => candidate.id === continuation.runId);
			return run(
				definition,
				{},
				{
					store,
					durableBackend: backend,
					releaseWhenWaiting: { afterMs: 0 },
					adapters: { sessionStore, agentSession },
					...(source === undefined
						? {}
						: { runId: source.id, continuation: { source, resumeFromStageId: source.failedStageId } }),
				},
			);
		},
		async transcript(sessionId) {
			assert.ok(sessionId !== undefined, "the stage has a session");
			const saved = await sessionStore.load(sessionId);
			return saved.entries.flatMap((entry) => {
				if (entry.type !== "message" || entry.message.role === "system") return [];
				const { message } = entry;
				return [message.role === "assistant" ? `assistant/${message.stopReason}` : message.role];
			});
		},
		recordedResultIds(runId, replayKey) {
			const record = latestStageSessionCheckpoints(backend, runId).get(replayKey ?? "");
			return record?.waitResults?.map((result) => result.toolCallId) ?? [];
		},
	};
	return rig;
}

const COMPLETE_TURN = ["user", "assistant/toolUse", "toolResult", "assistant/stop"];

describe("a waiting stage whose session cannot save the result it was woken with (#4309)", () => {
	test("reopens its session and continues the same turn when the save fails once (#4309)", async () => {
		const rig = await harness();
		rig.sessionStore.failedToolResultSaves = 1;

		const result = await rig.attempt();

		assert.equal(result.status, "completed", result.error);
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "completed");
		assert.equal(stage?.result, ANSWER);
		assert.deepEqual(await rig.transcript(stage?.sessionId), COMPLETE_TURN);
		assert.equal(rig.sessionStore.toolResultSaves, 2);
		assert.equal(rig.toolRuns(), 1);
		assert.equal(rig.modelRequests(), 2);
	});

	test(
		"blocks the run resumably while the store keeps failing, and a resume continues the turn from the recorded result without running the tool again (#4309)",
		async () => {
			const rig = await harness();
			rig.sessionStore.failedToolResultSaves = STAGE_WAIT_RETRY_ATTEMPTS;

			const blocked = await rig.attempt();

			// Blocked, not failed: the stage did not complete on a turn that never got its result.
			assert.equal(blocked.status, "running", blocked.error);
			const source = rig.store.runs().find((candidate) => candidate.id === blocked.runId);
			assert.equal(source?.failureDisposition, "active_blocked");
			assert.equal(source?.failureRecoverability, "recoverable");
			assert.equal(source?.resumable, true);
			const stage = blocked.stages.find((candidate) => candidate.name === "implement");
			assert.notEqual(stage?.status, "completed");
			assert.ok(stage?.failureDetail?.family === "StageWaitError");
			const failure = deserializeStageWaitError(stage.failureDetail);
			assert.ok(isStageRehydrationError(failure));
			assert.equal(failure.code, "session-unavailable");
			assert.equal(failure.retryable, true);
			assert.equal(failure.fields.phase, "resume-turn");
			assert.equal(failure.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
			assert.equal(failure.fields.timeoutMs, STAGE_WAIT_RETRY_BUDGET_MS);
			assert.equal(typeof failure.fields.elapsedMs, "number");
			assert.equal((failure.cause as Error).name, "StorageUnavailableError");
			assert.equal(rig.sessionStore.toolResultSaves, STAGE_WAIT_RETRY_ATTEMPTS);
			assert.deepEqual(await rig.transcript(stage.sessionId), ["user", "assistant/toolUse"]);

			// The store is still full when the run is resumed: the resumed stage blocks again and keeps the result.
			rig.sessionStore.failedToolResultSaves = STAGE_WAIT_RETRY_ATTEMPTS;
			const blockedAgain = await rig.attempt({ runId: blocked.runId });
			assert.equal(blockedAgain.status, "running", blockedAgain.error);
			assert.equal(rig.sessionStore.toolResultSaves, 2 * STAGE_WAIT_RETRY_ATTEMPTS);

			const resumed = await rig.attempt({ runId: blocked.runId });

			assert.equal(resumed.status, "completed", resumed.error);
			const completed = resumed.stages.find((candidate) => candidate.name === "implement");
			assert.equal(completed?.result, ANSWER);
			assert.equal(completed?.sessionId, stage.sessionId);
			assert.deepEqual(await rig.transcript(completed?.sessionId), COMPLETE_TURN);
			// The tool ran once in all, and the model was asked once for the call and once for the answer.
			assert.equal(rig.toolRuns(), 1);
			assert.equal(rig.modelRequests(), 2);
		},
		BLOCKED_ATTEMPTS_TIMEOUT_MS,
	);

	test("a failure that is not the store's fails the stage with its own classification and is not tried again (#4309)", async () => {
		const rig = await harness();
		rig.sessionStore.failedToolResultSaves = 1;
		rig.sessionStore.failure = () => new Error("tool result rejected by a session store hook");

		const result = await rig.attempt();

		assert.equal(result.status, "failed");
		const stage = result.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "failed");
		assert.equal(stage?.failureDetail, undefined);
		assert.match(stage?.error ?? "", /tool result rejected by a session store hook/);
		assert.equal(rig.sessionStore.toolResultSaves, 1);
		assert.equal(rig.toolRuns(), 1);
	});

	test("a stage whose session returns without saving the results fails with results-not-saved rather than completing on the pending call, and keeps them recorded (#4309)", async () => {
		const rig = await harness();
		rig.ignoreResults = true;

		const failed = await rig.attempt();

		assert.equal(failed.status, "failed");
		const source = rig.store.runs().find((candidate) => candidate.id === failed.runId);
		assert.equal(source?.resumable, true);
		const stage = failed.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.status, "failed");
		assert.ok(stage?.failureDetail?.family === "StageWaitError");
		const failure = deserializeStageWaitError(stage.failureDetail);
		assert.ok(isStageRehydrationError(failure));
		assert.equal(failure.code, "results-not-saved");
		assert.equal(failure.retryable, false);
		assert.equal(failure.fields.runId, failed.runId);
		assert.equal(failure.fields.sessionId, stage.sessionId);
		assert.equal(failure.fields.phase, "resume-turn");
		assert.deepEqual(await rig.transcript(stage?.sessionId), ["user", "assistant/toolUse"]);
		const recorded = rig.recordedResultIds(failed.runId, stage?.replayKey);
		assert.equal(recorded.length, 1);
		assert.deepEqual(failure.fields.toolCallIds, recorded);

		rig.ignoreResults = false;
		const resumed = await rig.attempt({ runId: failed.runId });

		assert.equal(resumed.status, "completed", resumed.error);
		const completed = resumed.stages.find((candidate) => candidate.name === "implement");
		assert.equal(completed?.result, ANSWER);
		assert.deepEqual(await rig.transcript(completed?.sessionId), COMPLETE_TURN);
		assert.equal(rig.toolRuns(), 1);
	});

	test("a resume continues the turn from the result the failed attempt recorded, not from the pending call (#4309)", async () => {
		const rig = await harness();
		rig.sessionStore.failedToolResultSaves = 1;
		rig.sessionStore.failure = () => new Error("tool result rejected by a session store hook");
		const failed = await rig.attempt();
		assert.equal(failed.status, "failed");
		const stage = failed.stages.find((candidate) => candidate.name === "implement");
		assert.deepEqual(await rig.transcript(stage?.sessionId), ["user", "assistant/toolUse"]);

		const resumed = await rig.attempt({ runId: failed.runId });

		assert.equal(resumed.status, "completed", resumed.error);
		const completed = resumed.stages.find((candidate) => candidate.name === "implement");
		assert.equal(completed?.result, ANSWER);
		assert.deepEqual(await rig.transcript(completed?.sessionId), COMPLETE_TURN);
		assert.equal(rig.toolRuns(), 1);
		assert.equal(rig.modelRequests(), 2);
	});
});
