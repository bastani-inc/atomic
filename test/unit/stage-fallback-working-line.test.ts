import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageTurnStart } from "../../packages/workflows/src/runs/foreground/stage-turn-start.js";
import {
	openPooledStageHandle,
	type PooledStageTransport,
} from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { WorkerStageWatches } from "../../packages/workflows/src/workers/stage-watch.js";
import type { PooledStageWatchMessage, WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { sleep } from "../helpers/runtime.js";
import {
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assert,
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
} from "./stage-runner-helpers.js";

const PRIMARY = "anthropic/primary";
const FALLBACK = "openai/fallback";

let now = 0;
beforeEach(() => {
	initTheme("dark");
	now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function modelOf(options: { model?: unknown }): string {
	const model = options.model as string | { provider?: string; id?: string } | undefined;
	return typeof model === "string" ? model : `${String(model?.provider)}/${model?.id}`;
}

/**
 * A stage whose primary model answers its request with `404 model not found` after `primaryMs`, and whose fallback
 * model answers after `fallbackMs`. `fallbackUnavailable` fails the fallback's first session before any request;
 * `holdFallback` holds the fallback's request, streaming, until it settles.
 */
function stageWithFallback(options: {
	primaryMs: number;
	fallbackMs: number;
	fallbackUnavailable?: boolean;
	holdFallback?: Promise<void>;
	/** Real time each request waits after it starts, so a local worker's watch sends its start then. */
	settleStartMs?: number;
	/** Holds the creation of the fallback model's session until it settles. */
	holdFallbackSession?: Promise<void>;
	/** Holds the failed primary's shutdown before the fallback session can be created. */
	holdPrimaryShutdown?: Promise<void>;
	/** The primary's session retries its failed request once, after a wait that holds until this settles. */
	primaryRetryWait?: Promise<void>;
}) {
	const primaryWaiting = Promise.withResolvers<void>();
	const primaryRetiring = Promise.withResolvers<void>();
	const fallbackCreating = Promise.withResolvers<void>();
	let fallbackSessions = 0;
	const fallbackStreaming = Promise.withResolvers<void>();
	const agentSession: AgentSessionAdapter = {
		async create(createOptions) {
			const model = modelOf(createOptions);
			if (model === FALLBACK && options.holdFallbackSession !== undefined) {
				fallbackCreating.resolve();
				await options.holdFallbackSession;
			}
			if (model === FALLBACK && (fallbackSessions++ === 0 && options.fallbackUnavailable) === true)
				throw new Error("Unknown model: openai/fallback is unavailable");
			const messages: AgentSession["messages"] = [];
			let streaming = false;
			const { session, emit } = makeMockSession({
				messages,
				async prompt(text) {
					streaming = true;
					emit({ type: "agent_start" });
					// A session saves the prompt's message and says so, as a real session does.
					const prompt = {
						role: "user",
						content: String(text),
						timestamp: now,
					} as AgentSession["messages"][number];
					messages.push(prompt);
					emit({ type: "message_start", message: prompt });
					emit({ type: "message_end", message: prompt });
					emit({ type: "turn_start" });
					if (options.settleStartMs !== undefined) await sleep(options.settleStartMs);
					if (model === FALLBACK && options.holdFallback !== undefined) {
						emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: now } });
						fallbackStreaming.resolve();
						await options.holdFallback;
					}
					if (model === PRIMARY && options.primaryRetryWait !== undefined) {
						// The session's own retry: the first request fails, and the turn waits to send it again.
						now += options.primaryMs;
						messages.push({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "529 overloaded_error: Overloaded",
							timestamp: now,
						} as unknown as AgentSession["messages"][number]);
						streaming = false;
						emit({ type: "agent_end", messages: [] });
						emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 1_000, errorMessage: "529" });
						Object.assign(session, { retryAttempt: 1 });
						primaryWaiting.resolve();
						await options.primaryRetryWait;
						Object.assign(session, { retryAttempt: 0 });
						streaming = true;
						emit({ type: "agent_start" });
						emit({ type: "turn_start" });
					}
					if (model === PRIMARY) {
						now += options.primaryMs;
						messages.push({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "404 model not found",
							timestamp: now,
						} as unknown as AgentSession["messages"][number]);
					} else {
						now += options.fallbackMs;
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "Fixed the picker." }],
							stopReason: "stop",
							usage: {
								input: 100,
								output: 200,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 300,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: now,
						} as unknown as AgentSession["messages"][number]);
					}
					streaming = false;
					emit({ type: "agent_end", messages: [] });
					// Out of retries, the session says so; the stage then moves the request to its next model.
					if (model === PRIMARY && options.primaryRetryWait !== undefined)
						emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "404 model not found" });
				},
				getLastAssistantText() {
					return model === FALLBACK ? "Fixed the picker." : undefined;
				},
			});
			if (model === PRIMARY && options.holdPrimaryShutdown) {
				Object.assign(session, {
					extensionRunner: {
						hasHandlers: (name: string) => name === "session_shutdown",
						async emit() {
							primaryRetiring.resolve();
							await options.holdPrimaryShutdown;
						},
					},
				});
			}
			return Object.defineProperty(session, "isStreaming", { get: () => streaming, configurable: true });
		},
	};
	const ctx = createStageContext(
		makeOpts({ adapters: { agentSession }, stageOptions: { model: PRIMARY, fallbackModels: [FALLBACK] } }),
	) as InternalStageContext;
	// The stage's control handle, which the stage chat and a local worker's watches read.
	const handle = createStageControlHandle({
		runId: "run-1",
		stageId: "stage-a",
		name: "stage-a",
		stageSnapshot: { status: "running" },
		state: { liveHandleReleased: false, resumeContinuationPending: false },
		activeStore: { recordStagePaused: () => false },
		innerCtx: ctx,
		throwIfStageMutationBlocked() {},
		captureStageSessionMeta() {},
	} as never);
	// The chat host a stage chat draws, fed by the stage's own subscription, as the stage chat feeds it.
	const chat = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	const unsubscribe = ctx.subscribe((event) => chat.applyAgentEvent(event as AgentSessionEvent));
	return {
		ctx,
		handle,
		fallbackStreaming: fallbackStreaming.promise,
		fallbackCreating: fallbackCreating.promise,
		primaryWaiting: primaryWaiting.promise,
		primaryRetiring: primaryRetiring.promise,
		status: () =>
			chat
				.renderWorkingStatus(100)
				.map((line) => stripVTControlCharacters(line).trimEnd())
				.filter((line) => line.length > 0),
		async dispose() {
			unsubscribe();
			chat.dispose();
			await ctx.__dispose();
		},
	};
}

