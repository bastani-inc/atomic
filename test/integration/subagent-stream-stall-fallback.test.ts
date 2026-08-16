import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "../../packages/coding-agent/test/model-runtime-test-utils.ts";

// ---------------------------------------------------------------------------
// Issue #2446 — end-to-end wiring of the content-progress liveness guard.
//
// The unit suite (`test/unit/stream-liveness-guard.test.ts`) proves the guard
// in isolation with an injected clock: a whitespace flood and a silent hang
// both throw the retryable terminalless error, progress resets the window,
// abort outranks the stall, and the error normalizes to a fallbackable
// `provider_unavailable`. The fallback state machine that *consumes* that error
// is proven end-to-end against its real implementations in
// `test/unit/main-chat-model-fallback.test.ts` (a fallbackable error advances
// same-model retry and then the configured `fallbackModels`).
//
// What neither of those can prove is the seam between them: that a positive
// `streamStallMs` actually reaches the guard through the *real*
// `createAgentSession` streamFn factory, that the guarded stream trips when the
// agent loop iterates it, and that an abort during a stall surfaces as the abort
// message (which pi-agent-core stamps `stopReason:"aborted"` → cancelled → no
// fallback) rather than the fallbackable stall message. That seam is what these
// tests exercise, driving the real factory via `session.agent.streamFunction`
// (the same value the agent loop, compaction, summary, and tree loops consume as
// their `streamFn`). We do not stand up a live two-provider `prompt()`: the
// fallback advance it would re-observe is already covered above, and a real turn
// on a fake completing model would add flakiness without new coverage.
// ---------------------------------------------------------------------------

const PROVIDER = "capture-provider";
const API: Api = "openai-completions";

// A stalled turn: iteration blocks on a single pull that never resolves on its
// own — the #2446 shape where `message_end` is never observed and the child
// stays pending. The real factory wraps this leaf source in pi-ai's `lazyStream`
// (a fresh `outer` stream fed by an independent `forwardStream` pull loop), so
// the guard's immediate source is that `outer`, never this instance — the guard
// releasing its immediate source once is proven in the unit suite, where the
// scripted source *is* the immediate source. `unblock()` releases the pending
// pull so `lazyStream`'s forwarder settles cleanly on teardown.
class ControllableStallStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private settle?: (result: IteratorResult<AssistantMessageEvent>) => void;
	private readonly gate: Promise<IteratorResult<AssistantMessageEvent>>;

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
		this.gate = new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
			this.settle = resolve;
		});
	}

	/** Release a still-pending pull so lazyStream's forwarder settles on cleanup. */
	unblock(): void {
		this.settle?.({ value: undefined, done: true });
	}

	// The terminal result only resolves once a terminal event is delivered; this
	// stream never delivers one, so `result()` never settles — matching a hung
	// turn. The guarded iterator throws before the agent loop's post-loop
	// `await response.result()`, so this is never awaited on the failure path.
	override result(): Promise<AssistantMessage> {
		return new Promise<AssistantMessage>(() => {});
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: (): Promise<IteratorResult<AssistantMessageEvent>> => this.gate,
		};
	}
}

describe("subagent stream-stall recovery is wired through the real factory", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-stream-stall-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createModel(): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api: API,
			provider: PROVIDER,
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	// Build a real agent session whose sole provider returns a stalled stream, so
	// the guard is the only thing that can end the turn. The return type is
	// inferred so the test never has to name pi-agent-core's `Agent`/`streamFunction`
	// shapes — it drives the same `session.agent.streamFunction` the real loops use.
	async function createGuardedSession(streamStallMs: number) {
		const model = createModel();
		const source = new ControllableStallStream();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: API,
			streamSimple: () => source,
		});
		const modelRuntime = getModelRuntime(modelRegistry);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(cwd),
			streamStallMs,
		});
		return {
			model,
			session,
			dispose: () => {
				source.unblock();
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	test("a stalled provider stream ends with a fallbackable failure the classifier advances on", async () => {
		// 50 ms is comfortably above timer granularity; the guard's own setTimeout
		// fires and the loop re-check throws once the no-progress window is exceeded.
		const { model, session, dispose } = await createGuardedSession(50);
		try {
			const stream = await session.agent.streamFunction(model, { messages: [] });
			let captured: unknown;
			try {
				// A real agent loop iterates the stream just like this; a genuine #2446
				// turn would flood here forever, so reaching the catch is the recovery.
				for await (const _event of stream) {
					// no-op: the stalled stream yields nothing before it throws
				}
			} catch (error) {
				captured = error;
			}
			assert.ok(captured instanceof Error, "the guarded stream must throw, not hang");
			assert.match(captured.message, /stream ended before a terminal response event/);
			// The exact classifier the agent loop consults: a stall is same-model
			// retryable AND fallbackable, so same-model retry and configured
			// `fallbackModels` advance inside the same `prompt()` call.
			assert.equal(isRetryableModelFailure(captured), true);
			assert.equal(isRetryableSameModelFailure(captured), true);
			assert.equal(normalizeModelFailureSignal(captured).kind, "provider_unavailable");
		} finally {
			dispose();
		}
	});

	test("an abort during a stall surfaces as an abort, not a fallbackable failure", async () => {
		// A window far past the test so the stall timer never fires: the abort is
		// the only thing that can end the turn, isolating the abort ranking.
		const { model, session, dispose } = await createGuardedSession(60_000);
		const controller = new AbortController();
		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, { signal: controller.signal });
			let captured: unknown;
			const iteration = (async () => {
				try {
					for await (const _event of stream) {
						// no-op
					}
				} catch (error) {
					captured = error;
				}
			})();
			// The abort listener is armed synchronously by the first pull above, so
			// aborting now resolves the abort race deterministically.
			controller.abort();
			await iteration;
			assert.ok(captured instanceof Error, "an aborted stream must throw");
			// The abort message is what makes pi-agent-core stamp stopReason
			// "aborted" → cancelled → no fallback; classification is by
			// `signal.aborted` at catch time, never by the guard.
			assert.match(captured.message, /stream consumption aborted/);
			assert.doesNotMatch(captured.message, /stream ended before a terminal response event/);
		} finally {
			dispose();
		}
	});
});
