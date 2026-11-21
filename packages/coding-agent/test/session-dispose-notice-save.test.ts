import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream } from "@bastani/atomic-ai";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SESSION_WORK_DRAIN_MS, SessionWorkUnsettledError } from "../src/core/session-lifecycle-work.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ChatRecord, SessionChatRecords } from "../src/core/storage/session/chat-records.ts";
import { createHarness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.ts";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;
/**
 * Event-loop turns given to disposal before its bound passes. Every shutdown step before the wait for display records
 * settles without file access here, so this only lets the I/O of a later step finish in a revision that does not wait.
 */
const UNTIL_WAITING_TURNS = 1_000;

const folders: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function sessionFolder(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	folders.push(dir);
	return dir;
}

/**
 * The display records `manager` saves (notice lines and prompt-order records), each reaching the store only once
 * `hold(record)` settles.
 */
function gateDisplayRecordSaves(manager: SessionManager, hold: (record: ChatRecord) => Promise<void>) {
	const saves: Promise<void>[] = [];
	const kinds: ChatRecord["kind"][] = [];
	let unsettled = 0;
	const gated = new WeakMap<SessionChatRecords, SessionChatRecords>();
	const scope = manager.chatRecordScope.bind(manager);
	manager.chatRecordScope = () => {
		const real = scope();
		if (!real) return real;
		// The same store object each time: the session compares stores to keep a record with the branch it belongs to.
		let store = gated.get(real.store);
		if (!store) {
			store = {
				...real.store,
				append: (owner, anchor, record) => {
					kinds.push(record.kind);
					unsettled++;
					const saved = hold(record)
						.then(() => real.store.append(owner, anchor, record))
						.finally(() => {
							unsettled--;
						});
					saves.push(saved.catch(() => {}));
					return saved;
				},
			};
			gated.set(real.store, store);
		}
		return { ...real, store };
	};
	return { kinds, unsettled: () => unsettled, settled: () => Promise.all(saves) };
}

function rateLimited(model: { api: string; provider: string; id: string }) {
	const stream = new AssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		errorMessage: "429 rate limit exceeded",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}

/**
 * A session the caller gave its own session store, stopped while it waits to retry a rate-limited request: stopping it
 * saves the "Retry failed" notice line, which no turn waits for.
 */
async function stoppedDuringRetry(hold: () => Promise<void>) {
	const dir = sessionFolder("atomic-notice-save-");
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ primary: { type: "api_key", key: "fabricated" } }),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerProvider("primary", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "fabricated",
		models: [
			{
				id: "m",
				name: "m",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1000,
			},
		],
		streamSimple: (model) => rateLimited(model),
	});
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const saves = gateDisplayRecordSaves(manager, hold);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: runtime,
		model: runtime.getModel("primary", "m")!,
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000, maxAgentDelayMs: 600_000 },
			compaction: { enabled: false },
		}),
		sessionManager: manager,
		resourceLoader: createTestResourceLoader(),
		builtins: NO_BUILTINS,
	});
	const retrying = new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "auto_retry_start") return;
			unsubscribe();
			resolve();
		});
	});
	const prompt = session.prompt("go");
	await retrying;
	await session.abort();
	await prompt;
	assert.deepEqual(saves.kinds, ["line"], "stopping the retry saves its notice line");
	return { dir, manager, session, saves };
}

/** Disposes `session` with its shutdown bound on a fake clock, passes the bound, and returns how disposal ended. */
async function disposeAcrossTheBound(session: AgentSession): Promise<unknown> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const outcome = session.dispose().then(
			() => undefined,
			(error: unknown) => error,
		);
		for (let turn = 0; turn < UNTIL_WAITING_TURNS; turn++) await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(SESSION_WORK_DRAIN_MS);
		vi.useRealTimers();
		return await outcome;
	} finally {
		vi.useRealTimers();
	}
}

function unsettledStep(error: unknown): string | undefined {
	assert.ok(
		error instanceof AggregateError,
		`disposal resolved while a display record was still being saved: ${error}`,
	);
	assert.equal((error as AggregateError & { code?: string }).code, "ShutdownFailed");
	return error.errors
		.map((entry: Error) => entry.cause)
		.find((cause): cause is SessionWorkUnsettledError => cause instanceof SessionWorkUnsettledError)?.step;
}

test("closing a session waits for a notice line it is still saving, and names it once the shutdown bound passes (#6128)", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stopped = await stoppedDuringRetry(() => held);
	try {
		const error = await disposeAcrossTheBound(stopped.session);
		assert.equal(unsettledStep(error), "notice lines");
		assert.equal(stopped.saves.unsettled(), 1);
	} finally {
		release();
		await stopped.saves.settled();
	}
});

test("once dispose resolves, the notice line it saved is in the store and nothing writes to the session's folder (#6128)", async () => {
	let disposing!: () => void;
	const disposeCalled = new Promise<void>((resolve) => {
		disposing = resolve;
	});
	// The save reaches the store as dispose starts, as when the session is closed right after the stop.
	const stopped = await stoppedDuringRetry(() => disposeCalled);
	const disposed = stopped.session.dispose();
	disposing();
	await disposed;
	assert.equal(stopped.saves.unsettled(), 0, "dispose resolved while its notice line was still being saved");
	const scope = stopped.manager.chatRecordScope();
	assert.ok(scope);
	assert.equal(await scope.store.has(scope.owner), true);
	// The removal the test cleanup does: a save still running would recreate files under `sessions` while it runs.
	rmSync(stopped.dir, { recursive: true });
	assert.equal(existsSync(stopped.dir), false);
});

test("closing a session waits for the order record of a notice shown before its prompt was saved (#6128)", async () => {
	const dir = sessionFolder("atomic-notice-order-");
	const manager = await SessionManager.create(dir, join(dir, "sessions"));
	const harness = await createHarness({ sessionManager: manager, cwd: dir });
	harness.setResponses([fauxAssistantMessage("done")]);
	const promptSave = Promise.withResolvers<void>();
	const promptHeld = Promise.withResolvers<void>();
	const append = manager.appendMessage.bind(manager);
	manager.appendMessage = (async (...args: Parameters<typeof append>) => {
		if (args[0].role === "user") {
			promptSave.resolve();
			await promptHeld.promise;
		}
		return append(...args);
	}) as typeof manager.appendMessage;
	const orderHeld = Promise.withResolvers<void>();
	const saves = gateDisplayRecordSaves(manager, async (record) => {
		if (record.kind === "promptBefore") await orderHeld.promise;
	});
	try {
		const prompt = harness.session.prompt("go");
		await promptSave.promise;
		// A notice saved while the prompt's own save waits is shown before it; its order is kept as a display record.
		await harness.session.sendCustomMessage(
			{ customType: "notice", content: "shown before the prompt was saved", display: true },
			{ excludeFromContext: true },
		);
		promptHeld.resolve();
		await prompt;
		assert.deepEqual(saves.kinds, ["promptBefore"]);

		const error = await disposeAcrossTheBound(harness.session);
		assert.equal(unsettledStep(error), "notice lines");
		assert.equal(saves.unsettled(), 1);
	} finally {
		promptHeld.resolve();
		orderHeld.resolve();
		await saves.settled();
		await harness.cleanup().catch(() => {});
	}
});