describe("a stage chat's working line across the stage's own model fallback (#5535)", () => {
	test("the turn on the fallback model counts from the turn's start (#5535)", async () => {
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200 });
		try {
			assert.equal(await stage.ctx.prompt("Fix the picker"), "Fixed the picker.");
			const status = stage.status();
			assert.ok(
				status.some((line) => / for 6s/.test(line)),
				`the finished turn counts from the primary's request: ${status.join(" | ")}`,
			);
		} finally {
			await stage.dispose();
		}
	});

	test("a switch that never reaches its request ends the turn's count, and the next prompt counts on its own (#5535)", async () => {
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 2_000, fallbackUnavailable: true });
		try {
			await assert.rejects(stage.ctx.prompt("Fix the picker"));
			const ended = stage.status();
			assert.ok(
				ended.some((line) => / for 6s/.test(line)) && !ended.some((line) => line.includes("Switching model")),
				`the turn ends where its switch failed: ${ended.join(" | ")}`,
			);
			now = 60_000;
			assert.equal(await stage.ctx.prompt("Try again"), "Fixed the picker.");
			const next = stage.status();
			assert.ok(
				next.some((line) => / for 2s/.test(line)),
				`the next prompt counts from its own start: ${next.join(" | ")}`,
			);
		} finally {
			await stage.dispose();
		}
	});
});

const plain = (lines: readonly string[]): string[] => lines.map((line) => stripVTControlCharacters(line).trimEnd());

/** The rows of a stage chat opened now on `handle`. */
function openedStageChat(handle: StageControlHandle): string[] {
	const view = openStageChat(handle);
	try {
		return view.rows();
	} finally {
		view.dispose();
	}
}

function openStageChat(handle: StageControlHandle) {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(30),
	});
	return {
		rows: () => plain(view.render(100)),
		pressEscape: () => view.handleInput("\x1b"),
		dispose: () => view.dispose(),
	};
}

const ATTEMPT = { workId: "work", generation: 1 };

/** The root's handle of the stage, run by a local worker that holds `handle`, over the worker's real watches. */
async function workerStageHandle(handle: StageControlHandle) {
	const registry = createStageControlRegistry();
	registry.register(handle);
	const replies = new Map<number, (snapshot: unknown) => void>();
	let listener: ((message: PooledStageWatchMessage) => void) | undefined;
	let commandIds = 0;
	const watches = new WorkerStageWatches(
		registry,
		() => ATTEMPT,
		(message) => {
			const sent = message as WorkerRequest;
			if (sent.kind === "stage-command-result") replies.get(sent.commandId)?.(sent.snapshot);
			else if (sent.kind === "stage-events") listener?.({ kind: "events", events: sent.events });
			else if (sent.kind === "stage-watch-ended") listener?.({ kind: "ended", reason: sent.reason });
		},
	);
	const transport: PooledStageTransport = {
		async watch(ref, onMessage) {
			listener = onMessage;
			const commandId = ++commandIds;
			const opened = new Promise<unknown>((resolve) => replies.set(commandId, resolve));
			watches.serve({
				kind: "stage-command",
				commandId,
				attempt: ATTEMPT,
				op: "watch",
				watch: "watch-1" as WatchId,
				runId: ref.runId,
				stageId: ref.stageId,
			});
			const snapshot = (await opened) as Parameters<typeof assert.ok>[0];
			assert.ok(snapshot, "the worker opens the watch");
			return { ok: true, watch: { id: "watch-1" as WatchId, attempt: ATTEMPT, snapshot: snapshot as never } };
		},
		async unwatch(watch) {
			watches.serve({ kind: "stage-command", commandId: ++commandIds, attempt: ATTEMPT, op: "unwatch", watch });
		},
		async deliver() {
			return { ok: false, refusal: "StageNotLive" };
		},
		async pause() {
			await handle.pause();
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	const opened = await openPooledStageHandle(transport, { runId: "run-1", stageId: "stage-a" }, "stage-a");
	assert.ok(opened.ok);
	return { handle: opened.handle, close: () => watches.clear() };
}

describe("a stage chat opened after the stage moved its turn to the fallback model (#5535)", () => {
	const turnOnFallback = /\(8s[ )]/;

	test("in this process, the chat counts from the turn's first request (#5535)", async () => {
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200, holdFallback: release.promise });
		const turn = stage.ctx.prompt("Fix the picker");
		try {
			await stage.fallbackStreaming;
			now += 2_000;
			const rows = openedStageChat(stage.handle);
			assert.ok(
				rows.some((row) => turnOnFallback.test(row)),
				`the fallback model's request counts from the turn's start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			release.resolve();
			await turn;
			await stage.dispose();
		}
	});

	test.each(["local", "worker"])(
		"a %s stage chat opened during the failed model's shutdown can cancel the switch (#5564)",
		async (host) => {
			const release = Promise.withResolvers<void>();
			const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200, holdPrimaryShutdown: release.promise });
			const events: string[] = [];
			const unsubscribe = stage.ctx.subscribe((event) => events.push(event.type));
			const turn = stage.ctx.prompt("Fix the picker");
			let worker: Awaited<ReturnType<typeof workerStageHandle>> | undefined;
			let chat: ReturnType<typeof openStageChat> | undefined;
			try {
				await stage.primaryRetiring;
				if (host === "worker") worker = await workerStageHandle(stage.handle);
				chat = openStageChat(worker?.handle ?? stage.handle);
				const rows = chat.rows().join("\n");
				assert.match(rows, /Switching model/);
				assert.match(rows, /esc interrupt/);
				chat.pressEscape();
				await sleep(0);
				assert.equal(stage.ctx.__isPaused(), true);
				await stage.ctx.__resume();
				release.resolve();
				await turn;
				assert.deepEqual(
					events.filter((type) => ["agent_start", "model_fallback_start", "model_fallback_end"].includes(type)),
					["agent_start", "model_fallback_start", "model_fallback_end"],
				);
			} finally {
				release.resolve();
				if (stage.ctx.__isPaused()) await stage.ctx.__resume();
				await turn.catch(() => undefined);
				chat?.dispose();
				worker?.handle.dispose();
				worker?.close();
				unsubscribe();
				await stage.dispose();
			}
		},
	);

	test("a chat opened while the stage switches models shows the switch, and the turn counts from its start (#5535)", async () => {
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200, holdFallbackSession: release.promise });
		const turn = stage.ctx.prompt("Fix the picker");
		let chat: ReturnType<typeof openStageChat> | undefined;
		try {
			await stage.fallbackCreating;
			now += 1_000;
			chat = openStageChat(stage.handle);
			const switching = chat.rows();
			assert.ok(
				switching.some((row) => row.includes("Switching model")),
				`the chat shows the switch: ${switching.filter((row) => row.includes("∀") || row.includes("switching")).join(" | ")}`,
			);
			release.resolve();
			assert.equal(await turn, "Fixed the picker.");
			const done = chat.rows();
			assert.ok(
				done.some((row) => / for 7s/.test(row)),
				`the finished turn counts from its start: ${done.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			release.resolve();
			await turn.catch(() => undefined);
			chat?.dispose();
			await stage.dispose();
		}
	});

	test("a pause while the stage switches models ends the turn's count there, and the resumed request counts on its own (#5535)", async () => {
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 2_000, holdFallbackSession: release.promise });
		const turn = stage.ctx.prompt("Fix the picker");
		let chat: ReturnType<typeof openStageChat> | undefined;
		try {
			await stage.fallbackCreating;
			chat = openStageChat(stage.handle);
			now += 1_000;
			const paused = stage.ctx.__requestPause();
			const stopped = chat.rows();
			assert.ok(
				stopped.some((row) => / for 7s/.test(row)) && !stopped.some((row) => row.includes("Switching model")),
				`the turn ends at the pause: ${stopped.filter((row) => row.includes("∀")).join(" | ")}`,
			);
			release.resolve();
			await paused;
			now = 60_000;
			await stage.ctx.__resume("Carry on");
			assert.equal(await turn, "Fixed the picker.");
			const resumed = chat.rows();
			assert.ok(
				resumed.some((row) => / for 2s/.test(row)),
				`the resumed request counts on its own: ${resumed.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			release.resolve();
			await turn.catch(() => undefined);
			chat?.dispose();
			await stage.dispose();
		}
	});

	test("a turn whose retries ran out before the stage moved it to its next model counts from its start (#5535)", async () => {
		const retry = Promise.withResolvers<void>();
		const stage = stageWithFallback({ primaryMs: 3_000, fallbackMs: 200, primaryRetryWait: retry.promise });
		const chat = openStageChat(stage.handle);
		const turn = stage.ctx.prompt("Fix the picker");
		try {
			await stage.primaryWaiting;
			now += 1_000;
			retry.resolve();
			assert.equal(await turn, "Fixed the picker.");
			// 3 s on the first request, 1 s of wait, 3 s on the retry, 0.2 s on the fallback.
			const rows = chat.rows();
			assert.ok(
				rows.some((row) => / for 7s/.test(row)),
				`the finished turn counts from its start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			retry.resolve();
			await turn.catch(() => undefined);
			chat.dispose();
			await stage.dispose();
		}
	});

	test("on a local worker, a watch opened after the switch carries the turn's start (#5535)", async () => {
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200, holdFallback: release.promise });
		const turn = stage.ctx.prompt("Fix the picker");
		try {
			await stage.fallbackStreaming;
			now += 2_000;
			const worker = await workerStageHandle(stage.handle);
			try {
				const rows = openedStageChat(worker.handle);
				assert.ok(
					rows.some((row) => turnOnFallback.test(row)),
					`the fallback model's request counts from the turn's start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
				);
			} finally {
				worker.handle.dispose();
				worker.close();
			}
		} finally {
			release.resolve();
			await turn;
			await stage.dispose();
		}
	});

	test("on a local worker, a watch opened while the turn waits to retry keeps the turn's start through the switch (#5535)", async () => {
		const retry = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({
			primaryMs: 3_000,
			fallbackMs: 200,
			holdFallback: release.promise,
			primaryRetryWait: retry.promise,
		});
		const turn = stage.ctx.prompt("Fix the picker");
		let worker: Awaited<ReturnType<typeof workerStageHandle>> | undefined;
		try {
			await stage.primaryWaiting;
			worker = await workerStageHandle(stage.handle);
			now += 1_000;
			retry.resolve();
			await stage.fallbackStreaming;
			await sleep(120);
			now += 1_400;
			// The turn started at 1 s: 3 s on the first request, 1 s of wait, 3 s on the retry, 1.4 s on the fallback.
			const rows = openedStageChat(worker.handle);
			assert.ok(
				rows.some((row) => /\(8s[ )]/.test(row)),
				`the fallback model's request counts from the turn's start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			worker?.handle.dispose();
			worker?.close();
			retry.resolve();
			release.resolve();
			await turn.catch(() => undefined);
			await stage.dispose();
		}
	});

	test("on a local worker, a watch opened after a failed request, before the stage moves to its next model, keeps the turn's start (#5535)", async () => {
		// The worker's stage: its first request, sent at 1 s, failed, and the stage has not yet announced its next model.
		const { handle, state, emit } = makeHandle(undefined, [], "running", fakeFooterAgentSession(false));
		state.isStreaming = false;
		const turn = new StageTurnStart();
		turn.record({ type: "agent_start" } as AgentSessionEvent, 1_000);
		turn.record({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "404 model not found" },
		} as unknown as AgentSessionEvent);
		turn.record({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		Object.assign(handle, { turnState: () => turn.state() });
		now = 7_000;
		const worker = await workerStageHandle(handle);
		try {
			emit({
				type: "model_fallback_start",
				from: PRIMARY,
				to: FALLBACK,
				reason: "404 model not found",
				attempt: 1,
			} as AgentSessionEvent);
			await sleep(120);
			const switching = openedStageChat(worker.handle);
			assert.ok(
				switching.some((row) => row.includes("Switching model")),
				`the chat shows the switch: ${switching.filter((row) => row.includes("∀")).join(" | ")}`,
			);
			assert.equal(worker.handle.turnStartedAt, 1_000);
		} finally {
			worker.handle.dispose();
			worker.close();
		}
	});

	test("on a local worker, a watch open since before the turn reads the turn's start from its events (#5535)", async () => {
		const release = Promise.withResolvers<void>();
		const stage = stageWithFallback({
			primaryMs: 6_400,
			fallbackMs: 200,
			holdFallback: release.promise,
			settleStartMs: 120,
		});
		const worker = await workerStageHandle(stage.handle);
		const turn = stage.ctx.prompt("Fix the picker");
		try {
			await stage.fallbackStreaming;
			await sleep(120);
			now += 2_000;
			const rows = openedStageChat(worker.handle);
			assert.ok(
				rows.some((row) => turnOnFallback.test(row)),
				`the fallback model's request counts from the turn's start: ${rows.filter((row) => row.includes("∀")).join(" | ")}`,
			);
		} finally {
			worker.handle.dispose();
			worker.close();
			release.resolve();
			await turn;
			await stage.dispose();
		}
	});
});
